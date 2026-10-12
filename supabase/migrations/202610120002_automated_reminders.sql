-- Personal, opt-in in-app reminders. Existing manual reminders remain supported.
alter table public.app_settings
  add column task_reminders boolean not null default false,
  add column bill_reminders boolean not null default false,
  add column document_reminders boolean not null default false,
  add column task_lead_days integer not null default 1 check(task_lead_days between 0 and 30),
  add column bill_lead_days integer not null default 3 check(bill_lead_days between 0 and 30),
  add column document_lead_days integer not null default 30 check(document_lead_days between 0 and 90),
  add column reminder_hour integer not null default 9 check(reminder_hour between 0 and 23),
  add column reminder_timezone text not null default 'UTC';

create function private.validate_reminder_timezone() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from pg_catalog.pg_timezone_names where name = new.reminder_timezone) then
    raise exception 'Choose a valid IANA time zone';
  end if;
  return new;
end; $$;
create trigger validate_reminder_timezone before insert or update of reminder_timezone
on public.app_settings for each row execute function private.validate_reminder_timezone();
revoke all on function private.validate_reminder_timezone() from public,anon,authenticated;

alter table public.notifications
  add column source_kind text check(source_kind in ('task','bill','document')),
  add column source_id uuid,
  add column occurrence_on date,
  add column phase text check(phase in ('upcoming','overdue')),
  add column dismissed_at timestamptz,
  add column snoozed_until timestamptz,
  add constraint notification_source_complete check(
    (source_kind is null and source_id is null and occurrence_on is null and phase is null)
    or (source_kind is not null and source_id is not null and occurrence_on is not null and phase is not null)
  ),
  add constraint notification_occurrence_unique unique(workspace_id,owner_id,source_kind,source_id,occurrence_on,phase);

