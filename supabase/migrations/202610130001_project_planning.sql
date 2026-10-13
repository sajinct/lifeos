alter table public.projects add column revision integer not null default 1 check(revision>0);
revoke insert on public.projects from authenticated;
grant insert(id,workspace_id,owner_id,visibility,title,description,status,color,due_date,created_at,updated_at) on public.projects to authenticated;
create function private.project_planning_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.revision:=old.revision+1;
 if old.visibility='workspace' and new.visibility='private' and (
  exists(select 1 from public.tasks where project_id=old.id and visibility='workspace') or
  exists(select 1 from public.calendar_events where project_id=old.id and visibility='workspace') or
  exists(select 1 from public.notes where project_id=old.id and visibility='workspace')
 ) then raise exception 'Keep this project shared while shared tasks, events or notes link to it';end if;
 return new;
end $$;
create trigger project_planning_guard before update on public.projects for each row execute function private.project_planning_guard();
revoke all on function private.project_planning_guard() from public;
-- Serialize existing task/event/note links against project visibility changes.
create or replace function private.validate_links() returns trigger language plpgsql security definer set search_path='' as $$
declare ref uuid;p public.projects;
begin
 if new.project_id is not null then
  select * into p from public.projects where id=new.project_id and workspace_id=new.workspace_id for share;
  if not found or not private.can_read(p.workspace_id,p.owner_id,p.visibility) or (new.visibility<>'private' and p.visibility<>'workspace') then raise exception 'Project is inaccessible or private';end if;
 end if;
 if tg_table_name='entity_tags' then
  ref:=new.tag_id;
  if not exists(select 1 from public.tags t where t.id=ref and t.workspace_id=new.workspace_id and private.can_read(t.workspace_id,t.owner_id,t.visibility) and (new.visibility='private' or t.visibility='workspace')) then raise exception 'Tag is inaccessible';end if;
 end if;
 return new;
end $$;
create table public.project_milestones (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private',project_id uuid not null,
 title text not null check(length(trim(title)) between 1 and 200),due_on date check(due_on between '1900-01-01' and '2100-12-31'),notes text not null default '' check(length(notes)<=2000),
 done boolean not null default false,completed_on date,archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),check(done=(completed_on is not null)),
 foreign key(workspace_id,project_id) references public.projects(workspace_id,id)
);
create table public.project_budgets (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),project_id uuid not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),amount numeric(14,2) not null check(amount>0 and amount<'1000000000000'::numeric),
 archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,project_id) references public.projects(workspace_id,id),unique(workspace_id,owner_id,project_id,currency)
);
do $$ declare t text;begin
 foreach t in array array['project_milestones','project_budgets'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);
  execute format('create index on public.%I(project_id)',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create policy milestone_parent_read on public.project_milestones for select to authenticated using(exists(select 1 from public.projects p where p.id=project_id and p.workspace_id=project_milestones.workspace_id and private.can_read(p.workspace_id,p.owner_id,p.visibility)));
create policy own_project_budget_read on public.project_budgets for select to authenticated using(owner_id=auth.uid() and exists(select 1 from public.projects p where p.id=project_id and p.workspace_id=project_budgets.workspace_id and private.can_read(p.workspace_id,p.owner_id,p.visibility)));
create function public.save_planned_project(entry uuid,w uuid,expected_revision integer,project_title text,project_description text,project_status text,project_color text,deadline date,sharing public.record_visibility) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.projects;
begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,17));select * into p from public.projects where id=entry for update;
 if found then
  if p.workspace_id<>w or not private.can_edit(p.workspace_id,p.owner_id,p.visibility) then raise exception 'Project is inaccessible';end if;
  if expected_revision is null then if p.owner_id<>auth.uid() then raise exception 'Project is inaccessible';end if;return entry;end if;
  if p.revision<>expected_revision then raise exception 'Project changed; refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Project is inaccessible';end if;
 if project_title is null or length(trim(project_title)) not between 1 and 200 or project_description is null or length(project_description)>4000 or project_status is null or project_status not in ('active','paused','completed') or project_color is null or project_color not in ('purple','green','orange','blue') or sharing is null or (deadline is not null and deadline not between '1900-01-01' and '2100-12-31') then raise exception 'Enter a valid title, date, status and description up to 4000 characters';end if;
 if p.id is null then insert into public.projects(id,workspace_id,owner_id,title,description,status,color,due_date,visibility) values(entry,w,auth.uid(),trim(project_title),trim(project_description),project_status,project_color,deadline,sharing);
 else update public.projects set title=trim(project_title),description=trim(project_description),status=project_status,color=project_color,due_date=deadline,visibility=sharing where id=entry;end if;return entry;
