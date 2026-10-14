-- Import audit content is private. Preview exposes only the caller's row states.
create table private.learning_import_batches(id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),payload jsonb not null,result jsonb not null);
create table private.learning_import_sources(workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),source_id text not null,details jsonb not null,item_id uuid references public.learning_items(id) on delete set null,primary key(workspace_id,owner_id,source_id));
revoke all on private.learning_import_batches,private.learning_import_sources from public,anon,authenticated,service_role;
create function private.learning_import_row(r jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u jsonb;d date;begin
 if r is null or jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>12 or not r ?& array['source_id','kind','title','provider','url','goal','due_on','notes','status','completed_on','archived','units'] then raise exception 'Invalid learning import columns';end if;
 if exists(select 1 from jsonb_each(r) where (key in('source_id','kind','title','provider','url','goal','notes','status') and jsonb_typeof(value)<>'string') or (key in('due_on','completed_on') and jsonb_typeof(value) not in('string','null')) or (key='archived' and jsonb_typeof(value)<>'boolean') or (key='units' and jsonb_typeof(value)<>'array')) then raise exception 'Invalid learning field types';end if;
 if length(trim(r->>'source_id')) not between 1 and 200 or r->>'source_id'<>trim(r->>'source_id') or r->>'kind' not in('course','book','resource') or length(trim(r->>'title')) not between 1 and 200 or length(r->>'provider')>200 or length(r->>'goal')>1000 or length(r->>'notes')>4000 or length(r->>'url')>2000 or (r->>'url'<>'' and (r->>'url'!~'^https?://[^/?#[:space:]]+[^[:space:]]*$' or r->>'url'~'^https?://[^/?#]*@' or r->>'url'~'[[:cntrl:]]')) or r->>'status' not in('active','paused','completed') then raise exception 'Invalid learning details';end if;
 if r->>'due_on' is not null then
  if r->>'due_on'!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Use an ISO deadline';end if;d:=(r->>'due_on')::date;if d not between '1900-01-01' and '2100-12-31' then raise exception 'Deadline outside supported range';end if;
 end if;
 if r->>'status'='completed' then
  if r->>'completed_on' is null or r->>'completed_on'!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Completed learning requires an ISO completion date';end if;d:=(r->>'completed_on')::date;if d<'1900-01-01' or d>'2100-12-31' or d>private.finance_today(auth.uid()) then raise exception 'Completion date cannot be future';end if;
 elsif r->>'completed_on' is not null then raise exception 'Only completed learning has a completion date';end if;
 if jsonb_array_length(r->'units')>200 then raise exception 'Use up to 200 lessons per item';end if;
 for u in select value from jsonb_array_elements(r->'units') loop
  if jsonb_typeof(u)<>'object' or (select count(*)from jsonb_object_keys(u))<>5 or not u ?& array['position','title','notes','done','archived'] then raise exception 'Invalid lesson columns';end if;
  if jsonb_typeof(u->'position')<>'number' or u->>'position'!~'^\d+$' or (u->>'position')::integer not between 1 and 200 or jsonb_typeof(u->'title')<>'string' or length(trim(u->>'title')) not between 1 and 200 or jsonb_typeof(u->'notes')<>'string' or length(u->>'notes')>2000 or jsonb_typeof(u->'done')<>'boolean' or jsonb_typeof(u->'archived')<>'boolean' then raise exception 'Invalid lesson details';end if;
  if r->>'status'='completed' and not(u->>'archived')::boolean and not(u->>'done')::boolean then raise exception 'Complete the remaining lessons before importing a completed item';end if;
 end loop;
 if (select count(distinct (value->>'position')::integer)from jsonb_array_elements(r->'units'))<>jsonb_array_length(r->'units') then raise exception 'Lesson positions must be unique';end if;
 return r||jsonb_build_object('title',trim(r->>'title'),'provider',trim(r->>'provider'),'url',trim(r->>'url'),'units',coalesce((select jsonb_agg(value||jsonb_build_object('title',trim(value->>'title')) order by (value->>'position')::integer)from jsonb_array_elements(r->'units')),'[]'));
end $$;
revoke all on function private.learning_import_row(jsonb) from public,anon,authenticated,service_role;
create function private.learning_import_payload(payload jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if payload is null or jsonb_typeof(payload)<>'array' then raise exception 'Use a learning import array';end if;
 if jsonb_array_length(payload) not between 1 and 200 or octet_length(payload::text)>5242880 then raise exception 'Import 1–200 learning items below 5 MiB';end if;
 if (select count(distinct value->>'source_id')from jsonb_array_elements(payload))<>jsonb_array_length(payload) then raise exception 'Source learning IDs must be unique';end if;
 perform private.learning_import_row(value) from jsonb_array_elements(payload);
 if (select coalesce(sum(jsonb_array_length(value->'units')),0)from jsonb_array_elements(payload))>500 then raise exception 'Import up to 500 lessons in total';end if;
end $$;
revoke all on function private.learning_import_payload(jsonb) from public,anon,authenticated,service_role;
create function public.preview_learning_import(w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;l private.learning_import_sources;state text;message text;answer jsonb:='[]';begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform private.learning_import_payload(payload);
 for r in select private.learning_import_row(value) from jsonb_array_elements(payload) loop
  state:='ready';message:='New source ID: creates a new private item';
  select * into l from private.learning_import_sources where workspace_id=w and owner_id=auth.uid() and source_id=r->>'source_id';
  if found then
   if l.details=r then state:='duplicate';message:='Already imported; later destination edits and archives are preserved';else state:='invalid';message:='Source ID contents changed; omit this item';end if;
  elsif exists(select 1 from public.learning_items where workspace_id=w and owner_id=auth.uid() and id::text=lower(r->>'source_id')) then state:='invalid';message:='Source ID identifies existing learning; use another workspace or omit this item';end if;
  answer:=answer||jsonb_build_array(jsonb_build_object('source_id',r->>'source_id','state',state,'message',message));
 end loop;return answer;
end $$;
create function public.import_learning_json(entry uuid,w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.learning_import_batches;l private.learning_import_sources;r jsonb;u jsonb;destination uuid;answer jsonb;added integer:=0;lessons integer:=0;skipped integer:=0;begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,39));perform pg_advisory_xact_lock(hashtextextended(w::text,15));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into b from private.learning_import_batches where id=entry;
 if found then if b.workspace_id<>w or b.owner_id<>auth.uid() or b.payload is distinct from payload then raise exception 'Learning import request reused';end if;return b.result;end if;
 perform private.learning_import_payload(payload);
 for r in select private.learning_import_row(value) from jsonb_array_elements(payload) loop
  select * into l from private.learning_import_sources where workspace_id=w and owner_id=auth.uid() and source_id=r->>'source_id';
  if found then if l.details<>r then raise exception 'Source ID contents changed';end if;skipped:=skipped+1;continue;end if;
  if exists(select 1 from public.learning_items where workspace_id=w and owner_id=auth.uid() and id::text=lower(r->>'source_id')) then raise exception 'Source ID identifies existing learning';end if;
  destination:=gen_random_uuid();
  insert into public.learning_items(id,workspace_id,owner_id,kind,title,provider,url,goal,due_on,notes,status,completed_on,archived)values(destination,w,auth.uid(),r->>'kind',r->>'title',r->>'provider',r->>'url',r->>'goal',(r->>'due_on')::date,r->>'notes',r->>'status',(r->>'completed_on')::date,(r->>'archived')::boolean);
  for u in select value from jsonb_array_elements(r->'units') loop
   insert into public.learning_units(id,workspace_id,owner_id,item_id,title,notes,position,done,archived)values(gen_random_uuid(),w,auth.uid(),destination,u->>'title',u->>'notes',(u->>'position')::integer,(u->>'done')::boolean,(u->>'archived')::boolean);lessons:=lessons+1;
  end loop;
  insert into private.learning_import_sources values(w,auth.uid(),r->>'source_id',r,destination);added:=added+1;
 end loop;
 answer:=jsonb_build_object('items_imported',added,'lessons_imported',lessons,'skipped',skipped);insert into private.learning_import_batches values(entry,w,auth.uid(),payload,answer);return answer;
end $$;
revoke all on function public.preview_learning_import(uuid,jsonb),public.import_learning_json(uuid,uuid,jsonb) from public,anon;
grant execute on function public.preview_learning_import(uuid,jsonb),public.import_learning_json(uuid,uuid,jsonb) to authenticated;
