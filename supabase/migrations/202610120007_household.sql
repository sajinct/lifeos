-- Household profiles are records, not authentication identities or invitations.
create table public.household_members (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private',
  name text not null check(length(trim(name)) between 1 and 200), relationship text not null check(length(trim(relationship)) between 1 and 100),
  birthday text check(birthday ~ '^[0-9]{2}-[0-9]{2}$'), notes text not null default '' check(length(notes)<=4000),
  status text not null default 'active' check(status in ('active','archived')), revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.household_entries (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private',
  title text not null check(length(trim(title)) between 1 and 200), kind text not null check(kind in ('task','date')),
  due_on date, annual boolean not null default false, member_id uuid,
  notes text not null default '' check(length(notes)<=4000), status text not null default 'active' check(status in ('active','done','archived')),
  revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,member_id) references public.household_members(workspace_id,id),
  check(not annual or (kind='date' and due_on is not null)), check(kind='task' or due_on is not null), check(kind='task' or status<>'done')
);
create index household_member_workspace on public.household_members(workspace_id,owner_id);
create index household_entry_workspace on public.household_entries(workspace_id,owner_id);
create index household_entry_member on public.household_entries(member_id);
do $$ declare t text; begin
  foreach t in array array['household_members','household_entries'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy household_read on public.%I for select to authenticated using(private.can_read(workspace_id,owner_id,visibility))',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
  end loop;
end $$;
create function public.save_household_member(entry uuid,w uuid,expected_revision integer,member_name text,relation text,birthday_month_day text,member_notes text,sharing public.record_visibility)
returns uuid language plpgsql security definer set search_path='' as $$ declare r public.household_members; birthday_date date; begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required'; end if;
  -- Serialize relationship and visibility changes together, avoiding races that expose private member details.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(w::text,7));
  select * into r from public.household_members where id=entry for update;
  if r.id is not null then
    if r.workspace_id<>w or not private.can_edit(w,r.owner_id,r.visibility) then raise exception 'Household member is inaccessible'; end if;
    if expected_revision is null then
      if r.owner_id is distinct from auth.uid() then raise exception 'Household member is inaccessible'; end if;
      return entry;
    end if;
    if r.revision<>expected_revision then raise exception 'Household record changed; refresh and try again'; end if;
    if r.status<>'active' then raise exception 'Restore the household member before editing'; end if;
    if sharing is distinct from r.visibility and r.owner_id is distinct from auth.uid() then raise exception 'Only the record creator can change sharing'; end if;
  elsif expected_revision is not null then raise exception 'Household member is inaccessible'; end if;
  if sharing is null or member_name is null or length(trim(member_name)) not between 1 and 200 or relation is null or length(trim(relation)) not between 1 and 100
    or member_notes is null or length(member_notes)>4000 then raise exception 'Invalid household member details'; end if;
  if birthday_month_day is not null then
    if birthday_month_day !~ '^[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid birthday month and day'; end if;
    birthday_date:=make_date(2000,split_part(birthday_month_day,'-',1)::integer,split_part(birthday_month_day,'-',2)::integer);
  end if;
  if sharing='private' and exists(select 1 from public.household_entries where member_id=entry and visibility='workspace') then
    raise exception 'Unlink shared responsibilities and dates before making this member private'; end if;
  if r.id is null then
    insert into public.household_members(id,workspace_id,owner_id,name,relationship,birthday,notes,visibility) values(entry,w,auth.uid(),trim(member_name),trim(relation),birthday_month_day,member_notes,sharing);
  else update public.household_members set name=trim(member_name),relationship=trim(relation),birthday=birthday_month_day,notes=member_notes,visibility=sharing,revision=revision+1 where id=entry; end if;
  return entry;
