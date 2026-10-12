alter table public.attachments add constraint attachments_workspace_id_key unique(workspace_id,id);
create table public.assets (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  name text not null check(length(trim(name)) between 1 and 200), category text not null check(length(trim(category)) between 1 and 100),
  manufacturer text not null default '' check(length(manufacturer)<=100), model text not null default '' check(length(model)<=100),
  serial_number text not null default '' check(length(serial_number)<=100), location text not null default '' check(length(location)<=200),
  purchased_on date, purchase_price numeric(14,2) check(purchase_price>=0 and purchase_price<1000000000000), currency text not null check(currency ~ '^[A-Z]{3}$'),
  warranty_until date, notes text not null default '' check(length(notes)<=4000), status text not null default 'active' check(status in ('active','sold','retired','archived')),
  revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.asset_documents (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  asset_id uuid not null, attachment_id uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,asset_id) references public.assets(workspace_id,id) on delete cascade,
  foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade,unique(asset_id,attachment_id)
);
create table public.maintenance_plans (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),asset_id uuid not null,
  title text not null check(length(trim(title)) between 1 and 200), anchor_on date not null, next_on date,
  frequency text not null check(frequency in ('once','monthly','yearly')), occurrence_count integer not null default 0 check(occurrence_count>=0),
  status text not null default 'active' check(status in ('active','paused','completed')), notes text not null default '' check(length(notes)<=2000),
  revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,asset_id) references public.assets(workspace_id,id) on delete cascade,unique(workspace_id,id),
  check((status='completed' and next_on is null) or (status<>'completed' and next_on is not null))
);
create table public.maintenance_logs (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  asset_id uuid not null, plan_id uuid not null, scheduled_on date not null, performed_on date not null,
  title text not null, cost numeric(14,2) check(cost>=0 and cost<1000000000000),currency text not null check(currency ~ '^[A-Z]{3}$'), notes text not null default '' check(length(notes)<=2000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,asset_id) references public.assets(workspace_id,id) on delete cascade,
  foreign key(workspace_id,plan_id) references public.maintenance_plans(workspace_id,id) on delete cascade,unique(plan_id,scheduled_on)
);
do $$ declare t text; begin
  foreach t in array array['assets','asset_documents','maintenance_plans','maintenance_logs'] loop
    execute format('create index on public.%I(workspace_id,owner_id)',t);
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_asset_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
  end loop;
end $$;
create index maintenance_asset_idx on public.maintenance_plans(asset_id);
create index maintenance_log_asset_idx on public.maintenance_logs(asset_id);
create trigger touch_updated_at before update on public.assets for each row execute function private.touch_updated_at();
create trigger touch_updated_at before update on public.maintenance_plans for each row execute function private.touch_updated_at();
create function public.save_asset(entry uuid,w uuid,expected_revision integer,asset_name text,asset_category text,asset_manufacturer text,asset_model text,asset_serial text,asset_location text,purchased date,price numeric,price_currency text,warranty date,asset_notes text,documents uuid[])
returns uuid language plpgsql security definer set search_path='' as $$ declare r public.assets; f uuid; begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,8));
  select * into r from public.assets where id=entry for update;
  if r.id is not null then
    if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Asset is inaccessible';end if;
    if expected_revision is null then return entry;end if;
    if r.revision<>expected_revision then raise exception 'Asset changed; refresh and try again';end if;
    if r.status<>'active' then raise exception 'Restore the asset before editing';end if;
  elsif expected_revision is not null then raise exception 'Asset is inaccessible';end if;
  if asset_name is null or length(trim(asset_name)) not between 1 and 200 or asset_category is null or length(trim(asset_category)) not between 1 and 100
    or asset_manufacturer is null or length(asset_manufacturer)>100 or asset_model is null or length(asset_model)>100 or asset_serial is null or length(asset_serial)>100
    or asset_location is null or length(asset_location)>200 or asset_notes is null or length(asset_notes)>4000 or price_currency is null or price_currency !~ '^[A-Z]{3}$'
    or (price is not null and (price<0 or price>=1000000000000 or price<>round(price,2)))
    or (purchased is not null and (purchased<'1900-01-01' or purchased>private.finance_today(auth.uid())))
    or (warranty is not null and (warranty<'1900-01-01' or warranty>'2100-12-31' or warranty<purchased))
    or documents is null or cardinality(documents)>50 then raise exception 'Invalid asset details';end if;
  foreach f in array documents loop
    if f is null or not exists(select 1 from public.attachments where id=f and workspace_id=w and owner_id=auth.uid() and status in ('ready','archived')) then raise exception 'Choose your own completed document in this workspace';end if;
  end loop;
  if r.id is null then insert into public.assets(id,workspace_id,owner_id,name,category,manufacturer,model,serial_number,location,purchased_on,purchase_price,currency,warranty_until,notes)
    values(entry,w,auth.uid(),trim(asset_name),trim(asset_category),trim(asset_manufacturer),trim(asset_model),trim(asset_serial),trim(asset_location),purchased,price,price_currency,warranty,asset_notes);
  else update public.assets set name=trim(asset_name),category=trim(asset_category),manufacturer=trim(asset_manufacturer),model=trim(asset_model),serial_number=trim(asset_serial),location=trim(asset_location),purchased_on=purchased,purchase_price=price,currency=price_currency,warranty_until=warranty,notes=asset_notes,revision=revision+1 where id=entry;end if;
  delete from public.asset_documents where asset_id=entry;
  insert into public.asset_documents(workspace_id,owner_id,asset_id,attachment_id) select w,auth.uid(),entry,unnest(documents) on conflict(asset_id,attachment_id) do nothing;
  return entry;
