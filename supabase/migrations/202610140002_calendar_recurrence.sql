-- Finite, materialized repeats keep exports, project views and digests consistent.
create table public.calendar_series (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id),
 owner_id uuid not null references public.profiles(id), visibility public.record_visibility not null default 'private',
 frequency text not null check(frequency in('daily','weekly','monthly','yearly')),
 anchor_on date not null check(anchor_on between '1900-01-01' and '2100-12-31'),
 anchor_index integer not null default 0 check(anchor_index between 0 and 119),
 start_clock time not null, duration_seconds integer not null check(duration_seconds between 1 and 604800),
 time_zone text not null, occurrences integer not null check(occurrences between 2 and 120),
 state text not null default 'active' check(state in('active','paused','cancelled')),
 revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),unique(workspace_id,id)
);
alter table public.calendar_series enable row level security;
revoke all on public.calendar_series from public,anon,authenticated;
grant select on public.calendar_series to authenticated;
create policy calendar_series_read on public.calendar_series for select to authenticated using(private.can_read(workspace_id,owner_id,visibility));
create index on public.calendar_series(workspace_id,created_at,id);
create trigger touch_updated_at before update on public.calendar_series for each row execute function private.touch_updated_at();
alter table public.calendar_events
 add column revision integer not null default 1 check(revision>0),
 add column series_id uuid, add column occurrence_index integer check(occurrence_index between 0 and 119),
 add column is_exception boolean not null default false,
 add column event_state text not null default 'scheduled' check(event_state in('scheduled','paused','cancelled')),
 add foreign key(workspace_id,series_id) references public.calendar_series(workspace_id,id),
 add unique(series_id,occurrence_index), add check((series_id is null)=(occurrence_index is null));
create index on public.calendar_events(series_id,occurrence_index);
revoke insert on public.calendar_events from authenticated;
grant insert(id,workspace_id,owner_id,visibility,title,starts_at,ends_at,location,project_id,color,created_at,updated_at) on public.calendar_events to authenticated;
drop policy record_delete on public.calendar_events;
create policy record_delete on public.calendar_events for delete to authenticated using(series_id is null and private.can_edit(workspace_id,owner_id,visibility));
create function private.calendar_event_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' then
  new.revision:=old.revision+1;
 end if;
 if new.series_id is not null and not exists(select 1 from public.calendar_series s where s.id=new.series_id and s.workspace_id=new.workspace_id and s.owner_id=new.owner_id and s.visibility=new.visibility) then raise exception 'Repeat ownership and sharing are fixed';end if;
 return new;
end $$;
-- Direct edits of recurring rows bypass series revisions, so allow only RPC writes.
create function private.calendar_direct_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if old.series_id is not null and current_user in('authenticated','anon') then raise exception 'Use the Calendar editor for recurring events';end if;
 return new;
end $$;
create trigger calendar_direct_guard before update on public.calendar_events for each row execute function private.calendar_direct_guard();
create trigger calendar_event_guard before insert or update on public.calendar_events for each row execute function private.calendar_event_guard();
revoke all on function private.calendar_event_guard(),private.calendar_direct_guard() from public,anon,authenticated;

create table private.calendar_requests (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null
);
revoke all on private.calendar_requests from public,anon,authenticated,service_role;
create function private.calendar_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.calendar_requests;begin
 if request is null then raise exception 'A request ID is required';end if;
 select * into r from private.calendar_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id<>w or r.owner_id<>auth.uid() or r.payload<>payload then raise exception 'Request was already used for another change';end if;
 return true;
end $$;
create function private.calendar_wall_time(day date,clock time,zone text) returns timestamptz language plpgsql stable set search_path='' as $$
declare wall timestamp;instant timestamptz;begin
 if day is null or day not between '1900-01-01' and '2100-12-31' or clock is null or zone is null or not exists(select 1 from pg_timezone_names where name=zone and name not like 'posix/%' and name not like 'right/%') then raise exception 'Choose a supported date and IANA time zone';end if;
 wall:=day+clock;instant:=wall at time zone zone;
 if instant at time zone zone<>wall or exists(select 1 from generate_series(-180,180) n where n<>0 and (instant+make_interval(mins=>n)) at time zone zone=wall) then raise exception 'This local time is missing or ambiguous during a clock change; choose another time';end if;
 return instant;
end $$;
revoke all on function private.calendar_replayed(uuid,uuid,jsonb),private.calendar_wall_time(date,time,text) from public,anon,authenticated;

