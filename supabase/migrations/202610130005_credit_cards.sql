-- Owner-private card billing. Statement snapshots never post expenses.
create table public.credit_cards(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 account_id uuid not null unique, title text not null check(length(trim(title)) between 1 and 200),last_four text not null default '' check(last_four='' or last_four ~ '^[0-9]{4}$'),
 closing_day integer not null check(closing_day between 1 and 31),due_day integer not null check(due_day between 1 and 31),credit_limit numeric(14,2) not null check(credit_limit>=0),notes text not null default '' check(length(notes)<=2000),reminders_enabled boolean not null default false,archived boolean not null default false,revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),foreign key(workspace_id,account_id) references public.accounts(workspace_id,id)
);
create table public.card_statements(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),card_id uuid not null,
 cycle_end date not null check(cycle_end between '1900-01-01' and '2100-12-31'),due_on date not null check(due_on>cycle_end and due_on<='2100-12-31'),amount numeric(14,2) not null check(amount>=0),minimum_due numeric(14,2) not null check(minimum_due>=0 and minimum_due<=amount),notes text not null default '' check(length(notes)<=2000),status text not null default 'open' check(status in ('open','superseded','cancelled')),revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),foreign key(workspace_id,card_id) references public.credit_cards(workspace_id,id)
);
create unique index one_open_card_statement on public.card_statements(card_id) where status='open';
create unique index unique_card_cycle on public.card_statements(card_id,cycle_end) where status<>'cancelled';
create table public.card_payments(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),statement_id uuid not null,card_id uuid not null,source_account_id uuid not null,amount numeric(14,2) not null check(amount>0),booked_on date not null,notes text not null default '' check(length(notes)<=2000),voided boolean not null default false,reversal_id uuid unique,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(workspace_id,card_id) references public.credit_cards(workspace_id,id),foreign key(workspace_id,statement_id) references public.card_statements(workspace_id,id),foreign key(workspace_id,source_account_id) references public.accounts(workspace_id,id),check(voided=(reversal_id is not null))
);
create index card_payments_after_close on public.card_payments(card_id,booked_on) where not voided;
-- Card payments must use the allocation-aware RPC, not generic transfers.
alter function public.transfer_funds(uuid,uuid,uuid,numeric,uuid) set schema private;
alter function private.transfer_funds(uuid,uuid,uuid,numeric,uuid) rename to non_card_transfer;
revoke all on function private.non_card_transfer(uuid,uuid,uuid,numeric,uuid) from public,anon,authenticated;
create function public.transfer_funds(w uuid,source_account uuid,destination_account uuid,transfer_amount numeric,request_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.credit_cards where account_id in(source_account,destination_account)) then raise exception 'Use Credit cards to record statement payments';end if;
 perform private.non_card_transfer(w,source_account,destination_account,transfer_amount,request_id);
end $$;
revoke all on function public.transfer_funds(uuid,uuid,uuid,numeric,uuid) from public,anon,authenticated;
grant execute on function public.transfer_funds(uuid,uuid,uuid,numeric,uuid) to authenticated;
do $$ declare t text;begin foreach t in array array['credit_cards','card_statements','card_payments'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);execute format('create policy own_card_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
 execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;end $$;
create function private.card_parent(entry uuid,w uuid) returns public.credit_cards language plpgsql security definer set search_path='' as $$
declare r public.credit_cards;begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,28));select * into r from public.credit_cards where id=entry for update;
 if r.id is null or r.owner_id is distinct from auth.uid() or r.workspace_id<>w then raise exception 'Card is inaccessible';end if;return r;
end $$;
create function private.card_balance(account uuid) returns numeric language sql stable security definer set search_path='' as $$
 select a.opening_balance+coalesce((select sum(case when t.kind in ('income','transfer_in') then t.amount else -t.amount end) from public.transactions t where t.account_id=a.id),0) from public.accounts a where a.id=account;