end $$;
create function public.set_asset_status(entry uuid,expected_revision integer,target text) returns void language plpgsql security definer set search_path='' as $$ declare r public.assets;begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,8));select * into r from public.assets where id=entry for update;
  if r.id is null or r.owner_id is distinct from auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Asset owner with write access required';end if;
  if target is null or target not in ('active','sold','retired','archived') then raise exception 'Invalid asset status';end if;
  if target=r.status then return;end if;
  if expected_revision is null or expected_revision<>r.revision then raise exception 'Asset changed; refresh and try again';end if;
  update public.assets set status=target,revision=revision+1 where id=entry;
end $$;
create function public.save_maintenance_plan(entry uuid,w uuid,expected_revision integer,asset uuid,plan_title text,first_due date,repeat_frequency text,plan_notes text)
returns uuid language plpgsql security definer set search_path='' as $$ declare a public.assets; p public.maintenance_plans; changed boolean; begin
  if auth.uid() is null or entry is null or asset is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(asset::text,8));
  select * into a from public.assets where id=asset for update;
  if a.id is null or a.workspace_id<>w or a.owner_id is distinct from auth.uid() or a.status<>'active' then raise exception 'Own active asset in this workspace required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,9));
  select * into p from public.maintenance_plans where id=entry for update;
  if p.id is not null then
    if p.asset_id<>asset or p.workspace_id<>w or p.owner_id is distinct from auth.uid() then raise exception 'Maintenance plan is inaccessible';end if;
    if expected_revision is null then return entry;end if;
    if expected_revision<>p.revision then raise exception 'Maintenance plan changed; refresh and try again';end if;
    if p.status='completed' then raise exception 'Add a new plan for a completed one-time service';end if;
  elsif expected_revision is not null then raise exception 'Maintenance plan is inaccessible';end if;
  if plan_title is null or length(trim(plan_title)) not between 1 and 200 or first_due is null or first_due<'1900-01-01' or first_due>'2100-12-31'
    or repeat_frequency is null or repeat_frequency not in ('once','monthly','yearly') or plan_notes is null or length(plan_notes)>2000 then raise exception 'Invalid maintenance details';end if;
  changed:=p.id is null or first_due is distinct from p.next_on or repeat_frequency is distinct from p.frequency;
  if changed and exists(select 1 from public.maintenance_logs where plan_id=entry and scheduled_on=first_due) then raise exception 'This scheduled date was already completed; choose a new date';end if;
  if p.id is null then insert into public.maintenance_plans(id,workspace_id,owner_id,asset_id,title,anchor_on,next_on,frequency,notes)values(entry,w,auth.uid(),asset,trim(plan_title),first_due,first_due,repeat_frequency,plan_notes);
  else update public.maintenance_plans set title=trim(plan_title),next_on=first_due,frequency=repeat_frequency,notes=plan_notes,anchor_on=case when changed then first_due else anchor_on end,occurrence_count=case when changed then 0 else occurrence_count end,revision=revision+1 where id=entry;end if;
  return entry;
