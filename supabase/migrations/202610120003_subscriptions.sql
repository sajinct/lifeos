-- Private subscription tracking. Expense automation is opt-in bookkeeping, never a provider payment.
alter table public.recurring_transactions add constraint recurring_workspace_id_unique unique(workspace_id,id);
create table public.subscriptions (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility='private'),
  title text not null check(length(trim(title)) between 1 and 200),
  amount numeric(14,2) not null check(amount>=0), currency text not null check(currency ~ '^[A-Z]{3}$'),
  frequency text not null check(frequency in ('monthly','yearly')),
  anchor_on date not null, next_on date not null, renewal_count integer not null default 0 check(renewal_count>=0),
  status text not null check(status in ('active','trial','cancelled')), trial_ends_on date,
  category text not null default 'Subscriptions' check(length(trim(category)) between 1 and 100),
  provider_url text not null default '' check(length(provider_url)<=500 and (provider_url='' or provider_url ~ '^https://[^[:space:]]+$')),
  notes text not null default '' check(length(notes)<=2000),
  recurring_id uuid unique, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,recurring_id) references public.recurring_transactions(workspace_id,id),
  check(status<>'trial' or (trial_ends_on is not null and next_on>=trial_ends_on))
);
alter table public.subscriptions enable row level security;
create index subscriptions_workspace_owner on public.subscriptions(workspace_id,owner_id,created_at,id);
create policy own_subscription_read on public.subscriptions for select to authenticated
using(owner_id=(select auth.uid()) and private.is_member(workspace_id));
revoke all on public.subscriptions from public,anon,authenticated;
grant select on public.subscriptions to authenticated;
create trigger touch_updated_at before update on public.subscriptions for each row execute function private.touch_updated_at();

-- Lock schedules before subscriptions, matching the recurring dispatcher and cursor-sync trigger.
create function private.lock_subscription(entry uuid) returns public.subscriptions
language plpgsql security definer set search_path='' as $$
declare hint public.subscriptions; s public.subscriptions;
begin
  select * into hint from public.subscriptions where id=entry and owner_id=auth.uid() and private.can_write(workspace_id);
  if hint.id is null then raise exception 'Subscription owner with write access required'; end if;
  if hint.recurring_id is not null then perform 1 from public.recurring_transactions where id=hint.recurring_id for update; end if;
  select * into s from public.subscriptions where id=entry for update;
  if s.recurring_id is distinct from hint.recurring_id then raise exception 'Subscription changed; refresh and try again'; end if;
  if s.owner_id is distinct from auth.uid() or not private.can_write(s.workspace_id) then raise exception 'Subscription owner with write access required'; end if;
  return s;
end; $$;

create function public.save_subscription(
  entry uuid, w uuid, revision timestamptz, service_name text, price numeric, price_currency text,
  billing_frequency text, first_renewal date, trial_end date, subscription_status text,
  service_category text, service_url text, service_notes text,
  link_mode text, expense_account uuid, existing_schedule uuid, auto_record boolean
) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.subscriptions; r public.recurring_transactions; schedule uuid; currency text;
  old_schedule uuid; anchor date; next_date date; count integer:=0; old_hint uuid;