$$;
-- Serialize ledger inserts with balance checks, including existing posting RPCs.
create function private.lock_ledger_account() returns trigger language plpgsql security definer set search_path='' as $$
begin perform 1 from public.accounts where id=new.account_id for update; if exists(select 1 from public.credit_cards where account_id=new.account_id and archived) then raise exception 'Restore card before recording ledger entries';end if; return new;end $$;
create trigger lock_ledger_account before insert on public.transactions for each row execute function private.lock_ledger_account();
create function public.save_credit_card(entry uuid,w uuid,expected_revision integer,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.credit_cards;v public.credit_cards;account uuid;opening numeric;lim numeric;cur text;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,28));select * into r from public.credit_cards where id=entry for update;
 if found then
  if r.owner_id is distinct from auth.uid() or r.workspace_id<>w then raise exception 'Card is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Card changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Card is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid card';end if;
 lim:=(details->>'credit_limit')::numeric;opening:=(details->>'opening_debt')::numeric;cur:=details->>'currency';select * into v from jsonb_populate_record(null::public.credit_cards,details);
 if v.title is null or length(trim(v.title)) not between 1 and 200 or v.last_four is null or (v.last_four<>'' and v.last_four !~ '^[0-9]{4}$') or v.closing_day is null or v.closing_day not between 1 and 31 or v.due_day is null or v.due_day not between 1 and 31 or v.notes is null or length(v.notes)>2000 or v.reminders_enabled is null or lim is null or lim::text in ('NaN','Infinity','-Infinity') or lim<0 or lim>=1000000000000 or lim<>round(lim,2) then raise exception 'Check card name, last four digits, billing days and limit';end if;
 if r.id is null then
  if cur is null or cur !~ '^[A-Z]{3}$' or opening is null or opening::text in ('NaN','Infinity','-Infinity') or opening<0 or opening>=1000000000000 or opening<>round(opening,2) then raise exception 'Check currency and opening debt';end if;
  insert into public.accounts(workspace_id,owner_id,name,currency,opening_balance)values(w,auth.uid(),trim(v.title),cur,-opening) returning id into account;
  insert into public.credit_cards(id,workspace_id,owner_id,account_id,title,last_four,closing_day,due_day,credit_limit,notes,reminders_enabled)values(entry,w,auth.uid(),account,trim(v.title),v.last_four,v.closing_day,v.due_day,lim,v.notes,v.reminders_enabled);
 else
  update public.credit_cards set title=trim(v.title),last_four=v.last_four,closing_day=v.closing_day,due_day=v.due_day,credit_limit=lim,notes=v.notes,reminders_enabled=v.reminders_enabled,revision=revision+1 where id=entry;
  update public.accounts set name=trim(v.title) where id=r.account_id;
 end if;return entry;
end $$;
create function public.save_card_statement(entry uuid,w uuid,expected_revision integer,parent uuid,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare c public.credit_cards;r public.card_statements;v public.card_statements;total numeric;minimum numeric;paid numeric;
begin
 c:=private.card_parent(parent,w);if c.archived or entry is null then raise exception 'Restore card first';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,29));select * into r from public.card_statements where id=entry for update;
 if found then
  if r.card_id<>parent or r.owner_id is distinct from auth.uid() or r.workspace_id<>w then raise exception 'Statement is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.status<>'open' then raise exception 'Statement changed; refresh';end if;
 elsif expected_revision is not null then raise exception 'Statement is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid statement';end if;
 total:=(details->>'amount')::numeric;minimum:=(details->>'minimum_due')::numeric;select * into v from jsonb_populate_record(null::public.card_statements,details);
 if total is null or minimum is null or total::text in ('NaN','Infinity','-Infinity') or minimum::text in ('NaN','Infinity','-Infinity') or total<0 or total>=1000000000000 or total<>round(total,2) or minimum<0 or minimum>total or minimum<>round(minimum,2) or v.cycle_end is null or v.cycle_end not between '1900-01-01' and private.finance_today(auth.uid()) or v.due_on is null or v.due_on<=v.cycle_end or v.due_on>'2100-12-31' or v.notes is null or length(v.notes)>2000 then raise exception 'Check statement total, minimum, dates and notes';end if;
 if r.id is null then
  if exists(select 1 from public.card_statements where card_id=parent and status<>'cancelled' and cycle_end>=v.cycle_end) then raise exception 'New statement must follow the latest billing cycle';end if;
  update public.card_statements set status='superseded',revision=revision+1 where card_id=parent and status='open';
  insert into public.card_statements(id,workspace_id,owner_id,card_id,cycle_end,due_on,amount,minimum_due,notes)values(entry,w,auth.uid(),parent,v.cycle_end,v.due_on,total,minimum,v.notes);
 else
  if v.cycle_end<>r.cycle_end then raise exception 'Statement cycle cannot change';end if;
  select coalesce(sum(amount),0)into paid from public.card_payments where card_id=parent and booked_on>r.cycle_end and not voided;
  if total<paid then raise exception 'Statement total is below recorded payments';end if;
  update public.card_statements set due_on=v.due_on,amount=total,minimum_due=minimum,notes=v.notes,revision=revision+1 where id=entry;
 end if;return entry;