create function public.save_reminder_preferences(
  tasks_enabled boolean, bills_enabled boolean, documents_enabled boolean,
  task_days integer, bill_days integer, document_days integer, delivery_hour integer, delivery_timezone text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.app_settings(id,task_reminders,bill_reminders,document_reminders,
    task_lead_days,bill_lead_days,document_lead_days,reminder_hour,reminder_timezone)
  values(auth.uid(),tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone)
  on conflict(id) do update set task_reminders=excluded.task_reminders,bill_reminders=excluded.bill_reminders,
    document_reminders=excluded.document_reminders,task_lead_days=excluded.task_lead_days,
    bill_lead_days=excluded.bill_lead_days,document_lead_days=excluded.document_lead_days,
    reminder_hour=excluded.reminder_hour,reminder_timezone=excluded.reminder_timezone;
  update public.notifications set dismissed_at=now(),snoozed_until=null
  where owner_id=auth.uid() and dismissed_at is null and
    ((source_kind='task' and not tasks_enabled) or (source_kind='bill' and not bills_enabled)
    or (source_kind='document' and not documents_enabled));
end; $$;

-- Source titles never cross owners, even when the source record is workspace-shared.
create function private.reminder_sources() returns table(
  workspace_id uuid, owner_id uuid, source_kind text, source_id uuid, title text,
  occurrence_on date, lead_days integer, delivery_hour integer, delivery_timezone text
) language sql stable security definer set search_path = '' as $$
  select t.workspace_id,t.owner_id,'task',t.id,t.title,t.due_date,s.task_lead_days,s.reminder_hour,s.reminder_timezone
  from public.tasks t join public.app_settings s on s.id=t.owner_id
  join public.workspace_members m on m.workspace_id=t.workspace_id and m.user_id=t.owner_id
  where s.task_reminders and t.status<>'done' and t.due_date is not null
  union all
  select b.workspace_id,b.owner_id,'bill',b.id,b.title,b.due_on,s.bill_lead_days,s.reminder_hour,s.reminder_timezone
  from public.bills b join public.app_settings s on s.id=b.owner_id
  join public.workspace_members m on m.workspace_id=b.workspace_id and m.user_id=b.owner_id
  where s.bill_reminders and b.status='pending'
  union all
  select a.workspace_id,a.owner_id,'document',a.id,a.name,a.expires_on,s.document_lead_days,s.reminder_hour,s.reminder_timezone
  from public.attachments a join public.app_settings s on s.id=a.owner_id
  join public.workspace_members m on m.workspace_id=a.workspace_id and m.user_id=a.owner_id
  where s.document_reminders and a.status='ready' and a.expires_on is not null and a.bucket_id='personal-documents';
$$;
revoke all on function private.reminder_sources() from public,anon,authenticated;

create or replace function public.deliver_due_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare total integer; automatic_count integer;
begin
  -- A transaction-wide advisory lock makes concurrent scheduler runs harmless.
  if not pg_catalog.pg_try_advisory_xact_lock(120012,2) then return 0; end if;
  update public.notifications n set dismissed_at=now(),snoozed_until=null
  where n.source_kind is not null and n.dismissed_at is null and not exists(
    select 1 from private.reminder_sources() s where s.workspace_id=n.workspace_id and s.owner_id=n.owner_id
    and s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on);
  insert into public.notifications(workspace_id,owner_id,title,reminder_id)
    select r.workspace_id,r.owner_id,r.title,r.id from public.reminders r
    where r.due_at<=now() and r.delivered_at is null
    and exists(select 1 from public.workspace_members m where m.workspace_id=r.workspace_id and m.user_id=r.owner_id)
    on conflict(reminder_id) do nothing;
  get diagnostics total = row_count;
  update public.reminders r set delivered_at=now() where delivered_at is null
    and exists(select 1 from public.notifications n where n.reminder_id=r.id);
  insert into public.notifications(workspace_id,owner_id,title,source_kind,source_id,occurrence_on,phase)
    select s.workspace_id,s.owner_id,
      case s.source_kind when 'task' then 'Task' when 'bill' then 'Bill' else 'Document' end ||
      case when s.occurrence_on<clock.local_day then
        case when s.source_kind='document' then ' expired: ' else ' overdue: ' end
      else case when s.source_kind='document' then ' expires ' else ' due ' end || s.occurrence_on::text || ': ' end || s.title,
      s.source_kind,s.source_id,s.occurrence_on,
      case when s.occurrence_on<clock.local_day then 'overdue' else 'upcoming' end
    from private.reminder_sources() s
    cross join lateral(select (now() at time zone s.delivery_timezone)::date as local_day,
      extract(hour from now() at time zone s.delivery_timezone)::integer as local_hour) clock
    where clock.local_hour>=s.delivery_hour and s.occurrence_on-s.lead_days<=clock.local_day
    on conflict(workspace_id,owner_id,source_kind,source_id,occurrence_on,phase) do nothing;
  get diagnostics automatic_count = row_count;
  return total+automatic_count;
end; $$;

-- Clear old reminders immediately on source lifecycle changes; date edits create a new occurrence.
create function private.clear_stale_source_notifications() returns trigger
language plpgsql security definer set search_path = '' as $$
declare kind text; source uuid;
begin
  kind := case tg_table_name when 'tasks' then 'task' when 'bills' then 'bill' else 'document' end;
  source := old.id;
  update public.notifications n set dismissed_at=now(),snoozed_until=null
  where n.source_kind=kind and n.source_id=source and n.dismissed_at is null and not exists(
    select 1 from private.reminder_sources() s where s.source_kind=kind and s.source_id=source
    and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end; $$;
create trigger clear_task_notifications after update or delete on public.tasks
for each row execute function private.clear_stale_source_notifications();
create trigger clear_bill_notifications after update or delete on public.bills
for each row execute function private.clear_stale_source_notifications();
create trigger clear_document_notifications after update or delete on public.attachments
for each row execute function private.clear_stale_source_notifications();
revoke all on function private.clear_stale_source_notifications() from public,anon,authenticated;

create function public.act_on_notification(notice uuid, action text, snooze_minutes integer default 60)
returns void language plpgsql security definer set search_path = '' as $$
declare n public.notifications;
begin
  select * into n from public.notifications where id=notice and owner_id=auth.uid()
    and exists(select 1 from public.workspace_members m where m.workspace_id=notifications.workspace_id and m.user_id=auth.uid()) for update;
  if not found then raise exception 'Notification is inaccessible'; end if;
  if action='read' then
    update public.notifications set read_at=now() where id=notice;
  elsif action='dismiss' then
    update public.notifications set dismissed_at=now(),snoozed_until=null where id=notice;
  elsif action='snooze' then
    if snooze_minutes not in (60,1440) then raise exception 'Choose one hour or one day'; end if;
    if n.dismissed_at is not null then raise exception 'Notification was dismissed'; end if;
    if n.source_kind is not null and not exists(select 1 from private.reminder_sources() s
      where s.workspace_id=n.workspace_id and s.owner_id=n.owner_id and s.source_kind=n.source_kind
      and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on) then raise exception 'Reminder is no longer active'; end if;
    update public.notifications set snoozed_until=now()+pg_catalog.make_interval(mins=>snooze_minutes),read_at=null where id=notice;
  else raise exception 'Unknown notification action'; end if;
end; $$;
revoke all on function public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text),
  public.act_on_notification(uuid,text,integer) from public,anon,authenticated;
grant execute on function public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text),
  public.act_on_notification(uuid,text,integer) to authenticated;
revoke all on function public.deliver_due_reminders() from public,anon,authenticated;
grant execute on function public.deliver_due_reminders() to service_role;

-- Cloud projects with pg_cron enabled start dispatch automatically. Local PostgreSQL without
-- the platform extension still runs the same schema and permission tests.
do $$ begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.schedule('lifeos-reminders','*/5 * * * *','select public.deliver_due_reminders();');
  end if;
end; $$;
