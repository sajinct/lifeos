-- Notes remain private by default. Journals and file links are owner-private.
alter table public.notes add column revision integer not null default 1 check(revision>0),
 add column tags text[] not null default '{}', add column journal_on date,
 add column archived boolean not null default false,
 add unique(workspace_id,id),
 add check(journal_on is null or (journal_on between '1900-01-01' and '2100-12-31' and visibility='private'));
create unique index note_journal_day on public.notes(workspace_id,owner_id,journal_on) where journal_on is not null;
create index on public.notes(workspace_id,archived,updated_at,id);
revoke insert,delete on public.notes from authenticated;
grant insert(id,workspace_id,owner_id,visibility,title,body,project_id,created_at,updated_at) on public.notes to authenticated;
create table public.note_documents (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 note_id uuid not null,attachment_id uuid not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,note_id) references public.notes(workspace_id,id) on delete cascade,
 foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade,
 unique(note_id,attachment_id)
);
alter table public.note_documents enable row level security;
revoke all on public.note_documents from public,anon,authenticated;
grant select on public.note_documents to authenticated;
create policy own_note_documents on public.note_documents for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id) and exists(select 1 from public.notes n where n.id=note_id and n.workspace_id=note_documents.workspace_id and private.can_read(n.workspace_id,n.owner_id,n.visibility)));
create index on public.note_documents(workspace_id,created_at,id);
create table private.note_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null);
revoke all on private.note_requests from public,anon,authenticated,service_role;
create function private.note_tags(tags text[]) returns text[] language plpgsql immutable set search_path='' as $$
declare normalized text[];begin
 if tags is null or cardinality(tags)>10 or array_ndims(tags)>1 or exists(select 1 from unnest(tags)t where t is null or length(trim(t)) not between 1 and 30 or t~'[[:cntrl:]]') then raise exception 'Use up to ten tags of 1–30 characters';end if;
 select coalesce(array_agg(t order by t),'{}') into normalized from(select distinct lower(regexp_replace(trim(t),'[[:space:]]+',' ','g'))t from unnest(tags)t)q;
 return normalized;
end $$;
create function private.note_metadata_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  new.revision:=old.revision+1;
  if new.visibility<>old.visibility and old.owner_id<>auth.uid() then raise exception 'Only the note creator can change sharing';end if;
 end if;
 if tg_op='INSERT' or new.body is distinct from old.body then
  if length(new.body)>100000 then raise exception 'Note content is limited to 100,000 characters';end if;
 end if;
 new.tags:=private.note_tags(new.tags);return new;
end $$;
create function private.note_direct_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if old.archived and current_user in('authenticated','anon') then raise exception 'Restore the note before editing';end if;
 return new;
end $$;
create trigger note_direct_guard before update on public.notes for each row execute function private.note_direct_guard();
create trigger note_metadata_guard before insert or update on public.notes for each row execute function private.note_metadata_guard();
create function private.note_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.note_requests;begin
 if request is null then raise exception 'A request ID is required';end if;
 select * into r from private.note_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id<>w or r.owner_id<>auth.uid() or r.payload<>payload then raise exception 'Request was already used for another change';end if;
 return true;
end $$;
revoke all on function private.note_tags(text[]),private.note_metadata_guard(),private.note_direct_guard(),private.note_replayed(uuid,uuid,jsonb) from public,anon,authenticated;

