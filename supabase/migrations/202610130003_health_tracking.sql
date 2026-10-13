create table public.health_logs (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 kind text not null check(kind in ('fitness','measurement')),title text not null check(length(trim(title)) between 1 and 200),logged_on date not null check(logged_on between '1900-01-01' and '2100-12-31'),
 minutes integer,value numeric(12,3),unit text not null default '' check(length(unit)<=40),notes text not null default '' check(length(notes)<=2000),archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),
 check((kind='fitness' and minutes between 1 and 1440) or (kind='measurement' and minutes is null and value is not null)),
 check(value is null or (value>=0 and value<1000000000)),check((value is null and unit='')or(value is not null and length(trim(unit))>0))
);
create table public.medication_plans (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 title text not null check(length(trim(title)) between 1 and 200),instructions text not null default '' check(length(instructions)<=2000),starts_on date not null,ends_on date,
 weekdays integer[] not null,reminder_time text not null check(reminder_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),timezone text not null,
 active boolean not null default true,archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),
 check(starts_on between '1900-01-01' and '2100-12-31'),check(ends_on is null or (ends_on between starts_on and '2100-12-31')),
 check(cardinality(weekdays) between 1 and 7 and weekdays <@ array[0,1,2,3,4,5,6])
);
create table public.health_expenses (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 transaction_id uuid not null,appointment_id uuid,notes text not null default '' check(length(notes)<=2000),archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,owner_id,transaction_id),
 foreign key(workspace_id,transaction_id) references public.transactions(workspace_id,id),foreign key(workspace_id,appointment_id) references public.health_appointments(workspace_id,id)
);
do $$declare t text;begin
 foreach t in array array['health_logs','medication_plans','health_expenses'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);execute format('create policy own_health_tracking_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create function public.save_health_log(entry uuid,w uuid,expected_revision integer,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.health_logs;v public.health_logs;raw_value numeric;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,21));select * into r from public.health_logs where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Health log is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Health log changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Health log is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid health log';end if;
 raw_value:=(details->>'value')::numeric;
 if raw_value is not null and (raw_value::text in ('NaN','Infinity','-Infinity') or raw_value<0 or raw_value>=1000000000 or raw_value<>round(raw_value,3)) then raise exception 'Enter a value with up to three decimals';end if;
 select * into v from jsonb_populate_record(null::public.health_logs,details);
 if v.kind is null or v.kind not in ('fitness','measurement') or (r.id is not null and v.kind<>r.kind) or v.title is null or length(trim(v.title)) not between 1 and 200 or v.logged_on is null or v.logged_on not between '1900-01-01' and private.finance_today(auth.uid()) or v.unit is null or length(v.unit)>40 or v.notes is null or length(v.notes)>2000
 or (v.kind='fitness' and (v.minutes is null or v.minutes not between 1 and 1440)) or (v.kind='measurement' and (v.minutes is not null or v.value is null)) or (v.value is null and v.unit<>'') or (v.value is not null and length(trim(v.unit))=0) then raise exception 'Check log date, duration, value and unit';end if;
 if r.id is null then insert into public.health_logs(id,workspace_id,owner_id,kind,title,logged_on,minutes,value,unit,notes)values(entry,w,auth.uid(),v.kind,trim(v.title),v.logged_on,v.minutes,v.value,trim(v.unit),v.notes);
 else update public.health_logs set title=trim(v.title),logged_on=v.logged_on,minutes=v.minutes,value=v.value,unit=trim(v.unit),notes=v.notes,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.save_medication_plan(entry uuid,w uuid,expected_revision integer,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.medication_plans;v public.medication_plans;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,22));select * into r from public.medication_plans where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Medication plan is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Medication plan changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Medication plan is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid medication plan';end if;
 select * into v from jsonb_populate_record(null::public.medication_plans,details);
 if v.title is null or length(trim(v.title)) not between 1 and 200 or v.instructions is null or length(v.instructions)>2000 or v.starts_on is null or v.starts_on not between '1900-01-01' and '2100-12-31' or (v.ends_on is not null and v.ends_on not between v.starts_on and '2100-12-31') or v.weekdays is null or cardinality(v.weekdays) not between 1 and 7 or not(v.weekdays <@ array[0,1,2,3,4,5,6]) or array_position(v.weekdays,null) is not null or cardinality(v.weekdays)<>(select count(distinct d)from unnest(v.weekdays)d) or v.reminder_time is null or v.reminder_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or v.timezone is null or not exists(select 1 from pg_timezone_names where name=v.timezone) then raise exception 'Check medication name, dates, weekdays, time and time zone';end if;
 if r.id is null then insert into public.medication_plans(id,workspace_id,owner_id,title,instructions,starts_on,ends_on,weekdays,reminder_time,timezone)values(entry,w,auth.uid(),trim(v.title),v.instructions,v.starts_on,v.ends_on,v.weekdays,v.reminder_time,v.timezone);
 else update public.medication_plans set title=trim(v.title),instructions=v.instructions,starts_on=v.starts_on,ends_on=v.ends_on,weekdays=v.weekdays,reminder_time=v.reminder_time,timezone=v.timezone,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.save_health_expense(entry uuid,w uuid,expected_revision integer,expense uuid,appointment uuid,expense_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.health_expenses;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(expense::text,23));select * into r from public.health_expenses where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() or r.transaction_id is distinct from expense then raise exception 'Health expense is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Health expense changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Health expense is inaccessible';end if;
 if not exists(select 1 from public.transactions where id=expense and workspace_id=w and owner_id=auth.uid() and kind='expense') then raise exception 'Choose your own recorded expense';end if;
 if appointment is not null and not exists(select 1 from public.health_appointments where id=appointment and workspace_id=w and owner_id=auth.uid()) then raise exception 'Choose your own appointment';end if;
 if expense_notes is null or length(expense_notes)>2000 then raise exception 'Notes must be up to 2000 characters';end if;
 if r.id is null then
  if exists(select 1 from public.health_expenses where workspace_id=w and owner_id=auth.uid() and transaction_id=expense) then raise exception 'Expense already linked; edit or restore its link';end if;
  insert into public.health_expenses(id,workspace_id,owner_id,transaction_id,appointment_id,notes)values(entry,w,auth.uid(),expense,appointment,expense_notes);
 else update public.health_expenses set appointment_id=appointment,notes=expense_notes,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.act_on_health_tracking(entry uuid,record_kind text,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$
declare t text;r record;arch boolean;enabled boolean;
begin
 t:=case record_kind when 'log' then 'health_logs' when 'medication' then 'medication_plans' when 'expense' then 'health_expenses' else null end;
 if t is null or action is null or action not in ('archive','restore','pause','resume') or (record_kind<>'medication' and action in ('pause','resume')) then raise exception 'Invalid health action';end if;
 -- Every update also takes a row lock; creation locks cannot bypass lifecycle revisions.
 execute format('select * from public.%I where id=$1 for update',t) into r using entry;
 if r.id is null or auth.uid() is null or r.owner_id is distinct from auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Health owner with write access required';end if;
 arch:=case action when 'archive' then true when 'restore' then false else r.archived end;
 if record_kind='medication' then
  enabled:=case action when 'pause' then false when 'resume' then true else r.active end;
  if r.archived=arch and r.active=enabled then return;end if;
 else if r.archived=arch then return;end if;end if;
 if expected_revision is null or r.revision<>expected_revision or (r.archived and action in ('pause','resume')) then raise exception 'Health record changed; restore or refresh';end if;
 if record_kind='medication' then update public.medication_plans set archived=arch,active=enabled,revision=revision+1 where id=entry;
 else execute format('update public.%I set archived=$2,revision=revision+1 where id=$1',t)using entry,arch;end if;
end $$;
alter table public.app_settings add column medication_reminders boolean not null default false;
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact','family_birthday','family_task','family_date','warranty','maintenance','career_follow_up','career_interview','certification','health_appointment','health_medication'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer,contacts_enabled boolean,contact_days integer,family_enabled boolean,family_days integer,assets_enabled boolean,warranty_days integer,maintenance_days integer,career_enabled boolean,career_days integer,certification_days integer,health_enabled boolean,health_days integer,medications_enabled boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days,loans_enabled,loan_days,contacts_enabled,contact_days,family_enabled,family_days,assets_enabled,warranty_days,maintenance_days,career_enabled,career_days,certification_days,health_enabled,health_days);
 update public.app_settings set medication_reminders=medications_enabled where id=auth.uid();
 if not medications_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null where owner_id=auth.uid() and source_kind='health_medication' and dismissed_at is null;end if;
end $$;
alter function private.reminder_sources() rename to pre_medication_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text) language sql stable security definer set search_path='' as $$
 select * from private.pre_medication_reminder_sources()
 union all select r.workspace_id,r.owner_id,'health_medication',r.id,r.title,clock.day,0,0,r.timezone
 from public.medication_plans r join public.app_settings s on s.id=r.owner_id join public.workspace_members m on m.workspace_id=r.workspace_id and m.user_id=r.owner_id
 cross join lateral(select (now() at time zone r.timezone)::date as day,(now() at time zone r.timezone)::time as time)clock
 where s.medication_reminders and r.active and not r.archived and clock.day>=r.starts_on and (r.ends_on is null or clock.day<=r.ends_on)
 and extract(dow from clock.day)::integer=any(r.weekdays) and clock.time>=r.reminder_time::time;
