create table public.health_appointments (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 title text not null check(length(trim(title)) between 1 and 200),provider text not null default '' check(length(provider)<=200),location text not null default '' check(length(location)<=300),
 appointment_on date not null check(appointment_on between '1900-01-01' and '2100-12-31'),appointment_time text not null default '' check(appointment_time='' or appointment_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
 notes text not null default '' check(length(notes)<=4000),status text not null default 'scheduled' check(status in ('scheduled','completed','cancelled')),archived boolean not null default false,
 revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table public.health_documents (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 appointment_id uuid not null,attachment_id uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,appointment_id) references public.health_appointments(workspace_id,id) on delete cascade,
 foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade,unique(appointment_id,attachment_id)
);
do $$ declare t text;begin
 foreach t in array array['health_appointments','health_documents'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);
  execute format('create policy own_health_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
 end loop;
end $$;
create trigger touch_updated_at before update on public.health_appointments for each row execute function private.touch_updated_at();
create function public.save_health_appointment(entry uuid,w uuid,expected_revision integer,details jsonb,documents uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.health_appointments;v public.health_appointments;f uuid;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,20));select * into r from public.health_appointments where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Health appointment is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Appointment changed; restore or refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Health appointment is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid appointment details';end if;
 select * into v from jsonb_populate_record(null::public.health_appointments,details);
 if v.title is null or length(trim(v.title)) not between 1 and 200 or v.provider is null or length(v.provider)>200 or v.location is null or length(v.location)>300 or v.notes is null or length(v.notes)>4000 or v.appointment_on is null or v.appointment_on not between '1900-01-01' and '2100-12-31' or v.appointment_time is null or (v.appointment_time<>'' and v.appointment_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') or v.status is null or v.status not in ('scheduled','completed','cancelled') or (v.status='completed' and v.appointment_on>private.finance_today(auth.uid())) or documents is null or cardinality(documents)>50 then raise exception 'Enter a title, valid date/time and status with up to 50 documents; completed visits cannot be in the future';end if;
 foreach f in array documents loop
  if f is null or not exists(select 1 from public.attachments where id=f and workspace_id=w and owner_id=auth.uid() and status in ('ready','archived')) then raise exception 'Choose your own completed document in this workspace';end if;
 end loop;
 if r.id is null then insert into public.health_appointments(id,workspace_id,owner_id,title,provider,location,appointment_on,appointment_time,notes,status) values(entry,w,auth.uid(),trim(v.title),trim(v.provider),trim(v.location),v.appointment_on,v.appointment_time,v.notes,v.status);
 else update public.health_appointments set title=trim(v.title),provider=trim(v.provider),location=trim(v.location),appointment_on=v.appointment_on,appointment_time=v.appointment_time,notes=v.notes,status=v.status,revision=revision+1 where id=entry;end if;
 delete from public.health_documents where appointment_id=entry;
 insert into public.health_documents(workspace_id,owner_id,appointment_id,attachment_id) select w,auth.uid(),entry,unnest(documents) on conflict(appointment_id,attachment_id)do nothing;
 return entry;
end $$;
create function public.act_on_health_appointment(entry uuid,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$
declare r public.health_appointments;s text;arch boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended(entry::text,20));select * into r from public.health_appointments where id=entry for update;
 if not found or auth.uid() is null or r.owner_id is distinct from auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Appointment owner with write access required';end if;
 if action is null or action not in ('complete','cancel','reopen','archive','restore') then raise exception 'Choose a valid appointment action';end if;
 s:=case action when 'complete' then 'completed' when 'cancel' then 'cancelled' when 'reopen' then 'scheduled' else r.status end;
 arch:=case action when 'archive' then true when 'restore' then false else r.archived end;
 if r.status=s and r.archived=arch then return;end if;
 if expected_revision is null or r.revision<>expected_revision or (r.archived and action not in ('archive','restore')) then raise exception 'Appointment changed; restore or refresh and try again';end if;
 if s='completed' and r.appointment_on>private.finance_today(auth.uid()) then raise exception 'Completed visits cannot be in the future';end if;
 update public.health_appointments set status=s,archived=arch,revision=revision+1 where id=entry;
end $$;
alter table public.app_settings add column health_reminders boolean not null default false,add column health_lead_days integer not null default 1 check(health_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact','family_birthday','family_task','family_date','warranty','maintenance','career_follow_up','career_interview','certification','health_appointment'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer,contacts_enabled boolean,contact_days integer,family_enabled boolean,family_days integer,assets_enabled boolean,warranty_days integer,maintenance_days integer,career_enabled boolean,career_days integer,certification_days integer,health_enabled boolean,health_days integer) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days,loans_enabled,loan_days,contacts_enabled,contact_days,family_enabled,family_days,assets_enabled,warranty_days,maintenance_days,career_enabled,career_days,certification_days);
 update public.app_settings set health_reminders=health_enabled,health_lead_days=health_days where id=auth.uid();
 if not health_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null where owner_id=auth.uid() and source_kind='health_appointment' and dismissed_at is null;end if;
end $$;
alter function private.reminder_sources() rename to pre_health_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text) language sql stable security definer set search_path='' as $$
 select * from private.pre_health_reminder_sources()
 union all select r.workspace_id,r.owner_id,'health_appointment',r.id,r.title,r.appointment_on,s.health_lead_days,s.reminder_hour,s.reminder_timezone
 from public.health_appointments r join public.app_settings s on s.id=r.owner_id join public.workspace_members m on m.workspace_id=r.workspace_id and m.user_id=r.owner_id
 where s.health_reminders and r.status='scheduled' and not r.archived;
$$;
create function private.clear_health_notifications() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.notifications n set dismissed_at=now(),snoozed_until=null where n.source_id=old.id and n.source_kind='health_appointment' and n.dismissed_at is null
 and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
 return null;
end $$;
create trigger clear_health_notifications after update or delete on public.health_appointments for each row execute function private.clear_health_notifications();
revoke all on function private.reminder_sources(),private.clear_health_notifications() from public,anon,authenticated;
revoke all on function public.save_health_appointment(uuid,uuid,integer,jsonb,uuid[]),public.act_on_health_appointment(uuid,integer,text),public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer,boolean,integer,integer,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_health_appointment(uuid,uuid,integer,jsonb,uuid[]),public.act_on_health_appointment(uuid,integer,text),public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer,boolean,integer,integer,boolean,integer) to authenticated;

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
    case s.source_kind when 'health_appointment' then 'Health appointment' when 'career_follow_up' then 'Application follow-up' when 'career_interview' then 'Interview' when 'certification' then 'Certification' when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'family_birthday' then 'Birthday' when 'family_task' then 'Household task' when 'family_date' then 'Important date' when 'warranty' then 'Asset warranty' when 'maintenance' then 'Maintenance' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
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