create function public.save_note(request uuid,entry uuid,w uuid,expected_revision integer,note_title text,note_body text,linked_project uuid,note_tags text[],journal_date date,sharing public.record_visibility,documents uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare n public.notes;payload jsonb;normalized_tags text[];f uuid;begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,15));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into n from public.notes where id=entry for update;
 if found and (n.workspace_id<>w or not private.can_edit(n.workspace_id,n.owner_id,n.visibility)) then raise exception 'Note is inaccessible';end if;
 payload:=jsonb_build_array('save',entry,expected_revision,note_title,note_body,linked_project,note_tags,journal_date,sharing,documents);
 if private.note_replayed(request,w,payload) then return entry;end if;
 if n.id is null and expected_revision is not null then raise exception 'Note is inaccessible';end if;
 if n.id is not null then
  if expected_revision is null or n.revision<>expected_revision then raise exception 'Note changed; refresh and try again';end if;
  if n.archived then raise exception 'Restore the note before editing';end if;
  if n.owner_id<>auth.uid() and (sharing<>n.visibility or journal_date is distinct from n.journal_on or documents is not null) then raise exception 'Only the note creator can change sharing, journals or documents';end if;
 end if;
 normalized_tags:=private.note_tags(note_tags);
 if note_title is null or length(trim(note_title)) not between 1 and 200 or note_body is null or length(note_body)>100000 or sharing is null or (journal_date is not null and (journal_date not between '1900-01-01' and '2100-12-31' or sharing<>'private')) then raise exception 'Enter valid note details; journals must be private';end if;
 if journal_date is not null and exists(select 1 from public.notes where workspace_id=w and owner_id=coalesce(n.owner_id,auth.uid()) and journal_on=journal_date and id<>entry) then raise exception 'A journal for this date already exists, including archived entries';end if;
 if linked_project is not null then
  perform 1 from public.projects where id=linked_project and workspace_id=w and private.can_read(workspace_id,owner_id,visibility) and (sharing='private' or visibility='workspace') for share;
  if not found then raise exception 'Project is inaccessible or private';end if;
 end if;
 if documents is not null then
  if cardinality(documents)>50 or array_ndims(documents)>1 then raise exception 'Link at most 50 documents';end if;
  for f in select distinct unnest(documents) order by 1 loop
   perform 1 from public.attachments where id=f and workspace_id=w and owner_id=auth.uid() and status in('ready','archived') for share;
   if not found then raise exception 'Choose your own completed document in this workspace';end if;
  end loop;
 end if;
 if n.id is null then
  insert into public.notes(id,workspace_id,owner_id,title,body,project_id,tags,journal_on,visibility)values(entry,w,auth.uid(),trim(note_title),note_body,linked_project,normalized_tags,journal_date,sharing);
 else
  update public.notes set title=trim(note_title),body=note_body,project_id=linked_project,tags=normalized_tags,journal_on=journal_date,visibility=sharing where id=entry;
 end if;
 if documents is not null then
  delete from public.note_documents where note_id=entry and not(attachment_id=any(documents));
  insert into public.note_documents(workspace_id,owner_id,note_id,attachment_id)select w,auth.uid(),entry,q.file_id from(select distinct unnest(documents)file_id)q on conflict(note_id,attachment_id)do nothing;
 end if;
 insert into private.note_requests values(request,w,auth.uid(),payload);return entry;
end $$;
create function public.set_note_archived(request uuid,entry uuid,expected_revision integer,is_archived boolean) returns void language plpgsql security definer set search_path='' as $$
declare n public.notes;payload jsonb;begin
 select * into n from public.notes where id=entry;
 if not found or auth.uid() is null or not private.can_edit(n.workspace_id,n.owner_id,n.visibility) then raise exception 'Note is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(n.workspace_id::text,15));select * into n from public.notes where id=entry for update;
 if n.id is null or not private.can_edit(n.workspace_id,n.owner_id,n.visibility) then raise exception 'Note is inaccessible';end if;
 payload:=jsonb_build_array('archive',entry,expected_revision,is_archived);
 if private.note_replayed(request,n.workspace_id,payload) then return;end if;
 if is_archived is null then raise exception 'Choose archive or restore';end if;
 if expected_revision is null or n.revision<>expected_revision then raise exception 'Note changed; refresh and try again';end if;
 update public.notes set archived=is_archived where id=entry;
 insert into private.note_requests values(request,n.workspace_id,auth.uid(),payload);
end $$;
revoke all on function public.save_note(uuid,uuid,uuid,integer,text,text,uuid,text[],date,public.record_visibility,uuid[]),public.set_note_archived(uuid,uuid,integer,boolean) from public,anon;
grant execute on function public.save_note(uuid,uuid,uuid,integer,text,text,uuid,text[],date,public.record_visibility,uuid[]),public.set_note_archived(uuid,uuid,integer,boolean) to authenticated;

