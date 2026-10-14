-- Private immutable import identity prevents reuploads overwriting later collaboration.
create table private.shopping_import_batches(id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),payload jsonb not null,result jsonb not null);
create table private.shopping_import_sources(workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),source_id text not null,details jsonb not null,list_id uuid references public.shopping_lists(id) on delete set null,primary key(workspace_id,owner_id,source_id));
revoke all on private.shopping_import_batches,private.shopping_import_sources from public,anon,authenticated,service_role;
create function private.shopping_import_row(r jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare i jsonb;q numeric;begin
 if r is null or jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>6 or not r ?& array['source_id','kind','title','notes','archived','items'] then raise exception 'Invalid shopping import columns';end if;
 if exists(select 1 from jsonb_each(r) where (key in('source_id','kind','title','notes') and jsonb_typeof(value)<>'string') or (key='archived' and jsonb_typeof(value)<>'boolean') or (key='items' and jsonb_typeof(value)<>'array')) then raise exception 'Invalid shopping field types';end if;
 if length(trim(r->>'source_id')) not between 1 and 200 or r->>'source_id'<>trim(r->>'source_id') or r->>'kind' not in('grocery','shopping') or length(trim(r->>'title')) not between 1 and 200 or length(r->>'notes')>2000 then raise exception 'Invalid shopping list details';end if;
 if jsonb_array_length(r->'items')>500 then raise exception 'Use up to 500 items per list';end if;
 for i in select value from jsonb_array_elements(r->'items') loop
  if jsonb_typeof(i)<>'object' or (select count(*) from jsonb_object_keys(i))<>8 or not i ?& array['position','name','category','quantity','unit','notes','checked','archived'] then raise exception 'Invalid shopping item columns';end if;
  if jsonb_typeof(i->'position')<>'number' or i->>'position'!~'^\d+$' or (i->>'position')::integer not between 1 and 500 or jsonb_typeof(i->'name')<>'string' or length(trim(i->>'name')) not between 1 and 200 or jsonb_typeof(i->'category')<>'string' or length(trim(i->>'category')) not between 1 and 60 or jsonb_typeof(i->'unit')<>'string' or length(trim(i->>'unit')) not between 1 and 30 or jsonb_typeof(i->'notes')<>'string' or length(i->>'notes')>2000 or jsonb_typeof(i->'checked')<>'boolean' or jsonb_typeof(i->'archived')<>'boolean' or jsonb_typeof(i->'quantity')<>'number' then raise exception 'Invalid shopping item details';end if;
  q:=(i->>'quantity')::numeric;if q<=0 or q>1000000 or q<>round(q,3) then raise exception 'Use positive quantities with up to three decimals';end if;
 end loop;
 if (select count(distinct (value->>'position')::integer) from jsonb_array_elements(r->'items'))<>jsonb_array_length(r->'items') then raise exception 'Item positions must be unique';end if;
 return r||jsonb_build_object('title',trim(r->>'title'),'items',coalesce((select jsonb_agg(value||jsonb_build_object('name',trim(value->>'name'),'category',trim(value->>'category'),'unit',trim(value->>'unit')) order by (value->>'position')::integer) from jsonb_array_elements(r->'items')),'[]'));
end $$;
create function private.shopping_import_payload(payload jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if payload is null or jsonb_typeof(payload)<>'array' then raise exception 'Use a shopping import array';end if;
 if jsonb_array_length(payload) not between 1 and 100 or octet_length(payload::text)>5242880 then raise exception 'Import 1–100 shopping lists below 5 MiB';end if;
 if (select count(distinct value->>'source_id') from jsonb_array_elements(payload))<>jsonb_array_length(payload) then raise exception 'Source shopping list IDs must be unique';end if;
 perform private.shopping_import_row(value) from jsonb_array_elements(payload);
 if (select coalesce(sum(jsonb_array_length(value->'items')),0) from jsonb_array_elements(payload))>500 then raise exception 'Import up to 500 items in total';end if;
end $$;
create function public.preview_shopping_import(w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;l private.shopping_import_sources;state text;message text;answer jsonb:='[]';begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform private.shopping_import_payload(payload);
 for r in select private.shopping_import_row(value) from jsonb_array_elements(payload) loop
  state:='ready';message:='New source ID: creates a new private list';
  select * into l from private.shopping_import_sources where workspace_id=w and owner_id=auth.uid() and source_id=r->>'source_id';
  if found then
   if l.details=r then state:='duplicate';message:='Already imported; later destination edits, checks and archives are preserved';else state:='invalid';message:='Source ID contents changed; omit this list';end if;
  elsif exists(select 1 from public.shopping_lists where workspace_id=w and owner_id=auth.uid() and id::text=lower(r->>'source_id')) then state:='invalid';message:='Source ID identifies an existing list; use another workspace or omit it';end if;
  answer:=answer||jsonb_build_array(jsonb_build_object('source_id',r->>'source_id','state',state,'message',message));
 end loop;return answer;
end $$;
create function public.import_shopping_json(entry uuid,w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b private.shopping_import_batches;l private.shopping_import_sources;r jsonb;i jsonb;destination uuid;answer jsonb;added integer:=0;items integer:=0;skipped integer:=0;begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform 1 from public.workspace_members where workspace_id=w and user_id=auth.uid() for share;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,44));perform pg_advisory_xact_lock(hashtextextended(w::text,41));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into b from private.shopping_import_batches where id=entry;
 if found then if b.workspace_id<>w or b.owner_id<>auth.uid() or b.payload is distinct from payload then raise exception 'Shopping import request reused';end if;return b.result;end if;
 perform private.shopping_import_payload(payload);
 for r in select private.shopping_import_row(value) from jsonb_array_elements(payload) loop
  select * into l from private.shopping_import_sources where workspace_id=w and owner_id=auth.uid() and source_id=r->>'source_id';
  if found then if l.details<>r then raise exception 'Source ID contents changed';end if;skipped:=skipped+1;continue;end if;
  if exists(select 1 from public.shopping_lists where workspace_id=w and owner_id=auth.uid() and id::text=lower(r->>'source_id')) then raise exception 'Source ID identifies an existing list';end if;
  destination:=gen_random_uuid();
  insert into public.shopping_lists(id,workspace_id,owner_id,title,kind,notes,archived)values(destination,w,auth.uid(),r->>'title',r->>'kind',r->>'notes',(r->>'archived')::boolean);
  for i in select value from jsonb_array_elements(r->'items') loop
   insert into public.shopping_items(id,workspace_id,owner_id,list_id,position,name,category,quantity,unit,notes,checked,checked_by,checked_at,archived)
   values(gen_random_uuid(),w,auth.uid(),destination,(i->>'position')::integer,i->>'name',i->>'category',(i->>'quantity')::numeric,i->>'unit',i->>'notes',(i->>'checked')::boolean,case when (i->>'checked')::boolean then auth.uid() end,case when (i->>'checked')::boolean then now() end,(i->>'archived')::boolean);items:=items+1;
  end loop;
  insert into private.shopping_import_sources values(w,auth.uid(),r->>'source_id',r,destination);added:=added+1;
 end loop;
 answer:=jsonb_build_object('lists_imported',added,'items_imported',items,'skipped',skipped);insert into private.shopping_import_batches values(entry,w,auth.uid(),payload,answer);return answer;
end $$;
revoke all on function private.shopping_import_row(jsonb),private.shopping_import_payload(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.preview_shopping_import(uuid,jsonb),public.import_shopping_json(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.preview_shopping_import(uuid,jsonb),public.import_shopping_json(uuid,uuid,jsonb) to authenticated;