create function public.create_calendar_series(entry uuid,w uuid,event_title text,anchor date,start_time time,duration integer,timezone text,repeat_frequency text,event_count integer,place text,event_color text,linked_project uuid,sharing public.record_visibility) returns uuid language plpgsql security definer set search_path='' as $$
declare p jsonb;i integer;instant timestamptz;begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,15));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 p:=jsonb_build_array('create',event_title,anchor,start_time,duration,timezone,repeat_frequency,event_count,place,event_color,linked_project,sharing);
 if private.calendar_replayed(entry,w,p) then return entry;end if;
 if event_title is null or length(trim(event_title)) not between 1 and 200 or place is null or length(place)>2000 or event_color is null or event_color not in('purple','green','orange','blue') or sharing is null or repeat_frequency is null or repeat_frequency not in('daily','weekly','monthly','yearly') or event_count is null or event_count not between 2 and 120 or duration is null or duration not between 1 and 604800 then raise exception 'Enter valid event details and 2–120 occurrences';end if;
 if linked_project is not null then
  perform 1 from public.projects where id=linked_project and workspace_id=w and private.can_read(workspace_id,owner_id,visibility) and (sharing='private' or visibility='workspace') for share;
  if not found then raise exception 'Project is inaccessible or private';end if;
 end if;
 insert into public.calendar_series(id,workspace_id,owner_id,visibility,frequency,anchor_on,start_clock,duration_seconds,time_zone,occurrences)values(entry,w,auth.uid(),sharing,repeat_frequency,anchor,start_time,duration,timezone,event_count);
 for i in 0..event_count-1 loop
  instant:=private.calendar_wall_time(private.recurrence_date(anchor,repeat_frequency,i),start_time,timezone);
  if instant<'1900-01-01'::timestamptz or instant+make_interval(secs=>duration)>='2101-01-01'::timestamptz then raise exception 'Repeat extends beyond the supported date range';end if;
  insert into public.calendar_events(workspace_id,owner_id,visibility,title,starts_at,ends_at,location,color,project_id,series_id,occurrence_index)values(w,auth.uid(),sharing,trim(event_title),instant,instant+make_interval(secs=>duration),place,event_color,linked_project,entry,i);
 end loop;
 insert into private.calendar_requests values(entry,w,auth.uid(),p);return entry;
end $$;

