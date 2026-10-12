create table public.career_records (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  kind text not null check(kind in ('employment','application','certification')),
  title text not null check(length(trim(title)) between 1 and 200), organization text not null check(length(trim(organization)) between 1 and 200),
  location text not null default '' check(length(location)<=200), skills text not null default '' check(length(skills)<=2000),
  starts_on date, ends_on date, applied_on date, interview_on date, follow_up_on date, expires_on date,
  url text not null default '' check(length(url)<=2000), notes text not null default '' check(length(notes)<=4000),
  status text not null, revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id),
  check((kind='application' and status in ('applied','interview','offer','accepted','rejected','withdrawn','archived')) or (kind<>'application' and status in ('active','archived')))
);
create table public.career_documents (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  record_id uuid not null, attachment_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,record_id) references public.career_records(workspace_id,id) on delete cascade,
  foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade, unique(record_id,attachment_id)
);
do $$ declare t text; begin
  foreach t in array array['career_records','career_documents'] loop
    execute format('create index on public.%I(workspace_id,owner_id)',t);
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_career_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
  end loop;
end $$;
create trigger touch_updated_at before update on public.career_records for each row execute function private.touch_updated_at();
create function public.save_career_record(entry uuid,w uuid,expected_revision integer,details jsonb,documents uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.career_records; v public.career_records; f uuid; d date; begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,11));
  select * into r from public.career_records where id=entry for update;
  if r.id is not null then
    if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Career record is inaccessible';end if;
    if expected_revision is null then return entry;end if;
    if r.revision<>expected_revision then raise exception 'Career record changed; refresh and try again';end if;
  elsif expected_revision is not null then raise exception 'Career record is inaccessible';end if;
  if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid career details';end if;
  select * into v from jsonb_populate_record(null::public.career_records,details);
  if v.kind is null or v.kind not in ('employment','application','certification') or (r.id is not null and v.kind<>r.kind)
    or v.title is null or length(trim(v.title)) not between 1 and 200 or v.organization is null or length(trim(v.organization)) not between 1 and 200
    or v.location is null or length(v.location)>200 or v.skills is null or length(v.skills)>2000 or v.notes is null or length(v.notes)>4000
    or v.url is null or length(v.url)>2000 or (v.url<>'' and v.url !~ '^https?://[^[:space:]]+$')
    or v.status is null or not ((v.kind='application' and v.status in ('applied','interview','offer','accepted','rejected','withdrawn','archived')) or (v.kind<>'application' and v.status in ('active','archived')))
    or documents is null or cardinality(documents)>50 then raise exception 'Invalid career details';end if;
  foreach d in array array[v.starts_on,v.ends_on,v.applied_on,v.interview_on,v.follow_up_on,v.expires_on] loop
    if d is not null and (d<'1900-01-01' or d>'2100-12-31') then raise exception 'Invalid career date';end if;
  end loop;
  if (v.kind='employment' and (v.starts_on is null or v.starts_on>private.finance_today(auth.uid()) or v.ends_on<v.starts_on or v.ends_on>private.finance_today(auth.uid()) or v.applied_on is not null or v.interview_on is not null or v.follow_up_on is not null or v.expires_on is not null))
    or (v.kind='application' and (v.applied_on is null or v.applied_on>private.finance_today(auth.uid()) or v.interview_on<v.applied_on or v.follow_up_on<v.applied_on or v.starts_on is not null or v.ends_on is not null or v.expires_on is not null))
    or (v.kind='certification' and (v.starts_on>private.finance_today(auth.uid()) or v.expires_on<v.starts_on or v.ends_on is not null or v.applied_on is not null or v.interview_on is not null or v.follow_up_on is not null)) then raise exception 'Invalid career date or fields for this section';end if;
  foreach f in array documents loop
    if f is null or not exists(select 1 from public.attachments where id=f and workspace_id=w and owner_id=auth.uid() and status in ('ready','archived')) then raise exception 'Choose your own completed document in this workspace';end if;
  end loop;
  if r.id is null then
    insert into public.career_records(id,workspace_id,owner_id,kind,title,organization,location,skills,starts_on,ends_on,applied_on,interview_on,follow_up_on,expires_on,url,notes,status)
    values(entry,w,auth.uid(),v.kind,trim(v.title),trim(v.organization),trim(v.location),trim(v.skills),v.starts_on,v.ends_on,v.applied_on,v.interview_on,v.follow_up_on,v.expires_on,v.url,v.notes,v.status);
  else
    update public.career_records set title=trim(v.title),organization=trim(v.organization),location=trim(v.location),skills=trim(v.skills),starts_on=v.starts_on,ends_on=v.ends_on,applied_on=v.applied_on,interview_on=v.interview_on,follow_up_on=v.follow_up_on,expires_on=v.expires_on,url=v.url,notes=v.notes,status=v.status,revision=revision+1 where id=entry;
  end if;
  delete from public.career_documents where record_id=entry;
  insert into public.career_documents(workspace_id,owner_id,record_id,attachment_id) select w,auth.uid(),entry,unnest(documents) on conflict(record_id,attachment_id) do nothing;
  return entry;