$$;
create function private.clear_medication_notifications() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.notifications n set dismissed_at=now(),snoozed_until=null where n.source_id=old.id and n.source_kind='health_medication' and n.dismissed_at is null
 and not exists(select 1 from private.reminder_sources()s where s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);return null;
end $$;
create trigger clear_medication_notifications after update or delete on public.medication_plans for each row execute function private.clear_medication_notifications();
revoke all on function private.reminder_sources(),private.clear_medication_notifications() from public,anon,authenticated;
revoke all on function public.save_health_log(uuid,uuid,integer,jsonb),public.save_medication_plan(uuid,uuid,integer,jsonb),public.save_health_expense(uuid,uuid,integer,uuid,uuid,text),public.act_on_health_tracking(uuid,text,integer,text),public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer,boolean,integer,integer,boolean,integer,boolean) from public,anon,authenticated;
grant execute on function public.save_health_log(uuid,uuid,integer,jsonb),public.save_medication_plan(uuid,uuid,integer,jsonb),public.save_health_expense(uuid,uuid,integer,uuid,uuid,text),public.act_on_health_tracking(uuid,text,integer,text),public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer,boolean,integer,integer,boolean,integer,boolean) to authenticated;

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
    case s.source_kind when 'health_medication' then 'Medication reminder' when 'health_appointment' then 'Health appointment' when 'career_follow_up' then 'Application follow-up' when 'career_interview' then 'Interview' when 'certification' then 'Certification' when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'family_birthday' then 'Birthday' when 'family_task' then 'Household task' when 'family_date' then 'Important date' when 'warranty' then 'Asset warranty' when 'maintenance' then 'Maintenance' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
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
