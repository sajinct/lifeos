-- Assignment does not confer task access. Directory exposes only current member display names.
alter table public.tasks add column assignee_id uuid,
 add check(assignee_id is null or visibility='workspace'),
 add foreign key(workspace_id,assignee_id) references public.workspace_members(workspace_id,user_id) on delete set null(assignee_id);
create function private.clear_private_assignment() returns trigger language plpgsql set search_path='' as $$
begin if new.visibility='private' then new.assignee_id:=null;end if;return new;end $$;
create trigger clear_private_assignment before insert or update on public.tasks for each row execute function private.clear_private_assignment();
revoke all on function private.clear_private_assignment() from public;
create function public.workspace_task_members(w uuid) returns table(user_id uuid,display_name text,role public.member_role) language sql stable security definer set search_path='' as $$
 select m.user_id,p.display_name,m.role from public.workspace_members m join public.profiles p on p.id=m.user_id
 where m.workspace_id=w and auth.uid() is not null and private.is_member(w) order by m.user_id
$$;
create function public.assign_workspace_task(entry uuid,expected_revision integer,assignee uuid) returns void language plpgsql security definer set search_path='' as $$
declare t public.tasks;
begin
 select * into t from public.tasks where id=entry;
 if not found or auth.uid() is null or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(t.workspace_id::text,15));select * into t from public.tasks where id=entry for update;
 if t.id is null or t.visibility<>'workspace' or not private.can_edit(t.workspace_id,t.owner_id,t.visibility) then raise exception 'An editable shared task is required';end if;
 if assignee is not null and not exists(select 1 from public.workspace_members where workspace_id=t.workspace_id and user_id=assignee) then raise exception 'Choose a current workspace member';end if;
 if t.assignee_id is not distinct from assignee then return;end if;
 if expected_revision is null or t.revision<>expected_revision then raise exception 'Task changed; refresh and try again';end if;
 update public.tasks set assignee_id=assignee where id=entry;
