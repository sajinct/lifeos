-- Learning and every linked record stay private to their owner in one workspace.
create table public.learning_items (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),
 kind text not null check(kind in('course','book','resource')),title text not null check(length(trim(title)) between 1 and 200),
 provider text not null default '' check(length(provider)<=200),url text not null default '',goal text not null default '' check(length(goal)<=1000),
 due_on date check(due_on between '1900-01-01' and '2100-12-31'),notes text not null default '' check(length(notes)<=4000),
 status text not null default 'active' check(status in('active','paused','completed')),completed_on date,
 archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),
 check((status='completed')=(completed_on is not null))
);
create table public.learning_units (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),item_id uuid not null,
 title text not null check(length(trim(title)) between 1 and 200),notes text not null default '' check(length(notes)<=2000),
 position integer not null check(position between 1 and 200),done boolean not null default false,archived boolean not null default false,
 revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,item_id) references public.learning_items(workspace_id,id) on delete cascade,unique(item_id,position)
);
create table public.learning_notes (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),item_id uuid not null,note_id uuid not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,item_id) references public.learning_items(workspace_id,id) on delete cascade,
 foreign key(workspace_id,note_id) references public.notes(workspace_id,id) on delete cascade,unique(item_id,note_id)
);
create table public.learning_documents (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),item_id uuid not null,attachment_id uuid not null,
 purpose text not null check(purpose in('reference','certificate')),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,item_id) references public.learning_items(workspace_id,id) on delete cascade,
 foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade,unique(item_id,attachment_id)
);
do $$declare t text;begin
 foreach t in array array['learning_items','learning_units','learning_notes','learning_documents'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy own_learning_read on public.%I for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id))',t);
  execute format('create index on public.%I(workspace_id,created_at,id)',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create index on public.learning_units(item_id,position);
create table private.learning_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null);
revoke all on private.learning_requests from public,anon,authenticated,service_role;
create function private.learning_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.learning_requests;begin
 if request is null then raise exception 'A request ID is required';end if;
 select * into r from private.learning_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id<>w or r.owner_id<>auth.uid() or r.payload<>payload then raise exception 'Request was already used for another change';end if;
 return true;
end $$;
revoke all on function private.learning_replayed(uuid,uuid,jsonb) from public,anon,authenticated;
create function public.save_learning_item(request uuid,entry uuid,w uuid,expected_revision integer,item_kind text,item_title text,provider_name text,resource_url text,learning_goal text,deadline date,item_notes text,note_ids uuid[],document_ids uuid[],certificate_ids uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.learning_items;payload jsonb;source uuid;begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,15));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into r from public.learning_items where id=entry for update;
 if found and (r.workspace_id<>w or r.owner_id<>auth.uid()) then raise exception 'Learning item is inaccessible';end if;
 payload:=jsonb_build_array('save',entry,expected_revision,item_kind,item_title,provider_name,resource_url,learning_goal,deadline,item_notes,note_ids,document_ids,certificate_ids);
 if private.learning_replayed(request,w,payload) then return entry;end if;
 if r.id is null and expected_revision is not null then raise exception 'Learning item is inaccessible';end if;
 if r.id is not null then
  if expected_revision is null or r.revision<>expected_revision then raise exception 'Learning item changed; refresh and try again';end if;
  if r.archived then raise exception 'Restore the learning item before editing';end if;
 end if;
 if item_kind is null or item_kind not in('course','book','resource') or item_title is null or length(trim(item_title)) not between 1 and 200 or provider_name is null or length(provider_name)>200 or resource_url is null or length(resource_url)>2000 or (resource_url<>'' and (resource_url!~'^https?://[^/?#[:space:]]+[^[:space:]]*$' or resource_url~'^https?://[^/?#]*@' or resource_url~'[[:cntrl:]]')) or learning_goal is null or length(learning_goal)>1000 or (deadline is not null and deadline not between '1900-01-01' and '2100-12-31') or item_notes is null or length(item_notes)>4000 then raise exception 'Enter valid learning details and an HTTP/HTTPS resource link without credentials';end if;
 if note_ids is null or document_ids is null or certificate_ids is null or cardinality(note_ids)>50 or cardinality(document_ids)+cardinality(certificate_ids)>50 or array_ndims(note_ids)>1 or array_ndims(document_ids)>1 or array_ndims(certificate_ids)>1 or document_ids&&certificate_ids then raise exception 'Link up to 50 notes and 50 distinct files with one purpose per file';end if;
 for source in select distinct unnest(note_ids) order by 1 loop
  perform 1 from public.notes where id=source and workspace_id=w and owner_id=auth.uid() for share;
  if not found then raise exception 'Choose notes you own in this workspace';end if;
 end loop;
 for source in select distinct unnest(document_ids||certificate_ids) order by 1 loop
  perform 1 from public.attachments where id=source and workspace_id=w and owner_id=auth.uid() and status in('ready','archived') for share;
  if not found then raise exception 'Choose your own completed documents in this workspace';end if;
 end loop;
 if r.id is null then insert into public.learning_items(id,workspace_id,owner_id,kind,title,provider,url,goal,due_on,notes)values(entry,w,auth.uid(),item_kind,trim(item_title),trim(provider_name),trim(resource_url),learning_goal,deadline,item_notes);
 else update public.learning_items set kind=item_kind,title=trim(item_title),provider=trim(provider_name),url=trim(resource_url),goal=learning_goal,due_on=deadline,notes=item_notes,revision=revision+1 where id=entry;end if;
 delete from public.learning_notes where item_id=entry and not(note_id=any(note_ids));
 insert into public.learning_notes(workspace_id,owner_id,item_id,note_id)select w,auth.uid(),entry,q.source_id from(select distinct unnest(note_ids)source_id)q on conflict(item_id,note_id)do nothing;
 delete from public.learning_documents where item_id=entry and not(attachment_id=any(document_ids||certificate_ids));
 insert into public.learning_documents(workspace_id,owner_id,item_id,attachment_id,purpose)
 select w,auth.uid(),entry,q.source_id,'reference' from(select distinct unnest(document_ids)source_id)q on conflict(item_id,attachment_id)do update set purpose='reference';
 insert into public.learning_documents(workspace_id,owner_id,item_id,attachment_id,purpose)
 select w,auth.uid(),entry,q.source_id,'certificate' from(select distinct unnest(certificate_ids)source_id)q on conflict(item_id,attachment_id)do update set purpose='certificate';
 insert into private.learning_requests values(request,w,auth.uid(),payload);return entry;