-- Plain note imports never reuse archived, journal, tagged or attached destinations.
create or replace function public.import_record_json(entry uuid,w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.record_json_batches;l public.record_json_links;m jsonb;r jsonb;targets jsonb:='{}';source text;kind text;project uuid;destination uuid;due date;details jsonb;answer jsonb;t public.tasks;n public.notes;e public.calendar_events;start_time timestamptz;end_time timestamptz;
 events_added integer:=0;has_events boolean:=false;tasks_added integer:=0;notes_added integer:=0;skipped integer:=0;
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
  if jsonb_typeof(r)<>'object' or not r ?& array['kind','source_id','project_source','title','status','priority','due_date','body'] or ((r->>'kind'='event') and ((select count(*)from jsonb_object_keys(r))<>12 or not r ?& array['starts_at','ends_at','location','color'])) or ((r->>'kind' is distinct from 'event') and (select count(*)from jsonb_object_keys(r))<>8) then raise exception 'Invalid record columns';end if;
  if exists(select 1 from jsonb_each(r) where (key in('kind','source_id','title','starts_at','ends_at','location','color') and jsonb_typeof(value)<>'string') or (key in('project_source','status','priority','due_date','body') and jsonb_typeof(value) not in('string','null'))) then raise exception 'Invalid record field types';end if;
  source:=r->>'source_id';kind:=r->>'kind';project:=null;due:=null;
  if length(trim(source)) not between 1 and 200 or source<>trim(source) or length(trim(r->>'title')) not between 1 and 200 or kind not in('task','note','event') then raise exception 'Check source ID, title and record kind';end if;
  if r->>'project_source' is not null then
   if not targets ? (r->>'project_source') then raise exception 'Choose a project mapping or explicitly unlink';end if;project:=(targets->>(r->>'project_source'))::uuid;
  end if;
  if kind='task' then
   if r->>'status' is null or r->>'status' not in('todo','in_progress','done') or r->>'priority' is null or r->>'priority' not in('low','medium','high') or r->>'body' is not null then raise exception 'Check task status and priority';end if;
   if r->>'due_date' is not null then if r->>'due_date' !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Use an ISO due date';end if;due:=(r->>'due_date')::date;if due not between '1900-01-01' and '2100-12-31' then raise exception 'Due date must be from 1900 to 2100';end if;end if;
  elsif kind='event' then
   has_events:=true;start_time:=private.calendar_import_time(r->>'starts_at');end_time:=private.calendar_import_time(r->>'ends_at');
   if end_time<=start_time or length(r->>'location')>2000 or r->>'color' not in('purple','green','orange','blue') or r->>'status' is not null or r->>'priority' is not null or r->>'due_date' is not null or r->>'body' is not null then raise exception 'Check event times, location, color and fields';end if;
  else if r->>'body' is null or length(r->>'body')>100000 or r->>'status' is not null or r->>'priority' is not null or r->>'due_date' is not null then raise exception 'Check note content; at most 100000 characters';end if;end if;
  r:=r||jsonb_build_object('title',trim(r->>'title'));
  details:=jsonb_build_object('project_source',r->>'project_source','project_id',project,'title',r->>'title','status',r->>'status','priority',r->>'priority','due_date',due,'body',r->>'body');
  if kind='event' then details:=jsonb_build_object('project_source',r->>'project_source','project_id',project,'title',r->>'title','starts_at',r->>'starts_at','ends_at',r->>'ends_at','location',r->>'location','color',r->>'color');end if;
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
  elsif kind='note' then
   if source ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select * into n from public.notes where id=source::uuid and workspace_id=w and owner_id=auth.uid() and visibility='private' for update;
    if found and (n.archived or n.journal_on is not null or cardinality(n.tags)>0 or exists(select 1 from public.note_documents where note_id=n.id) or trim(n.title) is distinct from r->>'title' or n.body is distinct from r->>'body' or n.project_id is distinct from project) then raise exception 'Existing note source ID identifies different content';end if;
   end if;
   select id into destination from public.notes where workspace_id=w and owner_id=auth.uid() and visibility='private' and not archived and journal_on is null and cardinality(tags)=0 and not exists(select 1 from public.note_documents d where d.note_id=notes.id) and trim(title)=r->>'title' and body=r->>'body' and project_id is not distinct from project order by created_at,id limit 1 for update;
   if destination is null then insert into public.notes(workspace_id,owner_id,visibility,title,body,project_id)values(w,auth.uid(),'private',r->>'title',r->>'body',project)returning id into destination;notes_added:=notes_added+1;else skipped:=skipped+1;end if;
   insert into public.record_json_links(workspace_id,owner_id,record_kind,source_id,note_id,details)values(w,auth.uid(),kind,source,destination,details);
  else
   if source ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    select * into e from public.calendar_events where id=source::uuid and workspace_id=w and owner_id=auth.uid() and visibility='private' for update;
    if found and (e.series_id is not null or e.event_state<>'scheduled' or trim(e.title) is distinct from r->>'title' or e.starts_at is distinct from start_time or e.ends_at is distinct from end_time or e.location is distinct from r->>'location' or e.color is distinct from r->>'color' or e.project_id is distinct from project) then raise exception 'Existing event source ID identifies different content';end if;
   end if;
   select id into destination from public.calendar_events where workspace_id=w and owner_id=auth.uid() and visibility='private' and series_id is null and event_state='scheduled' and trim(title)=r->>'title' and starts_at=start_time and ends_at=end_time and location=r->>'location' and color=r->>'color' and project_id is not distinct from project order by created_at,id limit 1 for update;
   if destination is null then insert into public.calendar_events(workspace_id,owner_id,visibility,title,starts_at,ends_at,location,color,project_id)values(w,auth.uid(),'private',r->>'title',start_time,end_time,r->>'location',r->>'color',project)returning id into destination;events_added:=events_added+1;else skipped:=skipped+1;end if;
   insert into public.record_json_links(workspace_id,owner_id,record_kind,source_id,event_id,details)values(w,auth.uid(),kind,source,destination,details);
  end if;
 end loop;
 answer:=jsonb_build_object('tasks_imported',tasks_added,'notes_imported',notes_added,'skipped',skipped);
 if has_events then answer:=answer||jsonb_build_object('events_imported',events_added);end if;
 insert into public.record_json_batches(id,workspace_id,owner_id,payload,result)values(entry,w,auth.uid(),payload,answer);return answer;
end $$;