begin
  if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required'; end if;
  if entry is null then raise exception 'Request ID required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,3));
  if exists(select 1 from public.subscriptions where id=entry and owner_id<>auth.uid()) then raise exception 'Subscription is inaccessible'; end if;
  if subscription_status is null or link_mode is null or subscription_status not in ('active','trial') or link_mode not in ('track','create','existing') then raise exception 'Choose a valid subscription status and expense link'; end if;
  select recurring_id into old_hint from public.subscriptions where id=entry and owner_id=auth.uid();
  -- Deterministic order also protects switching between two existing schedules.
  perform 1 from public.recurring_transactions where owner_id=auth.uid() and workspace_id=w
    and id in (old_hint,existing_schedule) order by id for update;
  select * into s from public.subscriptions where id=entry and owner_id=auth.uid() for update;
  if s.id is not null then
    if s.workspace_id<>w then raise exception 'Cannot move subscriptions between workspaces'; end if;
    if revision is null then return s.id; end if; -- Retry of a successful creation, without creating another expense schedule.
    if s.updated_at<>revision or s.recurring_id is distinct from old_hint then raise exception 'Subscription changed; refresh and try again'; end if;
    old_schedule:=s.recurring_id;
  elsif revision is not null then raise exception 'Subscription is inaccessible';
  end if;
  if service_url<>'' and (service_url !~ '^https://[^[:space:]]+$' or service_url ~ '^https://[^/]*@') then raise exception 'Use an HTTPS provider URL without credentials'; end if;
  if billing_frequency not in ('monthly','yearly') or price<0 or price<>round(price,2) or first_renewal is null then raise exception 'Check the price, billing frequency and renewal date'; end if;
  if subscription_status='trial' and (trial_end is null or first_renewal<trial_end) then raise exception 'First paid renewal must be on or after the trial end'; end if;
  anchor:=first_renewal; next_date:=first_renewal; currency:=price_currency;
  if link_mode='existing' then
    select * into r from public.recurring_transactions where id=existing_schedule and workspace_id=w and owner_id=auth.uid() for update;
    if r.id is null or r.kind<>'expense' or r.frequency not in ('monthly','yearly') then raise exception 'Choose your own monthly or yearly expense schedule'; end if;
    if exists(select 1 from public.subscriptions where recurring_id=r.id and id<>entry) then raise exception 'Expense schedule already belongs to another subscription'; end if;
    if s.status='cancelled' or (s.status='trial' and subscription_status='active') then raise exception 'Create a fresh expense schedule when restarting a paid plan'; end if;
    if subscription_status='trial' and (s.id is null or s.status<>'trial' or old_schedule is distinct from r.id or r.occurrence_count<>0) then raise exception 'A trial requires a new paused expense schedule'; end if;
    select a.currency into currency from public.accounts a where a.id=r.account_id and a.workspace_id=w and a.owner_id=auth.uid();
    price:=r.amount; billing_frequency:=r.frequency; anchor:=r.start_on; next_date:=r.next_on; count:=r.occurrence_count;
    if subscription_status='trial' and next_date<trial_end then raise exception 'First paid renewal must be on or after the trial end'; end if;
    schedule:=r.id;
  elsif link_mode='create' then
    if price<=0 then raise exception 'Expense schedules require a positive price'; end if;
    select a.currency into currency from public.accounts a where a.id=expense_account and a.workspace_id=w and a.owner_id=auth.uid();
    if currency is null or currency<>price_currency then raise exception 'Choose your own account in the subscription currency'; end if;
    -- Avoid silently backfilling historical payments when a subscription creates a new plan.
    if first_renewal<private.finance_today(auth.uid()) then raise exception 'A new expense schedule must start today or later'; end if;
    insert into public.recurring_transactions(workspace_id,owner_id,account_id,title,amount,kind,category,frequency,start_on,next_on,active,automatic)
      values(w,auth.uid(),expense_account,trim(service_name),price,'expense',trim(service_category),billing_frequency,first_renewal,first_renewal,
        subscription_status='active',subscription_status='active' and auto_record) returning id into schedule;
  end if;
  if old_schedule is not null and old_schedule is distinct from schedule then
    update public.recurring_transactions set active=false,automatic=false where id=old_schedule;
  end if;
  if link_mode='track' and s.id is not null and old_schedule is null and s.status=subscription_status
    and s.next_on=first_renewal and s.frequency=billing_frequency then anchor:=s.anchor_on; count:=s.renewal_count; end if;
  insert into public.subscriptions(id,workspace_id,owner_id,title,amount,currency,frequency,anchor_on,next_on,renewal_count,status,
    trial_ends_on,category,provider_url,notes,recurring_id)
    values(entry,w,auth.uid(),trim(service_name),price,currency,billing_frequency,anchor,next_date,count,subscription_status,
      trial_end,trim(service_category),service_url,service_notes,schedule)
  on conflict(id) do update set title=excluded.title,amount=excluded.amount,currency=excluded.currency,frequency=excluded.frequency,
    anchor_on=excluded.anchor_on,next_on=excluded.next_on,renewal_count=excluded.renewal_count,status=excluded.status,
    trial_ends_on=excluded.trial_ends_on,category=excluded.category,provider_url=excluded.provider_url,notes=excluded.notes,recurring_id=excluded.recurring_id;
  if subscription_status='trial' and schedule is not null then update public.recurring_transactions set active=false,automatic=false where id=schedule; end if;
  return entry;
end; $$;