create function public.edit_calendar_event(request uuid,entry uuid,expected_revision integer,expected_series_revision integer,edit_scope text,event_title text,event_start timestamptz,event_end timestamptz,place text,event_color text,linked_project uuid) returns void language plpgsql security definer set search_path='' as $$
declare e public.calendar_events;s public.calendar_series;r public.calendar_events;p jsonb;day date;anchor date;base integer;clock time;duration integer;instant timestamptz;begin
 select * into e from public.calendar_events where id=entry;
 if not found or auth.uid() is null or not private.can_edit(e.workspace_id,e.owner_id,e.visibility) then raise exception 'Event is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(e.workspace_id::text,15));select * into e from public.calendar_events where id=entry for update;
 if e.id is null or not private.can_edit(e.workspace_id,e.owner_id,e.visibility) then raise exception 'Event is inaccessible';end if;
 p:=jsonb_build_array('edit',entry,expected_revision,expected_series_revision,edit_scope,event_title,event_start,event_end,place,event_color,linked_project);
 if private.calendar_replayed(request,e.workspace_id,p) then return;end if;
 if expected_revision is null or e.revision<>expected_revision then raise exception 'Event changed; refresh and try again';end if;
 if event_title is null or length(trim(event_title)) not between 1 and 200 or event_start is null or event_end is null or not isfinite(event_start) or not isfinite(event_end) or event_start<'1900-01-01'::timestamptz or event_end>='2101-01-01'::timestamptz or event_end<=event_start or event_end-event_start>interval '7 days' or place is null or length(place)>2000 or event_color is null or event_color not in('purple','green','orange','blue') or edit_scope is null or edit_scope not in('one','future') then raise exception 'Enter valid event details and a duration of up to seven days';end if;
 if linked_project is not null then
  perform 1 from public.projects where id=linked_project and workspace_id=e.workspace_id and private.can_read(workspace_id,owner_id,visibility) and (e.visibility='private' or visibility='workspace') for share;
  if not found then raise exception 'Project is inaccessible or private';end if;
 end if;
 if e.series_id is not null then
  select * into s from public.calendar_series where id=e.series_id for update;
  if expected_series_revision is null or s.revision<>expected_series_revision then raise exception 'Repeat changed; refresh and try again';end if;
 end if;
 if edit_scope='future' then
  if s.id is null or s.state='cancelled' or e.starts_at<now() then raise exception 'Choose an upcoming occurrence of an active or paused repeat';end if;
  day:=(event_start at time zone s.time_zone)::date;clock:=(event_start at time zone s.time_zone)::time;
  instant:=private.calendar_wall_time(day,clock,s.time_zone);
  if instant<>event_start or event_start<now() then raise exception 'Choose an unambiguous upcoming local time';end if;
  duration:=extract(epoch from event_end-event_start)::integer;
  if day=private.recurrence_date(s.anchor_on,s.frequency,e.occurrence_index-s.anchor_index) then anchor:=s.anchor_on;base:=s.anchor_index;else anchor:=day;base:=e.occurrence_index;end if;
  for r in select * from public.calendar_events where series_id=s.id and occurrence_index>=e.occurrence_index and starts_at>=now() order by occurrence_index for update loop
   if r.is_exception or r.id=e.id then continue;end if;
   instant:=private.calendar_wall_time(private.recurrence_date(anchor,s.frequency,r.occurrence_index-base),clock,s.time_zone);
   if instant<now() or instant+make_interval(secs=>duration)>='2101-01-01'::timestamptz then raise exception 'Future occurrences must remain upcoming and within the supported date range';end if;
   update public.calendar_events set title=trim(event_title),starts_at=instant,ends_at=instant+make_interval(secs=>duration),location=place,color=event_color,project_id=linked_project where id=r.id;
  end loop;
  -- The selected occurrence is intentionally restored to the edited series schedule.
  update public.calendar_events set title=trim(event_title),starts_at=event_start,ends_at=event_end,location=place,color=event_color,project_id=linked_project,is_exception=false where id=e.id;
  update public.calendar_series set anchor_on=anchor,anchor_index=base,start_clock=clock,duration_seconds=duration,revision=revision+1 where id=s.id;
 else
  update public.calendar_events set title=trim(event_title),starts_at=event_start,ends_at=event_end,location=place,color=event_color,project_id=linked_project,is_exception=series_id is not null where id=e.id;
  if s.id is not null then update public.calendar_series set revision=revision+1 where id=s.id;end if;
 end if;
 insert into private.calendar_requests values(request,e.workspace_id,auth.uid(),p);
end $$;

create function public.set_calendar_state(request uuid,entry uuid,expected_revision integer,expected_series_revision integer,edit_scope text,target text) returns void language plpgsql security definer set search_path='' as $$
declare e public.calendar_events;s public.calendar_series;p jsonb;begin
 select * into e from public.calendar_events where id=entry;
 if not found or auth.uid() is null or not private.can_edit(e.workspace_id,e.owner_id,e.visibility) then raise exception 'Event is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(e.workspace_id::text,15));select * into e from public.calendar_events where id=entry for update;
 if e.id is null or not private.can_edit(e.workspace_id,e.owner_id,e.visibility) then raise exception 'Event is inaccessible';end if;
 p:=jsonb_build_array('state',entry,expected_revision,expected_series_revision,edit_scope,target);
 if private.calendar_replayed(request,e.workspace_id,p) then return;end if;
 if expected_revision is null or e.revision<>expected_revision then raise exception 'Event changed; refresh and try again';end if;
 if target is null or target not in('active','paused','cancelled') or edit_scope is null or edit_scope not in('one','series') then raise exception 'Choose a valid event state';end if;
 if e.series_id is not null then
  select * into s from public.calendar_series where id=e.series_id for update;
  if expected_series_revision is null or s.revision<>expected_series_revision then raise exception 'Repeat changed; refresh and try again';end if;
 end if;
 if edit_scope='series' then
  if s.id is null or s.state='cancelled' then raise exception 'A cancelled repeat cannot be resumed';end if;
  update public.calendar_events set event_state=case target when 'active' then 'scheduled' else target end where series_id=s.id and starts_at>=now() and event_state<>'cancelled';
  update public.calendar_series set state=target,revision=revision+1 where id=s.id;
 else
  if target='paused' or (target='active' and s.id is not null and s.state<>'active') then raise exception 'Resume the repeat before restoring an occurrence';end if;
  update public.calendar_events set event_state=case target when 'active' then 'scheduled' else target end,is_exception=series_id is not null where id=e.id;
  if s.id is not null then update public.calendar_series set revision=revision+1 where id=s.id;end if;
 end if;
 insert into private.calendar_requests values(request,e.workspace_id,auth.uid(),p);
