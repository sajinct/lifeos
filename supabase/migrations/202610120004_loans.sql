-- Private, fixed-contract loans. Principal is a cash movement; only interest affects income/expenses.
create table public.loans (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  title text not null check(length(trim(title)) between 1 and 200), counterparty text not null check(length(trim(counterparty)) between 1 and 200),
  direction text not null check(direction in ('borrowed','lent')), currency text not null check(currency ~ '^[A-Z]{3}$'),
  principal numeric(14,2) not null check(principal>0), annual_rate numeric(6,2) not null check(annual_rate between 0 and 100),
  interest_total numeric(14,2) not null check(interest_total>=0), installments integer not null check(installments between 1 and 600),
  installment_amount numeric(14,2) not null check(installment_amount>0), opened_on date not null, first_due_on date not null check(first_due_on>=opened_on),
  next_due_on date, principal_paid numeric(14,2) not null default 0 check(principal_paid between 0 and principal),
  interest_paid numeric(14,2) not null default 0 check(interest_paid between 0 and interest_total),
  status text not null default 'active' check(status in ('active','paid')), notes text not null default '' check(length(notes)<=2000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.loan_repayments (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  loan_id uuid not null, principal_amount numeric(14,2) not null check(principal_amount>=0), interest_amount numeric(14,2) not null check(interest_amount>=0),
  booked_on date not null, account_id uuid, notes text not null default '' check(length(notes)<=2000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(principal_amount+interest_amount>0), foreign key(workspace_id,loan_id) references public.loans(workspace_id,id),
  foreign key(workspace_id,account_id) references public.accounts(workspace_id,id), unique(workspace_id,id)
);
create index loan_owner_workspace on public.loans(owner_id,workspace_id);
create index repayment_loan on public.loan_repayments(loan_id,booked_on);
alter table public.transactions add column loan_id uuid, add column loan_repayment_id uuid,
  add foreign key(workspace_id,loan_id) references public.loans(workspace_id,id),
  add foreign key(workspace_id,loan_repayment_id) references public.loan_repayments(workspace_id,id);
do $$ declare t text; begin
  foreach t in array array['loans','loan_repayments'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_loan_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
  end loop;
end $$;
create trigger touch_updated_at before update on public.loans for each row execute function private.touch_updated_at();

create function public.create_loan(entry uuid,w uuid,loan_title text,party text,loan_direction text,loan_currency text,
  principal_amount numeric,rate numeric,term integer,opened date,first_due date,loan_notes text,initial_account uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare interest numeric; payment numeric; old public.loans;
begin
  if auth.uid() is null or not private.can_write(w) or entry is null then raise exception 'Workspace write access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,4));
  select * into old from public.loans where id=entry;
  if old.id is not null then
    if old.owner_id is distinct from auth.uid() or old.workspace_id<>w then raise exception 'Loan is inaccessible'; end if;
    return entry; -- A successful create retried after a lost response never records principal twice.
  end if;
  if principal_amount is null or principal_amount<=0 or principal_amount<>round(principal_amount,2)
    or principal_amount>999999999999.99 or rate is null or rate<0 or rate>100 or rate<>round(rate,2)
    or term is null or term not between 1 and 600 or loan_direction is null or loan_direction not in ('borrowed','lent')
    or loan_currency is null or loan_currency !~ '^[A-Z]{3}$' or loan_title is null or length(trim(loan_title)) not between 1 and 200
    or party is null or length(trim(party)) not between 1 and 200 or loan_notes is null or length(loan_notes)>2000
    or opened is null or first_due is null or opened>private.finance_today(auth.uid()) or first_due<opened
    or opened<'1900-01-01' or first_due>'2100-12-31' then raise exception 'Invalid loan details'; end if;
  interest:=round(principal_amount*rate*term/1200,2);
  if principal_amount+interest>999999999999.99 or term>(principal_amount+interest)*100 then raise exception 'Loan total or term is out of range'; end if;
  payment:=ceil((principal_amount+interest)*100/term)/100;
  -- The last installment must remain positive after cent rounding.
  if payment*(term-1)>=principal_amount+interest then raise exception 'Use fewer installments for this amount'; end if;
  if initial_account is not null and not exists(select 1 from public.accounts a where a.id=initial_account and a.owner_id=auth.uid()
    and a.workspace_id=w and a.currency=loan_currency) then raise exception 'Own account in the loan currency required'; end if;
  insert into public.loans(id,workspace_id,owner_id,title,counterparty,direction,currency,principal,annual_rate,interest_total,
    installments,installment_amount,opened_on,first_due_on,next_due_on,notes)
  values(entry,w,auth.uid(),trim(loan_title),trim(party),loan_direction,loan_currency,principal_amount,rate,interest,term,payment,opened,first_due,first_due,loan_notes);
  if initial_account is not null then
    insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,transfer_id,loan_id)
    values(w,auth.uid(),initial_account,left(trim(loan_title)||' · principal',200),principal_amount,
      case when loan_direction='borrowed' then 'transfer_in' else 'transfer_out' end,'Loan principal',opened,gen_random_uuid(),entry);
  end if;
  return entry;
end $$;

create function public.record_loan_repayment(entry uuid,loan uuid,principal_amount numeric,interest_amount numeric,
  payment_date date,payment_account uuid,payment_notes text) returns uuid
language plpgsql security definer set search_path='' as $$
declare l public.loans; old public.loan_repayments; paid numeric; completed integer;
begin
  if auth.uid() is null or entry is null then raise exception 'Sign in first'; end if;
  -- Request lock precedes loan lock. Serializes retries including attempts to reuse a nonce on another loan.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,5));
  select * into l from public.loans where id=loan for update;
  if l.id is null or l.owner_id is distinct from auth.uid() or not private.can_write(l.workspace_id) then raise exception 'Loan owner with write access required'; end if;
  select * into old from public.loan_repayments where id=entry;
  if old.id is not null then
    if old.owner_id is distinct from auth.uid() or old.loan_id<>loan then raise exception 'Repayment request is inaccessible'; end if;
    return entry;
  end if;
  if l.status<>'active' or principal_amount is null or interest_amount is null or principal_amount<0 or interest_amount<0
    or principal_amount<>round(principal_amount,2) or interest_amount<>round(interest_amount,2) or principal_amount+interest_amount<=0
    or principal_amount>l.principal-l.principal_paid or interest_amount>l.interest_total-l.interest_paid
    or payment_date is null or payment_date<l.opened_on or payment_date>private.finance_today(auth.uid())
    or payment_notes is null or length(payment_notes)>2000 then raise exception 'Invalid repayment or amount exceeds outstanding balance'; end if;
  if payment_account is not null and not exists(select 1 from public.accounts a where a.id=payment_account and a.workspace_id=l.workspace_id
    and a.owner_id=auth.uid() and a.currency=l.currency) then raise exception 'Own account in the loan currency required'; end if;
  insert into public.loan_repayments(id,workspace_id,owner_id,loan_id,principal_amount,interest_amount,booked_on,account_id,notes)
  values(entry,l.workspace_id,l.owner_id,loan,principal_amount,interest_amount,payment_date,payment_account,payment_notes);
  if payment_account is not null then
    if principal_amount>0 then
      insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,transfer_id,loan_id,loan_repayment_id)
      values(l.workspace_id,l.owner_id,payment_account,left(l.title||' · principal repayment',200),principal_amount,
        case when l.direction='borrowed' then 'transfer_out' else 'transfer_in' end,'Loan principal',payment_date,entry,loan,entry);
    end if;
    if interest_amount>0 then
      insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,loan_id,loan_repayment_id)
      values(l.workspace_id,l.owner_id,payment_account,left(l.title||' · interest',200),interest_amount,
        case when l.direction='borrowed' then 'expense' else 'income' end,'Loan interest',payment_date,loan,entry);
    end if;
  end if;
  paid:=l.principal_paid+l.interest_paid+principal_amount+interest_amount;
  completed:=least(l.installments-1,floor(paid/l.installment_amount)::integer);
  update public.loans set principal_paid=principal_paid+record_loan_repayment.principal_amount,
    interest_paid=interest_paid+record_loan_repayment.interest_amount,
    status=case when paid=l.principal+l.interest_total then 'paid' else 'active' end,
    next_due_on=case when paid=l.principal+l.interest_total then null else private.recurrence_date(l.first_due_on,'monthly',completed) end
    where id=loan;
  return entry;