end $$;
create function public.set_maintenance_status(entry uuid,expected_revision integer,target text) returns void language plpgsql security definer set search_path='' as $$ declare a public.assets;p public.maintenance_plans;aid uuid;begin
  select asset_id into aid from public.maintenance_plans where id=entry;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(aid::text,8));select * into a from public.assets where id=aid for update;
  select * into p from public.maintenance_plans where id=entry for update;
  if p.id is null or p.owner_id is distinct from auth.uid() or not private.can_write(p.workspace_id) or a.status<>'active' then raise exception 'Own active asset with write access required';end if;
  if target is null or target not in ('active','paused') or p.status='completed' then raise exception 'Completed one-time plans cannot resume';end if;
  if p.status=target then return;end if;
  if expected_revision is null or expected_revision<>p.revision then raise exception 'Maintenance plan changed; refresh and try again';end if;
  update public.maintenance_plans set status=target,revision=revision+1 where id=entry;
end $$;
create function public.record_maintenance(entry uuid,plan uuid,expected_revision integer,expected_date date,performed date,service_cost numeric,service_notes text)
returns uuid language plpgsql security definer set search_path='' as $$ declare a public.assets;p public.maintenance_plans;l public.maintenance_logs;aid uuid;next_date date;begin
  if auth.uid() is null or entry is null then raise exception 'Sign in first';end if;
  select asset_id into aid from public.maintenance_plans where id=plan;
  if aid is null then raise exception 'Maintenance plan is inaccessible';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(aid::text,8));select * into a from public.assets where id=aid for update;
  select * into p from public.maintenance_plans where id=plan for update;
  if p.owner_id is distinct from auth.uid() or not private.can_write(p.workspace_id) then raise exception 'Maintenance owner with write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,10));select * into l from public.maintenance_logs where id=entry;
  if l.id is not null then
    if l.plan_id<>plan or l.owner_id is distinct from auth.uid() then raise exception 'Service record is inaccessible';end if;return entry;
  end if;
  if a.status<>'active' or p.status<>'active' or expected_revision is null or expected_revision<>p.revision or expected_date is distinct from p.next_on then raise exception 'Maintenance plan changed or inactive; refresh and try again';end if;
  if performed is null or performed<'1900-01-01' or performed>private.finance_today(auth.uid()) or service_notes is null or length(service_notes)>2000
    or (service_cost is not null and (service_cost<0 or service_cost>=1000000000000 or service_cost<>round(service_cost,2))) then raise exception 'Invalid service date, cost or notes';end if;
  if p.frequency<>'once' then
    next_date:=private.recurrence_date(p.anchor_on,p.frequency,p.occurrence_count+1);
    if next_date>'2100-12-31' then raise exception 'Next service date exceeds supported range; change to a one-time plan';end if;
    if exists(select 1 from public.maintenance_logs where plan_id=plan and scheduled_on=next_date) then raise exception 'Next scheduled date already completed; edit the plan to a new date';end if;
  end if;
  insert into public.maintenance_logs(id,workspace_id,owner_id,asset_id,plan_id,scheduled_on,performed_on,title,cost,currency,notes)values(entry,p.workspace_id,auth.uid(),p.asset_id,p.id,p.next_on,performed,p.title,service_cost,a.currency,service_notes);
  update public.maintenance_plans set next_on=next_date,status=case frequency when 'once' then 'completed' else 'active' end,occurrence_count=occurrence_count+1,revision=revision+1 where id=plan;
  return entry;
end $$;
alter table public.app_settings add column asset_reminders boolean not null default false,
  add column warranty_lead_days integer not null default 30 check(warranty_lead_days between 0 and 90),
  add column maintenance_lead_days integer not null default 7 check(maintenance_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact','family_birthday','family_task','family_date','warranty','maintenance'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer,contacts_enabled boolean,contact_days integer,family_enabled boolean,family_days integer,assets_enabled boolean,warranty_days integer,maintenance_days integer)
returns void language plpgsql security definer set search_path='' as $$ begin
  perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days,loans_enabled,loan_days,contacts_enabled,contact_days,family_enabled,family_days);
  update public.app_settings set asset_reminders=assets_enabled,warranty_lead_days=warranty_days,maintenance_lead_days=maintenance_days where id=auth.uid();
  if not assets_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null where owner_id=auth.uid() and source_kind in ('warranty','maintenance') and dismissed_at is null;end if;
