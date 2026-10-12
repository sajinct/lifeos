-- Task organization is private; checklists inherit the parent task's access.
create table public.task_lists (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id),
 owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
 name text not null check(length(trim(name)) between 1 and 100), archived boolean not null default false,
 revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
create table public.task_series (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id),
 owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private' check(visibility='private'),
 frequency text not null check(frequency in ('daily','weekly','monthly','yearly')),
 anchor_on date not null check(anchor_on between '1900-01-01' and '2100-12-31'), active boolean not null default true,
 revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(workspace_id,id)
);
alter table public.tasks add column revision integer not null default 1 check(revision>0),
 add column list_id uuid, add column series_id uuid, add column occurrence_index integer check(occurrence_index between 0 and 100000),
 add unique(workspace_id,id), add foreign key(workspace_id,list_id) references public.task_lists(workspace_id,id),
 add foreign key(workspace_id,series_id) references public.task_series(workspace_id,id),
 add unique(series_id,occurrence_index), add check((series_id is null)=(occurrence_index is null));
create table public.task_checklist (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id),
 owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private',
 task_id uuid not null, title text not null check(length(trim(title)) between 1 and 200), done boolean not null default false,
 revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(workspace_id,task_id) references public.tasks(workspace_id,id) on delete cascade
);
do $$ declare t text; begin
 foreach t in array array['task_lists','task_series','task_checklist'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create policy task_list_read on public.task_lists for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id));
create policy task_series_read on public.task_series for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id));
create policy task_checklist_read on public.task_checklist for select to authenticated using(exists(select 1 from public.tasks t where t.id=task_id and t.workspace_id=task_checklist.workspace_id and private.can_read(t.workspace_id,t.owner_id,t.visibility)));
create index on public.task_checklist(task_id,created_at,id);
-- Preserve legacy one-off capture, but callers cannot forge series/list/revision fields.
revoke insert on public.tasks from authenticated;
grant insert(id,workspace_id,owner_id,visibility,title,status,priority,due_date,project_id,created_at,updated_at) on public.tasks to authenticated;
revoke update(status) on public.tasks from authenticated;
drop policy record_delete on public.tasks;
create policy record_delete on public.tasks for delete to authenticated using(series_id is null and private.can_edit(workspace_id,owner_id,visibility));
create function private.task_metadata_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then new.revision:=old.revision+1; end if;
 if new.list_id is not null and (new.visibility<>'private' or not exists(select 1 from public.task_lists l where l.id=new.list_id and l.workspace_id=new.workspace_id and l.owner_id=new.owner_id)) then raise exception 'Task list is inaccessible or task is shared'; end if;
 if new.series_id is not null and (new.visibility<>'private' or not exists(select 1 from public.task_series s where s.id=new.series_id and s.workspace_id=new.workspace_id and s.owner_id=new.owner_id and new.due_date=private.recurrence_date(s.anchor_on,s.frequency,new.occurrence_index))) then raise exception 'Recurring task dates and sharing are fixed'; end if;
 return new;
end $$;
create trigger task_metadata_guard before insert or update on public.tasks for each row execute function private.task_metadata_guard();
revoke all on function private.task_metadata_guard() from public;

create function public.save_task_list(entry uuid,w uuid,expected_revision integer,list_name text,is_archived boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.task_lists;
begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,15));
 select * into r from public.task_lists where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id<>auth.uid() then raise exception 'List is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision then raise exception 'List changed; refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'List is inaccessible';end if;
 if list_name is null or length(trim(list_name)) not between 1 and 100 or is_archived is null then raise exception 'Enter a list name of 1–100 characters';end if;
 if r.id is null then insert into public.task_lists(id,workspace_id,owner_id,name,archived)values(entry,w,auth.uid(),trim(list_name),is_archived);
 else update public.task_lists set name=trim(list_name),archived=is_archived,revision=revision+1 where id=entry;end if;
 return entry;
end $$;

create function public.configure_task(entry uuid,expected_revision integer,task_list uuid,repeat_frequency text) returns void language plpgsql security definer set search_path='' as $$
declare t public.tasks;s uuid;
begin
 select * into t from public.tasks where id=entry;
 if not found or auth.uid() is null or t.owner_id<>auth.uid() or not private.can_write(t.workspace_id) or t.visibility<>'private' then raise exception 'A private task you own is required';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.workspace_id::text,15));select * into t from public.tasks where id=entry for update;
 if t.id is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 if expected_revision is null or t.revision<>expected_revision then raise exception 'Task changed; refresh and try again';end if;
 if task_list is not null and not exists(select 1 from public.task_lists l where l.id=task_list and l.workspace_id=t.workspace_id and l.owner_id=auth.uid() and not l.archived) then raise exception 'Choose an active list you own';end if;
 if repeat_frequency is not null then
  if t.series_id is not null or t.status='done' or t.due_date is null or t.due_date not between '1900-01-01' and '2100-12-31' or repeat_frequency not in ('daily','weekly','monthly','yearly') then raise exception 'Use a pending one-off task with a valid due date';end if;
  s:=gen_random_uuid();insert into public.task_series(id,workspace_id,owner_id,frequency,anchor_on)values(s,t.workspace_id,t.owner_id,repeat_frequency,t.due_date);
 end if;
 update public.tasks set list_id=task_list,series_id=coalesce(s,series_id),occurrence_index=case when s is null then occurrence_index else 0 end where id=entry;
end $$;