end $$;
create function public.record_card_payment(entry uuid,w uuid,statement uuid,source uuid,payment_amount numeric,payment_date date,payment_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.card_statements;c public.credit_cards;p public.card_payments;a public.accounts;paid numeric;
begin
 select * into s from public.card_statements where id=statement;c:=private.card_parent(s.card_id,w);
 perform pg_advisory_xact_lock(hashtextextended(entry::text,0));select * into p from public.card_payments where id=entry;
 if found then
  if p.owner_id is distinct from auth.uid() or p.workspace_id<>w or p.statement_id is distinct from statement or p.source_account_id is distinct from source or p.amount is distinct from payment_amount or p.booked_on is distinct from payment_date or p.notes is distinct from payment_notes then raise exception 'Payment request reused';end if;return entry;
 end if;
 select * into s from public.card_statements where id=statement for update;
 if c.archived or s.status<>'open' then raise exception 'Only the current statement can be paid';end if;
 if entry is null or payment_amount is null or payment_amount::text in ('NaN','Infinity','-Infinity') or payment_amount<=0 or payment_amount>=1000000000000 or payment_amount<>round(payment_amount,2) or payment_date is null or payment_date<=s.cycle_end or payment_date>private.finance_today(auth.uid()) or payment_notes is null or length(payment_notes)>2000 then raise exception 'Check payment amount, date and notes';end if;
 perform 1 from public.accounts where id in(source,c.account_id) order by id for update;
 select * into a from public.accounts where id=source and workspace_id=w and owner_id=auth.uid();
 if a.id is null or a.currency<>(select currency from public.accounts where id=c.account_id) or exists(select 1 from public.credit_cards where account_id=source) then raise exception 'Choose your own bank account in the card currency';end if;
 select coalesce(sum(amount),0)into paid from public.card_payments where card_id=c.id and booked_on>s.cycle_end and not voided;
 if payment_amount>s.amount-paid then raise exception 'Payment exceeds statement remaining';end if;
 if payment_amount>greatest(0,-private.card_balance(c.account_id)) then raise exception 'Payment exceeds recorded card debt; record missing purchases or opening debt first';end if;
 if exists(select 1 from public.transactions where transfer_id=entry) then raise exception 'Transfer request reused';end if;
 insert into public.card_payments(id,workspace_id,owner_id,statement_id,card_id,source_account_id,amount,booked_on,notes)values(entry,w,auth.uid(),statement,c.id,source,payment_amount,payment_date,payment_notes);
 insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,transfer_id)values
 (w,auth.uid(),source,c.title||' · card payment',payment_amount,'transfer_out','Card payment',payment_date,entry),
 (w,auth.uid(),c.account_id,c.title||' · card payment',payment_amount,'transfer_in','Card payment',payment_date,entry);
 update public.card_statements set revision=revision+1 where id=statement;return entry;
end $$;
create function public.void_card_payment(entry uuid) returns void language plpgsql security definer set search_path='' as $$
declare p public.card_payments;s public.card_statements;c public.credit_cards;reversal uuid;
begin
 select * into p from public.card_payments where id=entry;select * into s from public.card_statements where id=p.statement_id;c:=private.card_parent(s.card_id,p.workspace_id);
 select * into p from public.card_payments where id=entry for update;if p.voided then return;end if;
 if s.status<>'open' or c.archived then raise exception 'Cancel the newer statement before correcting an older payment';end if;
 perform 1 from public.accounts where id in(p.source_account_id,c.account_id) order by id for update;reversal:=gen_random_uuid();
 insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,transfer_id)values
 (p.workspace_id,p.owner_id,p.source_account_id,c.title||' · payment reversal',p.amount,'transfer_in','Card payment reversal',private.finance_today(p.owner_id),reversal),
 (p.workspace_id,p.owner_id,c.account_id,c.title||' · payment reversal',p.amount,'transfer_out','Card payment reversal',private.finance_today(p.owner_id),reversal);
 update public.card_payments set voided=true,reversal_id=reversal where id=entry;update public.card_statements set revision=revision+1 where id=s.id;
