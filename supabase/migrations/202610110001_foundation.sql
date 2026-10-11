-- Phase 1 + the first end-to-end productivity slice.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.workspace_kind as enum ('personal', 'family', 'professional', 'side_project');
create type public.member_role as enum ('owner', 'editor', 'viewer');
create type public.record_visibility as enum ('private', 'workspace');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 100),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id),
  name text not null check (length(trim(name)) between 1 and 80),
  kind public.workspace_kind not null default 'personal',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'viewer',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members(user_id, workspace_id);

create function private.is_member(w uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_members where workspace_id = w and user_id = (select auth.uid()));
$$;
create function private.can_write(w uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_members where workspace_id = w and user_id = (select auth.uid()) and role in ('owner','editor'));
$$;
create function private.is_owner(w uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspaces where id = w and owner_id = (select auth.uid()));
$$;
create function private.can_read(w uuid, o uuid, v public.record_visibility) returns boolean language sql stable set search_path = '' as $$
  select private.is_member(w) and (o = (select auth.uid()) or v = 'workspace');
$$;
create function private.can_edit(w uuid, o uuid, v public.record_visibility) returns boolean language sql stable set search_path = '' as $$
  select private.can_write(w) and (o = (select auth.uid()) or (v = 'workspace' and private.is_owner(w)));
$$;
revoke all on function private.is_member(uuid), private.can_write(uuid), private.is_owner(uuid), private.can_read(uuid,uuid,public.record_visibility), private.can_edit(uuid,uuid,public.record_visibility) from public;
grant execute on function private.is_member(uuid), private.can_write(uuid), private.is_owner(uuid), private.can_read(uuid,uuid,public.record_visibility), private.can_edit(uuid,uuid,public.record_visibility) to authenticated;

create function private.new_profile() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id, display_name) values(new.id, left(coalesce(new.raw_user_meta_data->>'display_name',''),100));
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.new_profile();

create function public.create_workspace(workspace_name text, workspace_type public.workspace_kind default 'personal')
returns uuid language plpgsql security definer set search_path = '' as $$
declare w uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.workspaces(owner_id,name,kind) values(auth.uid(),trim(workspace_name),workspace_type) returning id into w;
  insert into public.workspace_members(workspace_id,user_id,role) values(w,auth.uid(),'owner');
  return w;
end; $$;
create function public.set_workspace_member(w uuid, member_id uuid, member_access public.member_role)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_owner(w) then raise exception 'Workspace owner required'; end if;
  if member_access = 'owner' or member_id = auth.uid() then raise exception 'Cannot change ownership'; end if;
  insert into public.workspace_members(workspace_id,user_id,role) values(w,member_id,member_access)
  on conflict (workspace_id,user_id) do update set role = excluded.role, updated_at = now();
end; $$;
create function public.remove_workspace_member(w uuid, member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_owner(w) or member_id = auth.uid() then raise exception 'Workspace owner required; cannot remove owner'; end if;
  delete from public.workspace_members where workspace_id = w and user_id = member_id;
end; $$;

create table public.projects (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  title text not null check(length(trim(title)) between 1 and 200), description text not null default '',
  status text not null default 'active' check(status in ('active','paused','completed')),
  color text not null default 'purple' check(color in ('purple','green','orange','blue')),
  due_date date, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,id)
);
create table public.tasks (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  title text not null check(length(trim(title)) between 1 and 200),
  status text not null default 'todo' check(status in ('todo','in_progress','done')),
  priority text not null default 'medium' check(priority in ('low','medium','high')),
  due_date date, project_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id)
);
create table public.calendar_events (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  title text not null check(length(trim(title)) between 1 and 200), starts_at timestamptz not null,
  ends_at timestamptz not null, location text not null default '', project_id uuid,
  color text not null default 'purple' check(color in ('purple','green','orange','blue')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(ends_at > starts_at), foreign key(workspace_id,project_id) references public.projects(workspace_id,id)
);
create table public.notes (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  title text not null check(length(trim(title)) between 1 and 200), body text not null default '', project_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id)
);
create index notes_search_idx on public.notes using gin (to_tsvector('english', title || ' ' || body));
create table public.goals (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  title text not null check(length(trim(title)) between 1 and 200), target numeric(14,2) not null check(target > 0),
  current numeric(14,2) not null default 0 check(current >= 0), unit text not null default '', due_date date,
  color text not null default 'purple' check(color in ('purple','green','orange','blue')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.accounts (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  name text not null check(length(trim(name)) between 1 and 100), currency text not null default 'INR' check(currency ~ '^[A-Z]{3}$'),
  opening_balance numeric(14,2) not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id), check(visibility = 'private')
);
create table public.transactions (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  account_id uuid not null, title text not null check(length(trim(title)) between 1 and 200),
  amount numeric(14,2) not null check(amount > 0), kind text not null check(kind in ('income','expense','transfer_in','transfer_out')),
  category text not null default 'Other', booked_on date not null default current_date,
  transfer_id uuid, project_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,account_id) references public.accounts(workspace_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id),
  check((kind in ('transfer_in','transfer_out')) = (transfer_id is not null)), unique(transfer_id,kind)
);