end $$;

alter table public.app_settings add column loan_reminders boolean not null default false,
  add column loan_lead_days integer not null default 3 check(loan_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,
  task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,
  subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer)
returns void language plpgsql security definer set search_path='' as $$ begin
  perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,
    delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days);
  update public.app_settings set loan_reminders=loans_enabled,loan_lead_days=loan_days where id=auth.uid();
  if not loans_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null
    where owner_id=auth.uid() and source_kind='loan' and dismissed_at is null; end if;
end $$;
alter function private.reminder_sources() rename to pre_loan_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,
  occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text)
language sql stable security definer set search_path='' as $$
  select * from private.pre_loan_reminder_sources()
  union all
  select l.workspace_id,l.owner_id,'loan',l.id,l.title,l.next_due_on,s.loan_lead_days,s.reminder_hour,s.reminder_timezone
    from public.loans l join public.app_settings s on s.id=l.owner_id
    join public.workspace_members m on m.workspace_id=l.workspace_id and m.user_id=l.owner_id
    where s.loan_reminders and l.status='active' and l.next_due_on is not null;
$$;
create trigger clear_loan_notifications after update or delete on public.loans for each row execute function private.clear_stale_source_notifications();
revoke all on function private.reminder_sources() from public,anon,authenticated;
revoke all on function public.create_loan(uuid,uuid,text,text,text,text,numeric,numeric,integer,date,date,text,uuid),
  public.record_loan_repayment(uuid,uuid,numeric,numeric,date,uuid,text),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer) from public,anon,authenticated;