end $$;
create function public.act_on_card_record(entry uuid,record_kind text,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$
declare c public.credit_cards;s public.card_statements;previous uuid;
begin
 if record_kind='card' and action in('archive','restore') then
  select * into c from public.credit_cards where id=entry;c:=private.card_parent(entry,c.workspace_id);
  if c.archived=(action='archive') then return;end if;
  if expected_revision is null or c.revision<>expected_revision then raise exception 'Card changed; refresh';end if;
  perform 1 from public.accounts where id=c.account_id for update;
  if action='archive' and (private.card_balance(c.account_id)<>0 or exists(select 1 from public.card_statements st where st.card_id=entry and st.status='open' and st.amount>coalesce((select sum(pay.amount)from public.card_payments pay where pay.card_id=st.card_id and pay.booked_on>st.cycle_end and not pay.voided),0))) then raise exception 'Clear card balance and statement before archiving';end if;
  update public.credit_cards set archived=(action='archive'),revision=revision+1 where id=entry;
 elsif record_kind='statement' and action='cancel' then
  select * into s from public.card_statements where id=entry;c:=private.card_parent(s.card_id,s.workspace_id);select * into s from public.card_statements where id=entry for update;
  if s.status='cancelled' then return;end if;
  if expected_revision is null or s.revision<>expected_revision or s.status<>'open' or c.archived then raise exception 'Statement changed; refresh';end if;
  if exists(select 1 from public.card_payments where statement_id=entry and not voided) then raise exception 'Void current statement payments before cancelling';end if;
  update public.card_statements set status='cancelled',revision=revision+1 where id=entry;
  select id into previous from public.card_statements where card_id=c.id and status='superseded' order by cycle_end desc limit 1;
  update public.card_statements set status='open',revision=revision+1 where id=previous;
 else raise exception 'Unknown card action';end if;
end $$;
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact','family_birthday','family_task','family_date','warranty','maintenance','career_follow_up','career_interview','certification','health_appointment','health_medication','card_statement'));
alter function private.reminder_sources() rename to pre_card_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text) language sql stable security definer set search_path='' as $$
 select * from private.pre_card_reminder_sources()
 union all select r.workspace_id,r.owner_id,'card_statement',r.id,'Credit card · '||c.title,r.due_on,s.bill_lead_days,s.reminder_hour,s.reminder_timezone
 from public.card_statements r join public.credit_cards c on c.id=r.card_id join public.app_settings s on s.id=r.owner_id join public.workspace_members m on m.workspace_id=r.workspace_id and m.user_id=r.owner_id
 where s.bill_reminders and c.reminders_enabled and not c.archived and r.status='open' and r.amount>coalesce((select sum(p.amount) from public.card_payments p where p.card_id=r.card_id and p.booked_on>r.cycle_end and not p.voided),0);