end $$;
create table public.task_time_entries (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),task_id uuid,
 task_title text not null,project_id uuid,project_title text not null default '',
 mode text not null check(mode in ('manual','timer')),status text not null check(status in ('running','recorded','void')),
 logged_on date not null check(logged_on between '1900-01-01' and '2100-12-31'),seconds integer not null check(seconds between 0 and 86400),
 started_at timestamptz,ended_at timestamptz,notes text not null default '' check(length(notes)<=2000),revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,task_id) references public.tasks(workspace_id,id) on delete set null(task_id),
 check((mode='manual' and status<>'running' and started_at is null and ended_at is null and seconds>0)
 or (mode='timer' and started_at is not null and ((status='running' and ended_at is null and seconds=0) or (status<>'running' and ended_at>=started_at and seconds>0))))
);
create unique index task_time_one_running on public.task_time_entries(owner_id,workspace_id) where status='running';
create index on public.task_time_entries(workspace_id,owner_id,created_at,id);
alter table public.task_time_entries enable row level security;
revoke all on public.task_time_entries from anon,authenticated;
grant select on public.task_time_entries to authenticated;
create policy own_time_read on public.task_time_entries for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id));
create trigger touch_updated_at before update on public.task_time_entries for each row execute function private.touch_updated_at();
create function public.save_manual_task_time(entry uuid,w uuid,expected_revision integer,parent uuid,work_day date,duration_seconds integer,entry_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.task_time_entries;t public.tasks;project_name text;
begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,16));select * into r from public.task_time_entries where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id<>auth.uid() or r.mode<>'manual' or r.task_id is distinct from parent then raise exception 'Time entry is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.status<>'recorded' or r.revision<>expected_revision then raise exception 'Time entry changed; refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Time entry is inaccessible';end if;
 if work_day is null or work_day not between '1900-01-01' and least(private.finance_today(auth.uid()),'2100-12-31'::date) or duration_seconds is null or duration_seconds not between 1 and 86400 or entry_notes is null or length(entry_notes)>2000 then raise exception 'Choose a past or current date, up to 24 hours and notes up to 2000 characters';end if;
 if r.id is null then
  select * into t from public.tasks where id=parent and workspace_id=w for update;
  if not found or not private.can_read(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
  select title into project_name from public.projects p where p.id=t.project_id and p.workspace_id=w and private.can_read(p.workspace_id,p.owner_id,p.visibility);
  insert into public.task_time_entries(id,workspace_id,owner_id,task_id,task_title,project_id,project_title,mode,status,logged_on,seconds,notes)
  values(entry,w,auth.uid(),t.id,t.title,case when project_name is null then null else t.project_id end,coalesce(project_name,''),'manual','recorded',work_day,duration_seconds,trim(entry_notes));
 else update public.task_time_entries set logged_on=work_day,seconds=duration_seconds,notes=trim(entry_notes),revision=revision+1 where id=entry;end if;
 return entry;
end $$;
create function public.start_task_timer(entry uuid,w uuid,parent uuid,entry_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.task_time_entries;t public.tasks;project_name text;day date;
begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,16));select * into r from public.task_time_entries where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id<>auth.uid() or r.mode<>'timer' or r.task_id is distinct from parent then raise exception 'Time entry is inaccessible';end if;return entry;
 end if;
 if exists(select 1 from public.task_time_entries where workspace_id=w and owner_id=auth.uid() and status='running') then raise exception 'Stop the running timer in this workspace first';end if;
 if entry_notes is null or length(entry_notes)>2000 then raise exception 'Notes must be at most 2000 characters';end if;
 day:=private.finance_today(auth.uid());if day not between '1900-01-01' and '2100-12-31' then raise exception 'Work date is outside the supported range';end if;
 select * into t from public.tasks where id=parent and workspace_id=w for update;
 if not found or not private.can_read(t.workspace_id,t.owner_id,t.visibility) then raise exception 'Task is inaccessible';end if;
 select title into project_name from public.projects p where p.id=t.project_id and p.workspace_id=w and private.can_read(p.workspace_id,p.owner_id,p.visibility);
 insert into public.task_time_entries(id,workspace_id,owner_id,task_id,task_title,project_id,project_title,mode,status,logged_on,seconds,started_at,notes)
 values(entry,w,auth.uid(),t.id,t.title,case when project_name is null then null else t.project_id end,coalesce(project_name,''),'timer','running',day,0,clock_timestamp(),trim(entry_notes));
 return entry;
end $$;
create function public.act_on_task_time(entry uuid,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$
declare r public.task_time_entries;duration integer;target text;
begin
 if auth.uid() is null then raise exception 'Sign in required';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,16));select * into r from public.task_time_entries where id=entry for update;
 if not found or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Time entry is inaccessible';end if;
 if action is null or action not in ('stop','void','restore') or (action='stop' and r.mode<>'timer') then raise exception 'Choose stop, void or restore';end if;
 target:=case when action='void' then 'void' else 'recorded' end;
 if r.status=target then return;end if;
 if expected_revision is null or r.revision<>expected_revision then raise exception 'Time entry changed; refresh and try again';end if;
 if (action='stop' and r.status<>'running') or (action='restore' and r.status<>'void') then raise exception 'Time entry changed; refresh and try again';end if;
 duration:=case when r.status='running' then greatest(1,least(86400,floor(extract(epoch from clock_timestamp()-r.started_at)))::integer) else r.seconds end;
 update public.task_time_entries set status=target,seconds=duration,ended_at=case when r.status='running' then r.started_at+make_interval(secs=>duration) else r.ended_at end,revision=revision+1 where id=entry;
end $$;
revoke all on function public.workspace_task_members(uuid),public.assign_workspace_task(uuid,integer,uuid),public.save_manual_task_time(uuid,uuid,integer,uuid,date,integer,text),public.start_task_timer(uuid,uuid,uuid,text),public.act_on_task_time(uuid,integer,text) from public,anon;
grant execute on function public.workspace_task_members(uuid),public.assign_workspace_task(uuid,integer,uuid),public.save_manual_task_time(uuid,uuid,integer,uuid,date,integer,text),public.start_task_timer(uuid,uuid,uuid,text),public.act_on_task_time(uuid,integer,text) to authenticated;
