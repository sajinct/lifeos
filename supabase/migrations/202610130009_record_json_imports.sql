-- Portable source IDs are private mappings, not destination IDs or sharing grants.
create table public.record_json_batches(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),payload jsonb not null,result jsonb not null,created_at timestamptz not null default now()
);
create table public.record_json_links(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),record_kind text not null check(record_kind in('project','task','note')),source_id text not null check(length(trim(source_id)) between 1 and 200),
 project_id uuid references public.projects(id) on delete set null,task_id uuid references public.tasks(id) on delete set null,note_id uuid references public.notes(id) on delete set null,details jsonb not null,created_at timestamptz not null default now(),
 unique(workspace_id,owner_id,record_kind,source_id),check((record_kind='project' and task_id is null and note_id is null) or (record_kind='task' and project_id is null and note_id is null) or (record_kind='note' and project_id is null and task_id is null))
);
do $$ declare t text;begin foreach t in array array['record_json_batches','record_json_links'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('create policy own_record_import_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
 execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);
 end loop;end $$;
create function public.import_record_json(entry uuid,w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.record_json_batches;l public.record_json_links;m jsonb;r jsonb;targets jsonb:='{}';source text;kind text;project uuid;destination uuid;due date;details jsonb;answer jsonb;t public.tasks;n public.notes;
 tasks_added integer:=0;notes_added integer:=0;skipped integer:=0;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,37));select * into b from public.record_json_batches where id=entry;
 if found then if b.owner_id is distinct from auth.uid() or b.workspace_id is distinct from w or b.payload is distinct from payload then raise exception 'Record import request reused';end if;return b.result;end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,15));
 if payload is null or jsonb_typeof(payload)<>'object' or (select count(*)from jsonb_object_keys(payload))<>2 or not payload ?& array['projects','rows'] then raise exception 'Invalid record import payload';end if;
 if jsonb_typeof(payload->'projects')<>'array' or jsonb_typeof(payload->'rows')<>'array' then raise exception 'Invalid import arrays';end if;
 if jsonb_array_length(payload->'projects')>50 or jsonb_array_length(payload->'rows') not between 1 and 500 or octet_length(payload::text)>5242880 then raise exception 'Import 1 to 500 records and up to 50 projects, below 5 MiB';end if;
 if (select count(distinct value->>'source_id')from jsonb_array_elements(payload->'projects'))<>jsonb_array_length(payload->'projects') or (select count(distinct jsonb_build_array(value->>'kind',value->>'source_id'))from jsonb_array_elements(payload->'rows'))<>jsonb_array_length(payload->'rows') then raise exception 'Source IDs must be unique per kind';end if;
 perform 1 from public.projects where id in(select (value->>'target_id')::uuid from jsonb_array_elements(payload->'projects')) order by id for share;
 for m in select value from jsonb_array_elements(payload->'projects') loop
  if jsonb_typeof(m)<>'object' or (select count(*)from jsonb_object_keys(m))<>2 or not m ?& array['source_id','target_id'] or jsonb_typeof(m->'source_id')<>'string' or jsonb_typeof(m->'target_id') not in('string','null') then raise exception 'Invalid project mapping';end if;
  source:=m->>'source_id';project:=(m->>'target_id')::uuid;
  if length(trim(source)) not between 1 and 200 or source<>trim(source) then raise exception 'Invalid project source ID';end if;
  if project is not null and not exists(select 1 from public.projects p where p.id=project and p.workspace_id=w and private.can_read(p.workspace_id,p.owner_id,p.visibility)) then raise exception 'Project is inaccessible';end if;
  select * into l from public.record_json_links where workspace_id=w and owner_id=auth.uid() and record_kind='project' and source_id=source;
  if found then if l.details->>'target_id' is distinct from project::text then raise exception 'Project source already has a saved mapping';end if;
  else insert into public.record_json_links(workspace_id,owner_id,record_kind,source_id,project_id,details)values(w,auth.uid(),'project',source,project,jsonb_build_object('target_id',project));end if;
  targets:=targets||jsonb_build_object(source,project);
 end loop;
 for r in select value from jsonb_array_elements(payload->'rows') loop
  if jsonb_typeof(r)<>'object' or (select count(*)from jsonb_object_keys(r))<>8 or not r ?& array['kind','source_id','project_source','title','status','priority','due_date','body'] then raise exception 'Invalid record columns';end if;
  if exists(select 1 from jsonb_each(r) where (key in('kind','source_id','title') and jsonb_typeof(value)<>'string') or (key in('project_source','status','priority','due_date','body') and jsonb_typeof(value) not in('string','null'))) then raise exception 'Invalid record field types';end if;
  source:=r->>'source_id';kind:=r->>'kind';project:=null;due:=null;
  if length(trim(source)) not between 1 and 200 or source<>trim(source) or length(trim(r->>'title')) not between 1 and 200 or kind not in('task','note') then raise exception 'Check source ID, title and record kind';end if;
  if r->>'project_source' is not null then
   if not targets ? (r->>'project_source') then raise exception 'Choose a project mapping or explicitly unlink';end if;project:=(targets->>(r->>'project_source'))::uuid;
  end if;
  if kind='task' then
   if r->>'status' is null or r->>'status' not in('todo','in_progress','done') or r->>'priority' is null or r->>'priority' not in('low','medium','high') or r->>'body' is not null then raise exception 'Check task status and priority';end if;
   if r->>'due_date' is not null then if r->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Use an ISO due date';end if;due:=(r->>'due_date')::date;if due not between '1900-01-01' and '2100-12-31' then raise exception 'Due date must be from 1900 to 2100';end if;end if;
  else if r->>'body' is null or length(r->>'body')>100000 or r->>'status' is not null or r->>'priority' is not null or r->>'due_date' is not null then raise exception 'Check note content; at most 100000 characters';end if;end if;
  r:=r||jsonb_build_object('title',trim(r->>'title'));
  details:=jsonb_build_object('project_source',r->>'project_source','project_id',project,'title',r->>'title','status',r->>'status','priority',r->>'priority','due_date',due,'body',r->>'body');
  select * into l from public.record_json_links where workspace_id=w and owner_id=auth.uid() and record_kind=kind and source_id=source;
  if found then if l.details<>details then raise exception 'Record source ID contents changed';end if;skipped:=skipped+1;continue;end if;
  destination:=null;
  if kind='task' then
   if source ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select * into t from public.tasks where id=source::uuid and workspace_id=w and owner_id=auth.uid() and visibility='private' for update;
    if found and (trim(t.title) is distinct from r->>'title' or t.status is distinct from r->>'status' or t.priority is distinct from r->>'priority' or t.due_date is distinct from due or t.project_id is distinct from project or t.list_id is not null or t.series_id is not null or t.assignee_id is not null) then raise exception 'Existing task source ID identifies different content or structure';end if;
   end if;
   select id into destination from public.tasks where workspace_id=w and owner_id=auth.uid() and visibility='private' and trim(title)=r->>'title' and status=r->>'status' and priority=r->>'priority' and due_date is not distinct from due and project_id is not distinct from project and list_id is null and series_id is null and assignee_id is null order by created_at,id limit 1 for update;
   if destination is null then insert into public.tasks(workspace_id,owner_id,visibility,title,status,priority,due_date,project_id)values(w,auth.uid(),'private',r->>'title',r->>'status',r->>'priority',due,project)returning id into destination;tasks_added:=tasks_added+1;else skipped:=skipped+1;end if;
   insert into public.record_json_links(workspace_id,owner_id,record_kind,source_id,task_id,details)values(w,auth.uid(),kind,source,destination,details);
  else
   if source ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select * into n from public.notes where id=source::uuid and workspace_id=w and owner_id=auth.uid() and visibility='private' for update;
    if found and (trim(n.title) is distinct from r->>'title' or n.body is distinct from r->>'body' or n.project_id is distinct from project) then raise exception 'Existing note source ID identifies different content';end if;
   end if;
   select id into destination from public.notes where workspace_id=w and owner_id=auth.uid() and visibility='private' and trim(title)=r->>'title' and body=r->>'body' and project_id is not distinct from project order by created_at,id limit 1 for update;
   if destination is null then insert into public.notes(workspace_id,owner_id,visibility,title,body,project_id)values(w,auth.uid(),'private',r->>'title',r->>'body',project)returning id into destination;notes_added:=notes_added+1;else skipped:=skipped+1;end if;
   insert into public.record_json_links(workspace_id,owner_id,record_kind,source_id,note_id,details)values(w,auth.uid(),kind,source,destination,details);
  end if;
 end loop;
 answer:=jsonb_build_object('tasks_imported',tasks_added,'notes_imported',notes_added,'skipped',skipped);
 insert into public.record_json_batches(id,workspace_id,owner_id,payload,result)values(entry,w,auth.uid(),payload,answer);return answer;
end $$;
revoke all on function public.import_record_json(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_record_json(uuid,uuid,jsonb) to authenticated;