$$;
create function private.clear_card_notifications() returns trigger language plpgsql security definer set search_path='' as $$
begin update public.notifications n set dismissed_at=now(),snoozed_until=null where n.source_kind='card_statement' and n.dismissed_at is null and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on and s.workspace_id=n.workspace_id and s.owner_id=n.owner_id);return null;end $$;
create trigger clear_card_notifications after update on public.credit_cards for each statement execute function private.clear_card_notifications();
create trigger clear_card_notifications after update on public.card_statements for each statement execute function private.clear_card_notifications();
create trigger clear_card_notifications after update on public.app_settings for each statement execute function private.clear_card_notifications();
revoke all on function private.card_parent(uuid,uuid),private.card_balance(uuid),private.lock_ledger_account(),private.reminder_sources(),private.clear_card_notifications() from public,anon,authenticated;
revoke all on function public.save_credit_card(uuid,uuid,integer,jsonb),public.save_card_statement(uuid,uuid,integer,uuid,jsonb),public.record_card_payment(uuid,uuid,uuid,uuid,numeric,date,text),public.void_card_payment(uuid),public.act_on_card_record(uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.save_credit_card(uuid,uuid,integer,jsonb),public.save_card_statement(uuid,uuid,integer,uuid,jsonb),public.record_card_payment(uuid,uuid,uuid,uuid,numeric,date,text),public.void_card_payment(uuid),public.act_on_card_record(uuid,text,integer,text) to authenticated;

create or replace function public.deliver_due_reminders() returns integer
language plpgsql security definer set search_path='' as $$
declare total integer; automatic_count integer;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(120012,2) then return 0; end if;
  update public.notifications n set dismissed_at=now(),snoozed_until=null
    where n.source_kind is not null and n.dismissed_at is null and not exists(select 1 from private.reminder_sources() s
      where s.workspace_id=n.workspace_id and s.owner_id=n.owner_id and s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on);
  insert into public.notifications(workspace_id,owner_id,title,reminder_id)
    select r.workspace_id,r.owner_id,r.title,r.id from public.reminders r where r.due_at<=now() and r.delivered_at is null
    and exists(select 1 from public.workspace_members m where m.workspace_id=r.workspace_id and m.user_id=r.owner_id) on conflict(reminder_id) do nothing;
  get diagnostics total=row_count;
  update public.reminders r set delivered_at=now() where delivered_at is null and exists(select 1 from public.notifications n where n.reminder_id=r.id);
  insert into public.notifications(workspace_id,owner_id,title,source_kind,source_id,occurrence_on,phase)
    select s.workspace_id,s.owner_id,
    case s.source_kind when 'card_statement' then 'Credit-card statement' when 'health_medication' then 'Medication reminder' when 'health_appointment' then 'Health appointment' when 'career_follow_up' then 'Application follow-up' when 'career_interview' then 'Interview' when 'certification' then 'Certification' when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'family_birthday' then 'Birthday' when 'family_task' then 'Household task' when 'family_date' then 'Important date' when 'warranty' then 'Asset warranty' when 'maintenance' then 'Maintenance' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
    case when s.occurrence_on<clock.local_day then
      case s.source_kind when 'certification' then ' expired: ' when 'warranty' then ' expired: ' when 'document' then ' expired: ' when 'trial' then ' ended: ' when 'subscription' then ' renewal overdue: ' else ' overdue: ' end
    else case s.source_kind when 'certification' then ' expires ' when 'warranty' then ' expires ' when 'document' then ' expires ' when 'trial' then ' ends ' when 'subscription' then ' renews ' else ' due ' end || s.occurrence_on::text || ': ' end || s.title,
    s.source_kind,s.source_id,s.occurrence_on,case when s.occurrence_on<clock.local_day then 'overdue' else 'upcoming' end
    from private.reminder_sources() s cross join lateral(select (now() at time zone s.delivery_timezone)::date as local_day,
      extract(hour from now() at time zone s.delivery_timezone)::integer as local_hour) clock
    where clock.local_hour>=s.delivery_hour and s.occurrence_on-s.lead_days<=clock.local_day
    on conflict(workspace_id,owner_id,source_kind,source_id,occurrence_on,phase) do nothing;
  get diagnostics automatic_count=row_count;
  return total+automatic_count;
end; $$;

create or replace function private.post_recurring(plan uuid) returns integer language plpgsql security definer set search_path = '' as $$
declare r public.recurring_transactions; posted integer := 0; today date;
begin
  select * into r from public.recurring_transactions where id = plan for update;
  if r.id is null or not r.active or exists(select 1 from public.credit_cards where account_id=r.account_id and archived) then return 0; end if;
  if not exists(select 1 from public.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.owner_id and m.role in ('owner','editor')) then return 0; end if;
  today := private.finance_today(r.owner_id);
  while r.next_on <= today and posted < 100 loop
    insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,recurring_id,occurrence_on)
      values(r.workspace_id,r.owner_id,r.account_id,r.title,r.amount,r.kind,r.category,r.next_on,r.id,r.next_on)
      on conflict(recurring_id,occurrence_on) where recurring_id is not null do nothing;
    r.occurrence_count := r.occurrence_count + 1;
    r.next_on := private.recurrence_date(r.start_on,r.frequency,r.occurrence_count);
    posted := posted + 1;
  end loop;
  update public.recurring_transactions set occurrence_count = r.occurrence_count, next_on = r.next_on where id = plan;
  return posted;
end $$;