end $$;
create function public.save_learning_unit(request uuid,entry uuid,parent uuid,expected_revision integer,expected_parent_revision integer,unit_title text,unit_notes text,is_done boolean,is_archived boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.learning_items;u public.learning_units;payload jsonb;total integer;remaining integer;next_position integer;begin
 select * into r from public.learning_items where id=parent;
 if not found or auth.uid() is null or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Learning item is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(r.workspace_id::text,15));select * into r from public.learning_items where id=parent for update;
 if r.id is null or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Learning item is inaccessible';end if;
 payload:=jsonb_build_array('unit',entry,parent,expected_revision,expected_parent_revision,unit_title,unit_notes,is_done,is_archived);
 if private.learning_replayed(request,r.workspace_id,payload) then return entry;end if;
 if r.archived or r.status='paused' then raise exception 'Restore or resume the learning item before changing lessons';end if;
 if expected_parent_revision is null or r.revision<>expected_parent_revision then raise exception 'Learning item changed; refresh and try again';end if;
 select * into u from public.learning_units where id=entry for update;
 if found then
  if u.item_id<>parent or u.workspace_id<>r.workspace_id or u.owner_id<>auth.uid() then raise exception 'Lesson is inaccessible';end if;
  if expected_revision is null or u.revision<>expected_revision then raise exception 'Lesson changed; refresh and try again';end if;
 elsif expected_revision is not null then raise exception 'Lesson is inaccessible';end if;
 if entry is null or unit_title is null or length(trim(unit_title)) not between 1 and 200 or unit_notes is null or length(unit_notes)>2000 or is_done is null or is_archived is null then raise exception 'Enter valid lesson details';end if;
 if u.id is null then
  select coalesce(max(position),0)+1 into next_position from public.learning_units where item_id=parent;
  if next_position>200 then raise exception 'A learning item supports up to 200 lessons, including archived lessons';end if;
  insert into public.learning_units(id,workspace_id,owner_id,item_id,title,notes,position,done,archived)values(entry,r.workspace_id,auth.uid(),parent,trim(unit_title),unit_notes,next_position,is_done,is_archived);
 else update public.learning_units set title=trim(unit_title),notes=unit_notes,done=is_done,archived=is_archived,revision=revision+1 where id=entry;end if;
 select count(*)::integer,count(*)filter(where not done)::integer into total,remaining from public.learning_units where item_id=parent and not archived;
 update public.learning_items set status=case when total>0 and remaining=0 then 'completed' when remaining>0 and status='completed' then 'active' else status end,
  completed_on=case when total>0 and remaining=0 then coalesce(completed_on,private.finance_today(auth.uid())) when remaining>0 then null else completed_on end,revision=revision+1 where id=parent;
 insert into private.learning_requests values(request,r.workspace_id,auth.uid(),payload);return entry;
end $$;
create function public.set_learning_state(request uuid,entry uuid,expected_revision integer,target text,is_archived boolean) returns void language plpgsql security definer set search_path='' as $$
declare r public.learning_items;payload jsonb;begin
 select * into r from public.learning_items where id=entry;
 if not found or auth.uid() is null or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Learning item is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(r.workspace_id::text,15));select * into r from public.learning_items where id=entry for update;
 if r.id is null or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Learning item is inaccessible';end if;
 payload:=jsonb_build_array('state',entry,expected_revision,target,is_archived);
 if private.learning_replayed(request,r.workspace_id,payload) then return;end if;
 if expected_revision is null or r.revision<>expected_revision then raise exception 'Learning item changed; refresh and try again';end if;
 if target is null or target not in('active','paused','completed') or is_archived is null then raise exception 'Choose a valid learning state';end if;
 if r.archived and target<>r.status then raise exception 'Restore the learning item before changing its state';end if;
 if target='completed' and exists(select 1 from public.learning_units where item_id=entry and not archived and not done) then raise exception 'Complete the remaining lessons first';end if;
 update public.learning_items set status=target,archived=is_archived,completed_on=case when target='completed' then coalesce(completed_on,private.finance_today(auth.uid())) else null end,revision=revision+1 where id=entry;
 insert into private.learning_requests values(request,r.workspace_id,auth.uid(),payload);
end $$;
revoke all on function public.save_learning_item(uuid,uuid,uuid,integer,text,text,text,text,text,date,text,uuid[],uuid[],uuid[]),public.save_learning_unit(uuid,uuid,uuid,integer,integer,text,text,boolean,boolean),public.set_learning_state(uuid,uuid,integer,text,boolean) from public,anon;
grant execute on function public.save_learning_item(uuid,uuid,uuid,integer,text,text,text,text,text,date,text,uuid[],uuid[],uuid[]),public.save_learning_unit(uuid,uuid,uuid,integer,integer,text,text,boolean,boolean),public.set_learning_state(uuid,uuid,integer,text,boolean) to authenticated;