end $$;
create function public.act_on_career_record(entry uuid,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$ declare r public.career_records; begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,11));select * into r from public.career_records where id=entry for update;
  if r.id is null or r.owner_id is distinct from auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Career owner with write access required';end if;
  if action is null or action not in ('archive','restore','follow_up','interview') or (action in ('follow_up','interview') and (r.kind<>'application' or r.status not in ('applied','interview','offer'))) then raise exception 'Invalid career action';end if;
  if (action='archive' and r.status='archived') or (action='restore' and r.status<>'archived') or (action='follow_up' and r.follow_up_on is null) or (action='interview' and r.interview_on is null) then return;end if;
  if expected_revision is null or r.revision<>expected_revision then raise exception 'Career record changed; refresh and try again';end if;
  update public.career_records set status=case when action='archive' then 'archived' when action='restore' then case kind when 'application' then 'applied' else 'active' end else status end,
    follow_up_on=case when action='follow_up' then null else follow_up_on end,interview_on=case when action='interview' then null else interview_on end,revision=revision+1 where id=entry;
end $$;
alter table public.app_settings add column career_reminders boolean not null default false,
  add column career_lead_days integer not null default 1 check(career_lead_days between 0 and 90),
  add column certification_lead_days integer not null default 30 check(certification_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact','family_birthday','family_task','family_date','warranty','maintenance','career_follow_up','career_interview','certification'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer,contacts_enabled boolean,contact_days integer,family_enabled boolean,family_days integer,assets_enabled boolean,warranty_days integer,maintenance_days integer,career_enabled boolean,career_days integer,certification_days integer)
returns void language plpgsql security definer set search_path='' as $$ begin
  perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days,loans_enabled,loan_days,contacts_enabled,contact_days,family_enabled,family_days,assets_enabled,warranty_days,maintenance_days);
  update public.app_settings set career_reminders=career_enabled,career_lead_days=career_days,certification_lead_days=certification_days where id=auth.uid();
  if not career_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null where owner_id=auth.uid() and source_kind in ('career_follow_up','career_interview','certification') and dismissed_at is null;end if;
end $$;
alter function private.reminder_sources() rename to pre_career_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text)
language sql stable security definer set search_path='' as $$
  select * from private.pre_career_reminder_sources()
  union all select r.workspace_id,r.owner_id,d.kind,r.id,r.title||' · '||r.organization,d.due,
    case d.kind when 'certification' then s.certification_lead_days else s.career_lead_days end,s.reminder_hour,s.reminder_timezone
    from public.career_records r join public.app_settings s on s.id=r.owner_id join public.workspace_members m on m.workspace_id=r.workspace_id and m.user_id=r.owner_id
    cross join lateral(values('career_follow_up',r.follow_up_on),('career_interview',r.interview_on),('certification',r.expires_on)) d(kind,due)
    where s.career_reminders and d.due is not null and ((r.kind='application' and r.status in ('applied','interview','offer') and d.kind<>'certification') or (r.kind='certification' and r.status='active' and d.kind='certification'));
$$;
create function private.clear_career_notifications() returns trigger language plpgsql security definer set search_path='' as $$ begin
  update public.notifications n set dismissed_at=now(),snoozed_until=null where n.source_id=old.id and n.source_kind in ('career_follow_up','career_interview','certification') and n.dismissed_at is null
    and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end $$;
create trigger clear_career_notifications after update or delete on public.career_records for each row execute function private.clear_career_notifications();
revoke all on function private.reminder_sources(),private.clear_career_notifications() from public,anon,authenticated;
revoke all on function public.save_career_record(uuid,uuid,integer,jsonb,uuid[]),public.act_on_career_record(uuid,integer,text),public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.save_career_record(uuid,uuid,integer,jsonb,uuid[]),public.act_on_career_record(uuid,integer,text),public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer,boolean,integer,integer) to authenticated;

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
    case s.source_kind when 'career_follow_up' then 'Application follow-up' when 'career_interview' then 'Interview' when 'certification' then 'Certification' when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'family_birthday' then 'Birthday' when 'family_task' then 'Household task' when 'family_date' then 'Important date' when 'warranty' then 'Asset warranty' when 'maintenance' then 'Maintenance' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
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