end $$;
create function public.save_project_milestone(entry uuid,w uuid,expected_revision integer,parent uuid,milestone_title text,deadline date,milestone_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.projects;r public.project_milestones;
begin
 perform pg_advisory_xact_lock(hashtextextended(parent::text,17));select * into p from public.projects where id=parent and workspace_id=w for update;
 if not found or auth.uid() is null or not private.can_edit(p.workspace_id,p.owner_id,p.visibility) then raise exception 'Project is inaccessible';end if;
 if p.status='completed' then raise exception 'Reopen the project before editing milestones';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,18));select * into r from public.project_milestones where id=entry for update;
 if found then
  if r.project_id<>parent or r.workspace_id<>w then raise exception 'Milestone is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Milestone changed; restore or refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Milestone is inaccessible';end if;
 if milestone_title is null or length(trim(milestone_title)) not between 1 and 200 or milestone_notes is null or length(milestone_notes)>2000 or (deadline is not null and deadline not between '1900-01-01' and '2100-12-31') then raise exception 'Enter a title, valid date and notes up to 2000 characters';end if;
 if r.id is null then insert into public.project_milestones(id,workspace_id,owner_id,project_id,title,due_on,notes) values(entry,w,p.owner_id,parent,trim(milestone_title),deadline,trim(milestone_notes));
 else update public.project_milestones set title=trim(milestone_title),due_on=deadline,notes=trim(milestone_notes),revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.act_on_project_milestone(entry uuid,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$
declare p public.projects;r public.project_milestones;parent uuid;done_value boolean;archive_value boolean;
begin
 select project_id into parent from public.project_milestones where id=entry;
 if parent is null then raise exception 'Milestone is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(parent::text,17));select * into p from public.projects where id=parent for update;
 if not found or auth.uid() is null or not private.can_edit(p.workspace_id,p.owner_id,p.visibility) then raise exception 'Project is inaccessible';end if;
 if p.status='completed' then raise exception 'Reopen the project before editing milestones';end if;
 select * into r from public.project_milestones where id=entry for update;
 if r.id is null or action is null or action not in ('complete','reopen','archive','restore') then raise exception 'Choose a valid milestone action';end if;
 done_value:=case when action='complete' then true when action='reopen' then false else r.done end;
 archive_value:=case when action='archive' then true when action='restore' then false else r.archived end;
 if r.done=done_value and r.archived=archive_value then return;end if;
 if expected_revision is null or r.revision<>expected_revision or (r.archived and action in ('complete','reopen')) then raise exception 'Milestone changed; restore or refresh and try again';end if;
 update public.project_milestones set done=done_value,archived=archive_value,completed_on=case when not done_value then null when r.done then r.completed_on else private.finance_today(auth.uid()) end,revision=revision+1 where id=entry;
end $$;
create function public.save_project_budget(entry uuid,w uuid,expected_revision integer,parent uuid,budget_currency text,budget_amount numeric) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.projects;r public.project_budgets;
begin
 perform pg_advisory_xact_lock(hashtextextended(parent::text,17));select * into p from public.projects where id=parent and workspace_id=w for update;
 if not found or auth.uid() is null or not private.can_write(w) or not private.can_read(p.workspace_id,p.owner_id,p.visibility) then raise exception 'Project is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,19));select * into r from public.project_budgets where id=entry for update;
 if found then
  if r.project_id<>parent or r.workspace_id<>w or r.owner_id<>auth.uid() or r.currency is distinct from budget_currency then raise exception 'Budget is inaccessible or currency changed';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Budget changed; restore or refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Budget is inaccessible';end if;
 if budget_currency is null or budget_currency !~ '^[A-Z]{3}$' or budget_amount is null or budget_amount::text in ('NaN','Infinity','-Infinity') or budget_amount<=0 or budget_amount>=1000000000000 or budget_amount<>round(budget_amount,2) then raise exception 'Enter a three-letter currency and positive amount with at most two decimal places';end if;
 if r.id is null then
  if exists(select 1 from public.project_budgets where project_id=parent and owner_id=auth.uid() and currency=budget_currency) then raise exception 'Budget already exists for this currency; edit or restore it';end if;
  insert into public.project_budgets(id,workspace_id,owner_id,project_id,currency,amount) values(entry,w,auth.uid(),parent,budget_currency,budget_amount);
 else update public.project_budgets set amount=budget_amount,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.set_project_budget_archive(entry uuid,expected_revision integer,archived_value boolean) returns void language plpgsql security definer set search_path='' as $$
declare p public.projects;r public.project_budgets;parent uuid;
begin
 select project_id into parent from public.project_budgets where id=entry;perform pg_advisory_xact_lock(hashtextextended(coalesce(parent::text,''),17));select * into p from public.projects where id=parent for update;
 if not found or auth.uid() is null or not private.can_write(p.workspace_id) or not private.can_read(p.workspace_id,p.owner_id,p.visibility) then raise exception 'Project is inaccessible';end if;
 select * into r from public.project_budgets where id=entry for update;
 if r.id is null or r.owner_id<>auth.uid() then raise exception 'Budget is inaccessible';end if;
 if archived_value is null then raise exception 'Choose archive state';end if;
 if r.archived=archived_value then return;end if;
 if expected_revision is null or r.revision<>expected_revision then raise exception 'Budget changed; refresh and try again';end if;
 update public.project_budgets set archived=archived_value,revision=revision+1 where id=entry;
end $$;
create function public.link_project_expense(entry uuid,expected_project uuid,parent uuid) returns void language plpgsql security definer set search_path='' as $$
declare t public.transactions;p public.projects;
begin
 select * into t from public.transactions where id=entry for update;
 if not found or auth.uid() is null or t.owner_id<>auth.uid() or t.kind<>'expense' or not private.can_write(t.workspace_id) then raise exception 'Expense is inaccessible';end if;
 if parent is not null then
  select * into p from public.projects where id=parent and workspace_id=t.workspace_id;
  if not found or not private.can_read(p.workspace_id,p.owner_id,p.visibility) then raise exception 'Project is inaccessible';end if;
 end if;
 if t.project_id is not distinct from parent then return;end if;
 if t.project_id is distinct from expected_project then raise exception 'Expense link changed; refresh and try again';end if;
 update public.transactions set project_id=parent where id=entry;
end $$;
revoke all on function public.save_planned_project(uuid,uuid,integer,text,text,text,text,date,public.record_visibility),public.save_project_milestone(uuid,uuid,integer,uuid,text,date,text),public.act_on_project_milestone(uuid,integer,text),public.save_project_budget(uuid,uuid,integer,uuid,text,numeric),public.set_project_budget_archive(uuid,integer,boolean),public.link_project_expense(uuid,uuid,uuid) from public,anon;
grant execute on function public.save_planned_project(uuid,uuid,integer,text,text,text,text,date,public.record_visibility),public.save_project_milestone(uuid,uuid,integer,uuid,text,date,text),public.act_on_project_milestone(uuid,integer,text),public.save_project_budget(uuid,uuid,integer,uuid,text,numeric),public.set_project_budget_archive(uuid,integer,boolean),public.link_project_expense(uuid,uuid,uuid) to authenticated;