-- Generic foundational metadata still has explicit ownership and referential integrity.
create table public.categories (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  name text not null, domain text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.tags (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  name text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.entity_tags (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private',
  tag_id uuid not null, project_id uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,tag_id) references public.tags(workspace_id,id),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id), unique(tag_id,project_id)
);
create table public.attachments (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  project_id uuid, name text not null, object_path text not null unique, mime_type text not null, size_bytes bigint not null check(size_bytes between 0 and 10485760),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,project_id) references public.projects(workspace_id,id),
  check(split_part(object_path,'/',1) = owner_id::text and split_part(object_path,'/',2) = workspace_id::text)
);
create table public.reminders (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  title text not null, due_at timestamptz not null, delivered_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  title text not null, reminder_id uuid unique references public.reminders(id) on delete cascade, read_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.activity_logs (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  title text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.app_settings (
  id uuid primary key references public.profiles(id) on delete cascade,
  dashboard_widgets text[] not null default array['tasks','calendar','finance','projects','goals','activity'],
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create function private.touch_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end; $$;

-- Avoid cross-workspace and inaccessible links, including writes that exploit an otherwise valid FK.
create function private.validate_links() returns trigger language plpgsql security definer set search_path = '' as $$
declare ref uuid;
begin
  if new.project_id is not null and not exists(
    select 1 from public.projects p where p.id = new.project_id and p.workspace_id = new.workspace_id
    and private.can_read(p.workspace_id,p.owner_id,p.visibility)
    and (new.visibility = 'private' or p.visibility = 'workspace')
  ) then raise exception 'Project is inaccessible or private'; end if;
  if tg_table_name = 'entity_tags' then
    ref := new.tag_id;
    if not exists(select 1 from public.tags t where t.id = ref and t.workspace_id = new.workspace_id and private.can_read(t.workspace_id,t.owner_id,t.visibility)
      and (new.visibility = 'private' or t.visibility = 'workspace')) then raise exception 'Tag is inaccessible'; end if;
  end if;
  return new;
end; $$;

do $$ declare t text; begin
  foreach t in array array['projects','tasks','calendar_events','notes','goals','accounts','transactions','categories','tags','entity_tags','attachments','reminders','notifications','activity_logs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create index %I on public.%I (workspace_id, owner_id, created_at desc)',t||'_workspace_idx',t);
    execute format('create policy record_read on public.%I for select to authenticated using (private.can_read(workspace_id,owner_id,visibility))',t);
    execute format('create policy record_insert on public.%I for insert to authenticated with check (owner_id = (select auth.uid()) and private.can_write(workspace_id))',t);
    execute format('create policy record_update on public.%I for update to authenticated using (private.can_edit(workspace_id,owner_id,visibility)) with check (private.can_edit(workspace_id,owner_id,visibility))',t);
    execute format('create policy record_delete on public.%I for delete to authenticated using (private.can_edit(workspace_id,owner_id,visibility))',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select, insert, delete on public.%I to authenticated',t);
  end loop;
  foreach t in array array['tasks','calendar_events','notes','transactions','entity_tags','attachments'] loop
    execute format('create trigger validate_links before insert or update on public.%I for each row execute function private.validate_links()',t);
  end loop;
  foreach t in array array['profiles','workspaces','workspace_members','app_settings'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
  end loop;
end; $$;
create policy own_profile on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy own_profile_update on public.profiles for update to authenticated using (id = (select auth.uid())) with check(id = (select auth.uid()));
grant update(display_name,currency,timezone) on public.profiles to authenticated;
create policy workspace_read on public.workspaces for select to authenticated using (private.is_member(id));
create policy workspace_update on public.workspaces for update to authenticated using (private.is_owner(id)) with check(private.is_owner(id));
grant update(name,kind) on public.workspaces to authenticated;
create policy members_read on public.workspace_members for select to authenticated using (private.is_member(workspace_id));
create policy own_settings on public.app_settings for all to authenticated using(id = (select auth.uid())) with check(id = (select auth.uid()));
grant insert on public.app_settings to authenticated;
-- PostgREST upserts SET the primary key; RLS constrains it to auth.uid().
grant update(id,dashboard_widgets) on public.app_settings to authenticated;

grant update(title,description,status,color,due_date,visibility) on public.projects to authenticated;
grant update(title,status,priority,due_date,project_id,visibility) on public.tasks to authenticated;
grant update(title,starts_at,ends_at,location,project_id,color,visibility) on public.calendar_events to authenticated;
grant update(title,body,project_id,visibility) on public.notes to authenticated;
grant update(title,target,current,unit,due_date,color,visibility) on public.goals to authenticated;
grant update(name) on public.accounts to authenticated;
grant update(name,domain,visibility) on public.categories to authenticated;
grant update(name,visibility) on public.tags to authenticated;
grant update(title,due_at) on public.reminders to authenticated;
grant update(read_at) on public.notifications to authenticated;
-- Audit rows, notification creation and ledger mutations are server-owned.
revoke insert,delete on public.notifications,public.activity_logs,public.transactions from authenticated;
revoke delete on public.accounts from authenticated;

create function public.record_transaction(w uuid, account uuid, transaction_title text, transaction_amount numeric, transaction_kind text, transaction_category text default 'Other', transaction_date date default current_date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare result uuid;
begin
  if transaction_kind not in ('income','expense') or transaction_amount <> round(transaction_amount,2) then raise exception 'Invalid transaction'; end if;
  if not exists(select 1 from public.accounts a where a.id = account and a.workspace_id = w and a.owner_id = auth.uid() and private.can_write(w)) then raise exception 'Account owner required'; end if;
  insert into public.transactions(workspace_id,account_id,owner_id,title,amount,kind,category,booked_on)
    values(w,account,auth.uid(),transaction_title,transaction_amount,transaction_kind,transaction_category,transaction_date) returning id into result;
  return result;
end; $$;
create function public.transfer_funds(w uuid, source_account uuid, destination_account uuid, transfer_amount numeric, request_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.accounts; d public.accounts;
begin
  if auth.uid() is null or not private.can_write(w) or source_account = destination_account or transfer_amount is null or transfer_amount <= 0 or transfer_amount <> round(transfer_amount,2) or request_id is null then raise exception 'Invalid transfer'; end if;
  perform 1 from public.accounts where id in (source_account,destination_account) order by id for update;
  select * into s from public.accounts where id = source_account and workspace_id = w and owner_id = auth.uid();
  select * into d from public.accounts where id = destination_account and workspace_id = w and owner_id = auth.uid();
  if s.id is null or d.id is null or s.currency <> d.currency then raise exception 'Accounts must be owned by caller, in same workspace and currency'; end if;
  if exists(select 1 from public.transactions where transfer_id = request_id) then
    if (select count(*) from public.transactions where transfer_id = request_id and workspace_id = w and owner_id = auth.uid() and amount = transfer_amount and ((account_id = source_account and kind = 'transfer_out') or (account_id = destination_account and kind = 'transfer_in'))) = 2 then return;
    else raise exception 'Idempotency key reused with different transfer'; end if;
  end if;
  insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,transfer_id) values
    (w,auth.uid(),source_account,'Account transfer',transfer_amount,'transfer_out',request_id),
    (w,auth.uid(),destination_account,'Account transfer',transfer_amount,'transfer_in',request_id);
end; $$;

create function private.log_activity() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.activity_logs(workspace_id,owner_id,title) values(new.workspace_id,new.owner_id,case tg_op when 'INSERT' then 'Created ' else 'Updated ' end || replace(tg_table_name,'_',' ') || ': ' || new.title);
  return new;
end; $$;
do $$ declare t text; begin
  foreach t in array array['tasks','projects','notes','goals','calendar_events','transactions'] loop
    execute format('create trigger log_activity after insert or update on public.%I for each row execute function private.log_activity()',t);
  end loop;
end; $$;

-- Idempotent in-app delivery. Optional email delivery should use an outbox and provider idempotency keys.
create function public.deliver_due_reminders() returns integer language plpgsql security definer set search_path = '' as $$
declare total integer;
begin
  insert into public.notifications(workspace_id,owner_id,title,reminder_id)
    select r.workspace_id,r.owner_id,r.title,r.id from public.reminders r
    where r.due_at <= now() and r.delivered_at is null
    and exists(select 1 from public.workspace_members m where m.workspace_id=r.workspace_id and m.user_id=r.owner_id)
    on conflict(reminder_id) do nothing;
  get diagnostics total = row_count;
  update public.reminders r set delivered_at = now() where delivered_at is null and exists(select 1 from public.notifications n where n.reminder_id = r.id);
  return total;
end; $$;
-- Keep Supabase platform functions and any unrelated application functions unchanged.
revoke all on function public.create_workspace(text,public.workspace_kind), public.set_workspace_member(uuid,uuid,public.member_role), public.remove_workspace_member(uuid,uuid), public.record_transaction(uuid,uuid,text,numeric,text,text,date), public.transfer_funds(uuid,uuid,uuid,numeric,uuid), public.deliver_due_reminders() from public,anon,authenticated;
revoke all on function private.new_profile(), private.touch_updated_at(), private.validate_links(), private.log_activity() from public,anon,authenticated;
grant execute on function public.create_workspace(text,public.workspace_kind), public.set_workspace_member(uuid,uuid,public.member_role), public.remove_workspace_member(uuid,uuid), public.record_transaction(uuid,uuid,text,numeric,text,text,date), public.transfer_funds(uuid,uuid,uuid,numeric,uuid) to authenticated;
grant execute on function public.deliver_due_reminders() to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
  ('personal-documents','personal-documents',false,10485760,array['application/pdf','image/jpeg','image/png','text/plain']),
  ('financial-receipts','financial-receipts',false,10485760,array['application/pdf','image/jpeg','image/png'])
on conflict(id) do nothing;
create policy private_storage_read on storage.objects for select to authenticated using (
  bucket_id in ('personal-documents','financial-receipts') and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists(select 1 from public.workspace_members m where m.user_id = (select auth.uid()) and m.workspace_id::text = (storage.foldername(name))[2])
);
create policy private_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id in ('personal-documents','financial-receipts') and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists(select 1 from public.workspace_members m where m.user_id = (select auth.uid()) and m.role in ('owner','editor') and m.workspace_id::text = (storage.foldername(name))[2])
);
create policy private_storage_delete on storage.objects for delete to authenticated using (
  bucket_id in ('personal-documents','financial-receipts') and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists(select 1 from public.workspace_members m where m.user_id = (select auth.uid()) and m.role in ('owner','editor') and m.workspace_id::text = (storage.foldername(name))[2])
);