end $$;
alter function private.reminder_sources() rename to pre_asset_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text)
language sql stable security definer set search_path='' as $$
  select * from private.pre_asset_reminder_sources()
  union all select a.workspace_id,a.owner_id,'warranty',a.id,a.name,a.warranty_until,s.warranty_lead_days,s.reminder_hour,s.reminder_timezone
    from public.assets a join public.app_settings s on s.id=a.owner_id join public.workspace_members m on m.workspace_id=a.workspace_id and m.user_id=a.owner_id
    where s.asset_reminders and a.status='active' and a.warranty_until is not null
  union all select p.workspace_id,p.owner_id,'maintenance',p.id,p.title||' · '||a.name,p.next_on,s.maintenance_lead_days,s.reminder_hour,s.reminder_timezone
    from public.maintenance_plans p join public.assets a on a.id=p.asset_id and a.workspace_id=p.workspace_id and a.owner_id=p.owner_id
    join public.app_settings s on s.id=p.owner_id join public.workspace_members m on m.workspace_id=p.workspace_id and m.user_id=p.owner_id
    where s.asset_reminders and p.status='active' and a.status='active';
$$;
create function private.clear_asset_notifications() returns trigger language plpgsql security definer set search_path='' as $$begin
  update public.notifications n set dismissed_at=now(),snoozed_until=null where n.source_kind in ('warranty','maintenance') and n.dismissed_at is null
    and (n.source_id=old.id or (tg_table_name='assets' and n.source_id in(select id from public.maintenance_plans where asset_id=old.id)))
    and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end $$;
create trigger clear_asset_notifications after update or delete on public.assets for each row execute function private.clear_asset_notifications();
create trigger clear_asset_notifications after update or delete on public.maintenance_plans for each row execute function private.clear_asset_notifications();
revoke all on function private.reminder_sources(),private.clear_asset_notifications() from public,anon,authenticated;
revoke all on function public.save_asset(uuid,uuid,integer,text,text,text,text,text,text,date,numeric,text,date,text,uuid[]),public.set_asset_status(uuid,integer,text),
  public.save_maintenance_plan(uuid,uuid,integer,uuid,text,date,text,text),public.set_maintenance_status(uuid,integer,text),public.record_maintenance(uuid,uuid,integer,date,date,numeric,text),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.save_asset(uuid,uuid,integer,text,text,text,text,text,text,date,numeric,text,date,text,uuid[]),public.set_asset_status(uuid,integer,text),
  public.save_maintenance_plan(uuid,uuid,integer,uuid,text,date,text,text),public.set_maintenance_status(uuid,integer,text),public.record_maintenance(uuid,uuid,integer,date,date,numeric,text),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer,boolean,integer,boolean,integer,integer) to authenticated;

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
    case s.source_kind when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'family_birthday' then 'Birthday' when 'family_task' then 'Household task' when 'family_date' then 'Important date' when 'warranty' then 'Asset warranty' when 'maintenance' then 'Maintenance' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
    case when s.occurrence_on<clock.local_day then
      case s.source_kind when 'warranty' then ' expired: ' when 'document' then ' expired: ' when 'trial' then ' ended: ' when 'subscription' then ' renewal overdue: ' else ' overdue: ' end
    else case s.source_kind when 'warranty' then ' expires ' when 'document' then ' expires ' when 'trial' then ' ends ' when 'subscription' then ' renews ' else ' due ' end || s.occurrence_on::text || ': ' end || s.title,
    s.source_kind,s.source_id,s.occurrence_on,case when s.occurrence_on<clock.local_day then 'overdue' else 'upcoming' end
    from private.reminder_sources() s cross join lateral(select (now() at time zone s.delivery_timezone)::date as local_day,
      extract(hour from now() at time zone s.delivery_timezone)::integer as local_hour) clock
    where clock.local_hour>=s.delivery_hour and s.occurrence_on-s.lead_days<=clock.local_day
    on conflict(workspace_id,owner_id,source_kind,source_id,occurrence_on,phase) do nothing;
  get diagnostics automatic_count=row_count;
  return total+automatic_count;
end; $$;