create function public.cancel_subscription(entry uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.subscriptions;
begin
  s:=private.lock_subscription(entry);
  if s.status='cancelled' then return; end if;
  update public.subscriptions set status='cancelled' where id=entry;
  if s.recurring_id is not null then update public.recurring_transactions set active=false,automatic=false where id=s.recurring_id; end if;
end; $$;
create function public.advance_subscription(entry uuid, expected_date date) returns void
language plpgsql security definer set search_path='' as $$
declare s public.subscriptions;
begin
  s:=private.lock_subscription(entry);
  if s.status<>'active' or s.recurring_id is not null then raise exception 'Use the linked expense schedule, or start the paid plan first'; end if;
  if expected_date is null then raise exception 'Expected renewal date required'; end if;
  if s.next_on<>expected_date then return; end if; -- Replay-safe manual acknowledgement.
  if s.next_on>private.finance_today(s.owner_id) then raise exception 'Renewal is not due yet'; end if;
  update public.subscriptions set renewal_count=s.renewal_count+1,
    next_on=private.recurrence_date(s.anchor_on,s.frequency,s.renewal_count+1) where id=entry;
end; $$;

create function private.guard_subscription_schedule() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (new.active or new.automatic) and exists(select 1 from public.subscriptions s where s.recurring_id=new.id and s.status<>'active') then
    raise exception 'Trial or cancelled subscriptions cannot resume expense recording';
  end if;
  return new;
end; $$;
create trigger guard_subscription_schedule before update on public.recurring_transactions
for each row execute function private.guard_subscription_schedule();
create function private.sync_subscription_cursor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.next_on is distinct from old.next_on or new.occurrence_count<>old.occurrence_count then
    update public.subscriptions set next_on=new.next_on,renewal_count=new.occurrence_count where recurring_id=new.id;
  end if;
  return null;
end; $$;
create trigger sync_subscription_cursor after update on public.recurring_transactions
for each row execute function private.sync_subscription_cursor();

alter table public.app_settings add column subscription_reminders boolean not null default false,
  add column subscription_lead_days integer not null default 7 check(subscription_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check
check(source_kind in ('task','bill','document','subscription','trial'));

-- Keep the existing eight-argument RPC compatible with older frontends and operating scripts.
create function public.save_reminder_preferences(
  tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,task_days integer,bill_days integer,document_days integer,
  delivery_hour integer,delivery_timezone text,subscriptions_enabled boolean,subscription_days integer
) returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone);
  update public.app_settings set subscription_reminders=subscriptions_enabled,subscription_lead_days=subscription_days where id=auth.uid();
  if not subscriptions_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null
    where owner_id=auth.uid() and source_kind in ('subscription','trial') and dismissed_at is null; end if;
end; $$;

create or replace function private.reminder_sources() returns table(
  workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text
) language sql stable security definer set search_path='' as $$
  select t.workspace_id,t.owner_id,'task',t.id,t.title,t.due_date,s.task_lead_days,s.reminder_hour,s.reminder_timezone
    from public.tasks t join public.app_settings s on s.id=t.owner_id
    join public.workspace_members m on m.workspace_id=t.workspace_id and m.user_id=t.owner_id
    where s.task_reminders and t.status<>'done' and t.due_date is not null
  union all
  select b.workspace_id,b.owner_id,'bill',b.id,b.title,b.due_on,s.bill_lead_days,s.reminder_hour,s.reminder_timezone
    from public.bills b join public.app_settings s on s.id=b.owner_id
    join public.workspace_members m on m.workspace_id=b.workspace_id and m.user_id=b.owner_id where s.bill_reminders and b.status='pending'
  union all
  select a.workspace_id,a.owner_id,'document',a.id,a.name,a.expires_on,s.document_lead_days,s.reminder_hour,s.reminder_timezone
    from public.attachments a join public.app_settings s on s.id=a.owner_id
    join public.workspace_members m on m.workspace_id=a.workspace_id and m.user_id=a.owner_id
    where s.document_reminders and a.status='ready' and a.expires_on is not null and a.bucket_id='personal-documents'
  union all
  select p.workspace_id,p.owner_id,case when p.status='trial' then 'trial' else 'subscription' end,p.id,p.title,
    case when p.status='trial' then p.trial_ends_on else p.next_on end,s.subscription_lead_days,s.reminder_hour,s.reminder_timezone
    from public.subscriptions p join public.app_settings s on s.id=p.owner_id
    join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.owner_id
    where s.subscription_reminders and p.status in ('active','trial');
$$;

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
    case s.source_kind when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' else 'Subscription' end ||
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
  kind:=case tg_table_name when 'tasks' then 'task' when 'bills' then 'bill' when 'subscriptions' then 'subscription' else 'document' end;
  update public.notifications n set dismissed_at=now(),snoozed_until=null
    where (n.source_kind=kind or (kind='subscription' and n.source_kind='trial')) and n.source_id=old.id and n.dismissed_at is null
    and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=old.id
      and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end; $$;
create trigger clear_subscription_notifications after update or delete on public.subscriptions
for each row execute function private.clear_stale_source_notifications();

revoke all on function private.lock_subscription(uuid),private.guard_subscription_schedule(),private.sync_subscription_cursor() from public,anon,authenticated;
revoke all on function public.save_subscription(uuid,uuid,timestamptz,text,numeric,text,text,date,date,text,text,text,text,text,uuid,uuid,boolean),
  public.cancel_subscription(uuid),public.advance_subscription(uuid,date),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_subscription(uuid,uuid,timestamptz,text,numeric,text,text,date,date,text,text,text,text,text,uuid,uuid,boolean),
  public.cancel_subscription(uuid),public.advance_subscription(uuid,date),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer) to authenticated;