grant execute on function public.create_loan(uuid,uuid,text,text,text,text,numeric,numeric,integer,date,date,text,uuid),
  public.record_loan_repayment(uuid,uuid,numeric,numeric,date,uuid,text),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer) to authenticated;

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
    case s.source_kind when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'loan' then 'Loan repayment' else 'Subscription' end ||
    case when s.occurrence_on<clock.local_day then
      case s.source_kind when 'document' then ' expired: ' when 'trial' then ' ended: ' when 'subscription' then ' renewal overdue: ' else ' overdue: ' end
    else case s.source_kind when 'document' then ' expires ' when 'trial' then ' ends ' when 'subscription' then ' renews ' else ' due ' end || s.occurrence_on::text || ': ' end || s.title,
    s.source_kind,s.source_id,s.occurrence_on,case when s.occurrence_on<clock.local_day then 'overdue' else 'upcoming' end
    from private.reminder_sources() s cross join lateral(select (now() at time zone s.delivery_timezone)::date as local_day,
      extract(hour from now() at time zone s.delivery_timezone)::integer as local_hour) clock
    where clock.local_hour>=s.delivery_hour and s.occurrence_on-s.lead_days<=clock.local_day
    on conflict(workspace_id,owner_id,source_kind,source_id,occurrence_on,phase) do nothing;
  get diagnostics automatic_count=row_count;
  return total+automatic_count;
end; $$;
create or replace function private.clear_stale_source_notifications() returns trigger
language plpgsql security definer set search_path='' as $$
declare kind text;
begin
  kind:=case tg_table_name when 'tasks' then 'task' when 'bills' then 'bill' when 'subscriptions' then 'subscription' when 'loans' then 'loan' else 'document' end;
  update public.notifications n set dismissed_at=now(),snoozed_until=null
    where (n.source_kind=kind or (kind='subscription' and n.source_kind='trial')) and n.source_id=old.id and n.dismissed_at is null
    and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=old.id
      and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end; $$;
