create table public.contacts (
  id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  name text not null check(length(trim(name)) between 1 and 200), kind text not null check(kind in ('person','organization')),
  organization text not null default '' check(length(organization)<=200), category text not null default 'Personal' check(length(trim(category)) between 1 and 100),
  email text not null default '' check(length(email)<=254), phone text not null default '' check(length(phone)<=50),
  website text not null default '' check(length(website)<=500), address text not null default '' check(length(address)<=500),
  notes text not null default '' check(length(notes)<=4000), next_follow_up date, follow_up_note text not null default '' check(length(follow_up_note)<=500),
  last_contacted_on date, status text not null default 'active' check(status in ('active','archived')),
  revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.contact_links (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
  contact_id uuid not null, project_id uuid, loan_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check((project_id is not null)::integer+(loan_id is not null)::integer=1),
  foreign key(workspace_id,contact_id) references public.contacts(workspace_id,id) on delete cascade,
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id) on delete cascade,
  foreign key(workspace_id,loan_id) references public.loans(workspace_id,id) on delete cascade,
  unique(contact_id,project_id),unique(contact_id,loan_id)
);
create index contact_owner_workspace on public.contacts(owner_id,workspace_id);
create index contact_links_owner_workspace on public.contact_links(owner_id,workspace_id);
do $$ declare t text; begin
  foreach t in array array['contacts','contact_links'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_contact_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
  end loop;
end $$;
create trigger touch_updated_at before update on public.contacts for each row execute function private.touch_updated_at();

create function public.save_contact(entry uuid,w uuid,expected_revision integer,contact_name text,contact_kind text,
  contact_organization text,contact_category text,contact_email text,contact_phone text,contact_website text,
  contact_address text,contact_notes text,follow_up date,follow_up_description text,last_contact date,projects uuid[],loans uuid[])
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.contacts; p uuid; l uuid;
begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,6));
  select * into c from public.contacts where id=entry for update;
  if c.id is not null then
    if c.workspace_id<>w or c.owner_id is distinct from auth.uid() then raise exception 'Contact is inaccessible'; end if;
    if expected_revision is null then return entry; end if;
    if c.revision<>expected_revision then raise exception 'Contact changed; refresh and try again'; end if;
    if c.status<>'active' then raise exception 'Restore the contact before editing'; end if;
  elsif expected_revision is not null then raise exception 'Contact is inaccessible'; end if;
  if contact_name is null or length(trim(contact_name)) not between 1 and 200 or contact_kind is null or contact_kind not in ('person','organization')
    or contact_organization is null or length(contact_organization)>200 or contact_category is null or length(trim(contact_category)) not between 1 and 100
    or contact_email is null or length(contact_email)>254 or (contact_email<>'' and contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or contact_phone is null or length(contact_phone)>50 or (contact_phone<>'' and contact_phone !~ '^[+0-9(). xX-]+$')
    or contact_website is null or length(contact_website)>500 or (contact_website<>'' and contact_website !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][^[:space:]]*)?$')
    or contact_address is null or length(contact_address)>500 or contact_notes is null or length(contact_notes)>4000
    or follow_up_description is null or length(follow_up_description)>500
    or (follow_up is not null and (follow_up<'1900-01-01' or follow_up>'2100-12-31'))
    or (last_contact is not null and (last_contact<'1900-01-01' or last_contact>private.finance_today(auth.uid())))
    or projects is null or loans is null or cardinality(projects)>50 or cardinality(loans)>50
    then raise exception 'Invalid contact details or links'; end if;
  foreach p in array projects loop
    if p is null or not exists(select 1 from public.projects x where x.id=p and x.workspace_id=w and x.owner_id=auth.uid()) then raise exception 'Own project in this workspace required'; end if;
  end loop;
  foreach l in array loans loop
    if l is null or not exists(select 1 from public.loans x where x.id=l and x.workspace_id=w and x.owner_id=auth.uid()) then raise exception 'Own loan in this workspace required'; end if;
  end loop;
  if c.id is null then
    insert into public.contacts(id,workspace_id,owner_id,name,kind,organization,category,email,phone,website,address,notes,next_follow_up,follow_up_note,last_contacted_on)
      values(entry,w,auth.uid(),trim(contact_name),contact_kind,trim(contact_organization),trim(contact_category),trim(contact_email),trim(contact_phone),contact_website,contact_address,contact_notes,follow_up,follow_up_description,last_contact);
  else
    update public.contacts set name=trim(contact_name),kind=contact_kind,organization=trim(contact_organization),category=trim(contact_category),
      email=trim(contact_email),phone=trim(contact_phone),website=contact_website,address=contact_address,notes=contact_notes,
      next_follow_up=follow_up,follow_up_note=follow_up_description,last_contacted_on=last_contact,revision=revision+1 where id=entry;
  end if;
  delete from public.contact_links where contact_id=entry;
  insert into public.contact_links(workspace_id,owner_id,contact_id,project_id)
    select w,auth.uid(),entry,unnest(projects) on conflict(contact_id,project_id) do nothing;
  insert into public.contact_links(workspace_id,owner_id,contact_id,loan_id)
    select w,auth.uid(),entry,unnest(loans) on conflict(contact_id,loan_id) do nothing;
  return entry;