end $$;
revoke all on function public.create_calendar_series(uuid,uuid,text,date,time,integer,text,text,integer,text,text,uuid,public.record_visibility),public.edit_calendar_event(uuid,uuid,integer,integer,text,text,timestamptz,timestamptz,text,text,uuid),public.set_calendar_state(uuid,uuid,integer,integer,text,text) from public,anon;
grant execute on function public.create_calendar_series(uuid,uuid,text,date,time,integer,text,text,integer,text,text,uuid,public.record_visibility),public.edit_calendar_event(uuid,uuid,integer,integer,text,text,timestamptz,timestamptz,text,text,uuid),public.set_calendar_state(uuid,uuid,integer,integer,text,text) to authenticated;

-- Imports only reuse scheduled one-off events.
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
    if found and (trim(n.title) is distinct from r->>'title' or n.body is distinct from r->>'body' or n.project_id is distinct from project) then raise exception 'Existing note source ID identifies different content';end if;
   end if;
   select id into destination from public.notes where workspace_id=w and owner_id=auth.uid() and visibility='private' and trim(title)=r->>'title' and body=r->>'body' and project_id is not distinct from project order by created_at,id limit 1 for update;
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

-- Paused and cancelled occurrences stay out of mail digests.
create or replace function private.email_text(d public.email_deliveries,clock timestamptz) returns text language plpgsql stable security definer set search_path='' as $$
declare p public.email_preferences;day date;finish date;begin_date date;content text;part text;name text;begin
 select * into p from public.email_preferences where owner_id=d.owner_id;day:=(clock at time zone p.delivery_timezone)::date;
 select w.name into name from public.workspaces w where id=d.workspace_id;
 content:='LifeOS - '||name||E'\n';
 if d.kind='reminder' then select title into part from public.notifications where id=d.notification_id;content:=content||part;
 elsif d.kind in('daily','weekly') then
  finish:=day+case when d.kind='weekly' then 6 else 0 end;
  content:=content||case when d.kind='weekly' then 'Weekly planning' else 'Daily overview' end||' ('||day||' to '||finish||')'||E'\n\nYour open tasks (up to 20):\n';
  select string_agg(title||' - '||coalesce(due_date::text,'no due date'),E'\n' order by due_date nulls last,id) into part from (select id,title,due_date from public.tasks where workspace_id=d.workspace_id and owner_id=d.owner_id and status<>'done' and (due_date is null or due_date<=finish) order by due_date nulls last,id limit 20)t;
  content:=content||coalesce(part,'No open tasks in this window.')||E'\n\nYour events (up to 20), '||p.delivery_timezone||E':\n';
  select string_agg(title||' - '||to_char(starts_at at time zone p.delivery_timezone,'YYYY-MM-DD HH24:MI'),E'\n' order by starts_at,id) into part from (select id,title,starts_at from public.calendar_events where event_state='scheduled' and workspace_id=d.workspace_id and owner_id=d.owner_id and starts_at>=day::timestamp at time zone p.delivery_timezone and starts_at<(finish+1)::timestamp at time zone p.delivery_timezone order by starts_at,id limit 20)e;
  content:=content||coalesce(part,'No events in this window.');
 else
  finish:=day-1;begin_date:=case when d.period_key like 'monthly:%' then (date_trunc('month',day::timestamp)-interval '1 month')::date else day-7 end;
  content:=content||'Financial summary ('||begin_date||' to '||finish||E')\nIncome and expenses only; transfers excluded. Each currency is separate.\n';
  select string_agg(currency||': income '||income::text||', expenses '||expenses::text||', net '||(income-expenses)::text,E'\n' order by currency) into part from (
   select a.currency,coalesce(sum(t.amount)filter(where t.kind='income'),0)income,coalesce(sum(t.amount)filter(where t.kind='expense'),0)expenses from public.transactions t join public.accounts a on a.id=t.account_id and a.workspace_id=d.workspace_id and a.owner_id=d.owner_id where t.workspace_id=d.workspace_id and t.owner_id=d.owner_id and t.kind in('income','expense') and t.booked_on between begin_date and finish group by a.currency)f;
  content:=content||coalesce(part,'No income or expenses in this period.');
 end if;
 return content||E'\n\nOpen LifeOS and select this workspace: https://lifeos.sajinct.com/#/'||E'\nManage email preferences: https://lifeos.sajinct.com/#/settings\nOnly your own records are included. Replies are not monitored.';
end $$;
revoke all on function private.email_text(public.email_deliveries,timestamptz) from public,anon,authenticated,service_role;