end $$;
create function public.save_household_entry(entry uuid,w uuid,expected_revision integer,entry_title text,entry_kind text,entry_date date,repeats_annually boolean,household_member uuid,entry_notes text,sharing public.record_visibility)
returns uuid language plpgsql security definer set search_path='' as $$ declare r public.household_entries; m public.household_members; begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(w::text,7));
  select * into r from public.household_entries where id=entry for update;
  if r.id is not null then
    if r.workspace_id<>w or not private.can_edit(w,r.owner_id,r.visibility) then raise exception 'Household entry is inaccessible'; end if;
    if expected_revision is null then
      if r.owner_id is distinct from auth.uid() then raise exception 'Household entry is inaccessible'; end if;
      return entry;
    end if;
    if r.revision<>expected_revision then raise exception 'Household record changed; refresh and try again'; end if;
    if r.status<>'active' then raise exception 'Reopen or restore the household entry before editing'; end if;
    if sharing is distinct from r.visibility and r.owner_id is distinct from auth.uid() then raise exception 'Only the record creator can change sharing'; end if;
  elsif expected_revision is not null then raise exception 'Household entry is inaccessible'; end if;
  if sharing is null or entry_title is null or length(trim(entry_title)) not between 1 and 200 or entry_kind is null or entry_kind not in ('task','date')
    or entry_notes is null or length(entry_notes)>4000 or repeats_annually is null or (entry_kind='date' and entry_date is null)
    or (repeats_annually and (entry_kind<>'date' or entry_date is null)) or (entry_date is not null and (entry_date<'1900-01-01' or entry_date>'2100-12-31'))
    or (r.id is not null and r.kind<>entry_kind) then raise exception 'Invalid household entry details'; end if;
  if household_member is not null then
    select * into m from public.household_members where id=household_member and workspace_id=w for update;
    if m.id is null or not private.can_read(w,m.owner_id,m.visibility) or (m.status<>'active' and (r.id is null or r.member_id is distinct from household_member))
      or (sharing='workspace' and m.visibility<>'workspace') then raise exception 'Choose an accessible member with matching sharing'; end if;
  end if;
  if r.id is null then
    insert into public.household_entries(id,workspace_id,owner_id,title,kind,due_on,annual,member_id,notes,visibility)
      values(entry,w,auth.uid(),trim(entry_title),entry_kind,entry_date,repeats_annually,household_member,entry_notes,sharing);
  else update public.household_entries set title=trim(entry_title),due_on=entry_date,annual=repeats_annually,member_id=household_member,notes=entry_notes,visibility=sharing,revision=revision+1 where id=entry; end if;
  return entry;
end $$;
create function public.set_household_status(record_kind text,entry uuid,expected_revision integer,target text) returns void
language plpgsql security definer set search_path='' as $$ declare w uuid; o uuid; v public.record_visibility; s text; k text; rev integer; begin
  if record_kind='member' then select workspace_id into w from public.household_members where id=entry;
  elsif record_kind='entry' then select workspace_id into w from public.household_entries where id=entry;
  else raise exception 'Invalid household record type'; end if;
  if w is null then raise exception 'Household record is inaccessible'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(w::text,7));
  if record_kind='member' then select owner_id,visibility,status,revision into o,v,s,rev from public.household_members where id=entry for update;
  else select owner_id,visibility,status,kind,revision into o,v,s,k,rev from public.household_entries where id=entry for update; end if;
  if not private.can_edit(w,o,v) then raise exception 'Household record write access required'; end if;
  if target is null or target not in ('active','done','archived') or (target='done' and (record_kind='member' or k<>'task')) then raise exception 'Invalid household status'; end if;
  if s=target then return; end if;
  if expected_revision is null or expected_revision<>rev then raise exception 'Household record changed; refresh and try again'; end if;
  if record_kind='member' then update public.household_members set status=target,revision=revision+1 where id=entry;
  else update public.household_entries set status=target,revision=revision+1 where id=entry; end if;