end $$;
create function public.set_contact_status(entry uuid,expected_revision integer,target text) returns void
language plpgsql security definer set search_path='' as $$ declare c public.contacts; begin
  select * into c from public.contacts where id=entry for update;
  if c.id is null or c.owner_id is distinct from auth.uid() or not private.can_write(c.workspace_id) then raise exception 'Contact owner with write access required'; end if;
  if target is null or target not in ('active','archived') then raise exception 'Invalid contact status'; end if;
  if c.status=target then return; end if;
  if expected_revision is null or expected_revision<>c.revision then raise exception 'Contact changed; refresh and try again'; end if;
  update public.contacts set status=target,revision=revision+1 where id=entry;
end $$;
create function public.complete_contact_follow_up(entry uuid,expected_revision integer) returns void
language plpgsql security definer set search_path='' as $$ declare c public.contacts; today date; begin
  select * into c from public.contacts where id=entry for update;
  if c.id is null or c.owner_id is distinct from auth.uid() or not private.can_write(c.workspace_id) then raise exception 'Contact owner with write access required'; end if;
  today:=private.finance_today(auth.uid());
  if c.next_follow_up is null and c.last_contacted_on=today then return; end if;
  if c.status<>'active' or expected_revision is null or expected_revision<>c.revision then raise exception 'Contact changed; refresh and try again'; end if;
  update public.contacts set last_contacted_on=today,next_follow_up=null,follow_up_note='',revision=revision+1 where id=entry;
end $$;
alter table public.app_settings add column contact_reminders boolean not null default false,
  add column contact_lead_days integer not null default 1 check(contact_lead_days between 0 and 90);
alter table public.notifications drop constraint notifications_source_kind_check;
alter table public.notifications add constraint notifications_source_kind_check check(source_kind in ('task','bill','document','subscription','trial','loan','contact'));
create function public.save_reminder_preferences(tasks_enabled boolean,bills_enabled boolean,documents_enabled boolean,
  task_days integer,bill_days integer,document_days integer,delivery_hour integer,delivery_timezone text,
  subscriptions_enabled boolean,subscription_days integer,loans_enabled boolean,loan_days integer,contacts_enabled boolean,contact_days integer)
returns void language plpgsql security definer set search_path='' as $$ begin
  perform public.save_reminder_preferences(tasks_enabled,bills_enabled,documents_enabled,task_days,bill_days,document_days,
    delivery_hour,delivery_timezone,subscriptions_enabled,subscription_days,loans_enabled,loan_days);
  update public.app_settings set contact_reminders=contacts_enabled,contact_lead_days=contact_days where id=auth.uid();
  if not contacts_enabled then update public.notifications set dismissed_at=now(),snoozed_until=null
    where owner_id=auth.uid() and source_kind='contact' and dismissed_at is null; end if;
end $$;
alter function private.reminder_sources() rename to pre_contact_reminder_sources;
create function private.reminder_sources() returns table(workspace_id uuid,owner_id uuid,source_kind text,source_id uuid,title text,
  occurrence_on date,lead_days integer,delivery_hour integer,delivery_timezone text)
language sql stable security definer set search_path='' as $$
  select * from private.pre_contact_reminder_sources()
  union all
  select c.workspace_id,c.owner_id,'contact',c.id,c.name,c.next_follow_up,s.contact_lead_days,s.reminder_hour,s.reminder_timezone
    from public.contacts c join public.app_settings s on s.id=c.owner_id
    join public.workspace_members m on m.workspace_id=c.workspace_id and m.user_id=c.owner_id
    where s.contact_reminders and c.status='active' and c.next_follow_up is not null;
$$;
create trigger clear_contact_notifications after update or delete on public.contacts for each row execute function private.clear_stale_source_notifications();
revoke all on function private.reminder_sources() from public,anon,authenticated;
revoke all on function public.save_contact(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,date,text,date,uuid[],uuid[]),
  public.set_contact_status(uuid,integer,text),public.complete_contact_follow_up(uuid,integer),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_contact(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,date,text,date,uuid[],uuid[]),
  public.set_contact_status(uuid,integer,text),public.complete_contact_follow_up(uuid,integer),
  public.save_reminder_preferences(boolean,boolean,boolean,integer,integer,integer,integer,text,boolean,integer,boolean,integer,boolean,integer) to authenticated;

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
    case s.source_kind when 'task' then 'Task' when 'bill' then 'Bill' when 'document' then 'Document' when 'trial' then 'Trial' when 'contact' then 'Contact follow-up' when 'loan' then 'Loan repayment' else 'Subscription' end ||
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
  kind:=case tg_table_name when 'tasks' then 'task' when 'bills' then 'bill' when 'subscriptions' then 'subscription' when 'loans' then 'loan' when 'contacts' then 'contact' else 'document' end;
  update public.notifications n set dismissed_at=now(),snoozed_until=null
    where (n.source_kind=kind or (kind='subscription' and n.source_kind='trial')) and n.source_id=old.id and n.dismissed_at is null
    and not exists(select 1 from private.reminder_sources() s where s.source_kind=n.source_kind and s.source_id=old.id
      and s.occurrence_on=n.occurrence_on and s.owner_id=n.owner_id and s.workspace_id=n.workspace_id);
  return null;
end; $$;