-- Called only under the workspace advisory lock. At most one successor per occurrence.
create function private.next_task(t public.tasks) returns void language plpgsql security definer set search_path='' as $$
declare s public.task_series;day date;next_id uuid;project uuid;
begin
 if t.series_id is null or t.status<>'done' then return;end if;
 select * into s from public.task_series where id=t.series_id for update;
 if not found or not s.active or not private.can_write(s.workspace_id) or s.owner_id<>auth.uid() then return;end if;
 if exists(select 1 from public.tasks where series_id=s.id and occurrence_index>t.occurrence_index) then return;end if;
 day:=private.recurrence_date(s.anchor_on,s.frequency,t.occurrence_index+1);
 if day>'2100-12-31' or t.occurrence_index>=100000 then update public.task_series set active=false,revision=revision+1 where id=s.id;return;end if;
 next_id:=gen_random_uuid();
 select id into project from public.projects p where p.id=t.project_id and p.workspace_id=t.workspace_id and private.can_read(p.workspace_id,p.owner_id,p.visibility);
 insert into public.tasks(id,workspace_id,owner_id,title,priority,due_date,project_id,list_id,series_id,occurrence_index)
 values(next_id,t.workspace_id,t.owner_id,t.title,t.priority,day,project,t.list_id,s.id,t.occurrence_index+1);
 insert into public.task_checklist(id,workspace_id,owner_id,task_id,title)
 select gen_random_uuid(),workspace_id,owner_id,next_id,title from public.task_checklist where task_id=t.id order by created_at,id;
end $$;
revoke all on function private.next_task(public.tasks) from public;
create function public.set_task_status(entry uuid,expected_revision integer,target text) returns void language plpgsql security definer set search_path='' as $$
declare t public.tasks;
begin
 select * into t from public.tasks where id=entry;
 if not found or auth.uid() is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.workspace_id::text,15));select * into t from public.tasks where id=entry for update;
 if t.id is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 if target is null or target not in ('todo','in_progress','done') then raise exception 'Choose a valid task status';end if;
 if t.status=target then perform private.next_task(t);return;end if;
 if expected_revision is null or t.revision<>expected_revision then raise exception 'Task changed; refresh and try again';end if;
 update public.tasks set status=target where id=entry returning * into t;
 perform private.next_task(t);
end $$;
create function public.set_task_series_active(entry uuid,expected_revision integer,enabled boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.task_series;t public.tasks;
begin
 select * into s from public.task_series where id=entry;
 if not found or auth.uid() is null or s.owner_id<>auth.uid() or not private.can_write(s.workspace_id) then raise exception 'Repeat is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(s.workspace_id::text,15));select * into s from public.task_series where id=entry for update;
 if enabled is null then raise exception 'Choose repeat state';end if;
 if s.active=enabled then return;end if;
 if expected_revision is null or s.revision<>expected_revision then raise exception 'Repeat changed; refresh and try again';end if;
 update public.task_series set active=enabled,revision=revision+1 where id=entry;
 if enabled then select * into t from public.tasks where series_id=entry order by occurrence_index desc limit 1 for update;perform private.next_task(t);end if;
end $$;
create function public.save_task_checklist(entry uuid,parent uuid,expected_revision integer,item_title text,completed boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare t public.tasks;r public.task_checklist;
begin
 select * into t from public.tasks where id=parent;
 if not found or auth.uid() is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.workspace_id::text,15));select * into t from public.tasks where id=parent for update;
 if t.id is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 if t.status='done' then raise exception 'Reopen the task before editing its checklist';end if;
 select * into r from public.task_checklist where id=entry for update;
 if found then
  if r.task_id<>parent or r.workspace_id<>t.workspace_id then raise exception 'Checklist item is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.title=trim(item_title) and r.done=completed then return entry;end if;
  if r.revision<>expected_revision then raise exception 'Checklist changed; refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Checklist item is inaccessible';end if;
 if item_title is null or length(trim(item_title)) not between 1 and 200 or completed is null then raise exception 'Enter a checklist title of 1–200 characters';end if;
 if r.id is null then
  if (select count(*) from public.task_checklist where task_id=parent)>=100 then raise exception 'A task can have at most 100 checklist items';end if;
  insert into public.task_checklist(id,workspace_id,owner_id,task_id,title,done)values(entry,t.workspace_id,t.owner_id,parent,trim(item_title),completed);
 else update public.task_checklist set title=trim(item_title),done=completed,revision=revision+1 where id=entry;end if;
 return entry;
end $$;
revoke all on function public.save_task_list(uuid,uuid,integer,text,boolean),public.configure_task(uuid,integer,uuid,text),public.set_task_status(uuid,integer,text),public.set_task_series_active(uuid,integer,boolean),public.save_task_checklist(uuid,uuid,integer,text,boolean) from public,anon;
grant execute on function public.save_task_list(uuid,uuid,integer,text,boolean),public.configure_task(uuid,integer,uuid,text),public.set_task_status(uuid,integer,text),public.set_task_series_active(uuid,integer,boolean),public.save_task_checklist(uuid,uuid,integer,text,boolean) to authenticated;
create function public.remove_task_checklist(entry uuid,expected_revision integer) returns void language plpgsql security definer set search_path='' as $$
declare r public.task_checklist;t public.tasks;
begin
 select * into r from public.task_checklist where id=entry;
 if not found then return;end if;
 select * into t from public.tasks where id=r.task_id;
 if not found or auth.uid() is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.workspace_id::text,15));select * into t from public.tasks where id=r.task_id for update;
 if t.id is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 if t.status='done' then raise exception 'Reopen the task before editing its checklist';end if;
 select * into r from public.task_checklist where id=entry for update;if not found then return;end if;
 if expected_revision is null or r.revision<>expected_revision then raise exception 'Checklist changed; refresh and try again';end if;
 delete from public.task_checklist where id=entry;
end $$;
revoke all on function public.remove_task_checklist(uuid,integer) from public,anon;
grant execute on function public.remove_task_checklist(uuid,integer) to authenticated;