end $$;
-- Annual observances use February 28 in years without February 29. The original month/day stays intact.
create function private.household_anniversary(anchor date,today date) returns date language plpgsql immutable set search_path='' as $$
declare y integer:=extract(year from today); m integer:=extract(month from anchor); d integer:=extract(day from anchor); result date; begin
  result:=make_date(y,m,least(d,extract(day from (make_date(y,m,1)+interval '1 month - 1 day'))::integer));
  if result<today then y:=y+1; result:=make_date(y,m,least(d,extract(day from (make_date(y,m,1)+interval '1 month - 1 day'))::integer)); end if;
  return result;
end $$;
alter table public.app_settings add column family_reminders boolean not null default false,
  add column family_lead_days integer not null default 7 check(family_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact','family_birthday','family_task','family_date'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,
  task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,
  subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer,contacts_enabled boolean,contact_days integer,family_enabled boolean,family_days integer)
returns void language plpgsql security definer set search_path='' as $$ begin
  perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days,loans_enabled,loan_days,contacts_enabled,contact_days);
  update public.app_settings set family_reminders=family_enabled,family_lead_days=family_days where id=auth.uid();
  if not family_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null where owner_id=auth.uid() and source_kind in ('family_birthday','family_task','family_date') and dismissed_at is null; end if;
end $$;
alter function private.reminder_sources() rename to pre_household_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text)
language sql stable security definer set search_path='' as $$
  select * from private.pre_household_reminder_sources()
  union all select r.workspace_id,r.owner_id,'family_birthday',r.id,r.name,
    private.household_anniversary(('2000-'||r.birthday)::date,(now() at time zone s.reminder_timezone)::date),s.family_lead_days,s.reminder_hour,s.reminder_timezone
    from public.household_members r join public.app_settings s on s.id=r.owner_id join public.workspace_members m on m.workspace_id=r.workspace_id and m.user_id=r.owner_id
    where s.family_reminders and r.status='active' and r.birthday is not null
  union all select r.workspace_id,r.owner_id,case r.kind when 'task' then 'family_task' else 'family_date' end,r.id,r.title,
    case when r.annual then private.household_anniversary(r.due_on,(now() at time zone s.reminder_timezone)::date) else r.due_on end,s.family_lead_days,s.reminder_hour,s.reminder_timezone
    from public.household_entries r join public.app_settings s on s.id=r.owner_id join public.workspace_members m on m.workspace_id=r.workspace_id and m.user_id=r.owner_id
    where s.family_reminders and r.status='active' and r.due_on is not null;
$$;
-- Clear old occurrences immediately when dates/status change, and at annual rollover during dispatch.
create function private.clear_household_notifications() returns trigger language plpgsql security definer set search_path='' as $$ begin
  update public.notifications n set dismissed_at=now(),snoozed_until=null where n.source_id=old.id and n.source_kind in ('family_birthday','family_task','family_date') and n.dismissed_at is null
    and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end $$;
create trigger clear_household_notifications after update or delete on public.household_members for each row execute function private.clear_household_notifications();
create trigger clear_household_notifications after update or delete on public.household_entries for each row execute function private.clear_household_notifications();
revoke all on function private.household_anniversary(date,date),private.reminder_sources(),private.clear_household_notifications() from public,anon,authenticated;
revoke all on function public.save_household_member(uuid,uuid,integer,text,text,text,text,public.record_visibility),
  public.save_household_entry(uuid,uuid,integer,text,text,date,boolean,uuid,text,public.record_visibility),public.set_household_status(text,uuid,integer,text),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_household_member(uuid,uuid,integer,text,text,text,text,public.record_visibility),
  public.save_household_entry(uuid,uuid,integer,text,text,date,boolean,uuid,text,public.record_visibility),public.set_household_status(text,uuid,integer,text),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer) to authenticated;

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
    case s.source_kind when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'family_birthday' then 'Birthday' when 'family_task' then 'Household task' when 'family_date' then 'Important date' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
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
