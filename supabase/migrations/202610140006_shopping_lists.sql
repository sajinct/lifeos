-- Child items inherit their list's current sharing, including archived items.
create table public.shopping_lists(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private',
 title text not null check(length(trim(title)) between 1 and 200),kind text not null check(kind in('grocery','shopping')),notes text not null default '' check(length(notes)<=2000),
 archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table public.shopping_items(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),list_id uuid not null,
 name text not null check(length(trim(name)) between 1 and 200),category text not null default 'Other' check(length(trim(category)) between 1 and 60),quantity numeric(12,3) not null check(quantity>0 and quantity<=1000000),unit text not null check(length(trim(unit)) between 1 and 30),notes text not null default '' check(length(notes)<=2000),
 position integer not null check(position between 1 and 500),checked boolean not null default false,checked_by uuid references public.profiles(id),checked_at timestamptz,archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(workspace_id,list_id) references public.shopping_lists(workspace_id,id) on delete cascade,unique(list_id,position),check(checked=(checked_by is not null and checked_at is not null)),check(checked or (checked_by is null and checked_at is null))
);
alter table public.shopping_lists enable row level security;
alter table public.shopping_items enable row level security;
revoke all on public.shopping_lists,public.shopping_items from public,anon,authenticated;
grant select on public.shopping_lists,public.shopping_items to authenticated;
create policy shopping_list_read on public.shopping_lists for select to authenticated using(private.can_read(workspace_id,owner_id,visibility));
create policy shopping_item_read on public.shopping_items for select to authenticated using(exists(select 1 from public.shopping_lists l where l.id=list_id and l.workspace_id=shopping_items.workspace_id and private.can_read(l.workspace_id,l.owner_id,l.visibility)));
create index on public.shopping_lists(workspace_id,created_at,id);
create index on public.shopping_items(workspace_id,created_at,id);
create index on public.shopping_items(list_id,position);
create trigger touch_updated_at before update on public.shopping_lists for each row execute function private.touch_updated_at();
create trigger touch_updated_at before update on public.shopping_items for each row execute function private.touch_updated_at();
create table private.shopping_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null);
revoke all on private.shopping_requests from public,anon,authenticated,service_role;
create function private.shopping_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.shopping_requests;begin
 if request is null then raise exception 'Request ID required';end if;
 select * into r from private.shopping_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id is distinct from w or r.owner_id is distinct from auth.uid() or r.payload is distinct from payload then raise exception 'Request was already used for another change';end if;return true;
end $$;
revoke all on function private.shopping_replayed(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.save_shopping_list(request uuid,entry uuid,w uuid,expected_revision integer,list_title text,list_kind text,list_notes text,sharing public.record_visibility) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.shopping_lists;payload jsonb;begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,41));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into r from public.shopping_lists where id=entry for update;
 if found and (r.workspace_id<>w or not private.can_edit(w,r.owner_id,r.visibility)) then raise exception 'Shopping list is inaccessible';end if;
 payload:=jsonb_build_array('list',entry,expected_revision,list_title,list_kind,list_notes,sharing);
 if private.shopping_replayed(request,w,payload) then return entry;end if;
 if r.id is null and expected_revision is not null then raise exception 'Shopping list is inaccessible';end if;
 if r.id is not null then
  if expected_revision is null or expected_revision<>r.revision then raise exception 'Shopping list changed; refresh and try again';end if;
  if r.archived then raise exception 'Restore the shopping list before editing';end if;
  if list_kind is distinct from r.kind then raise exception 'List type cannot change';end if;
  if sharing is distinct from r.visibility and r.owner_id<>auth.uid() then raise exception 'Only the list creator can change sharing';end if;
 end if;
 if list_title is null or length(trim(list_title)) not between 1 and 200 or list_kind is null or list_kind not in('grocery','shopping') or list_notes is null or length(list_notes)>2000 or sharing is null then raise exception 'Enter valid shopping list details';end if;
 if r.id is null then insert into public.shopping_lists(id,workspace_id,owner_id,title,kind,notes,visibility)values(entry,w,auth.uid(),trim(list_title),list_kind,list_notes,sharing);
 else update public.shopping_lists set title=trim(list_title),notes=list_notes,visibility=sharing,revision=revision+1 where id=entry;end if;
 insert into private.shopping_requests values(request,w,auth.uid(),payload);return entry;
end $$;
create function public.save_shopping_item(request uuid,entry uuid,parent uuid,expected_revision integer,expected_parent_revision integer,item_name text,item_category text,item_quantity numeric,item_unit text,item_notes text,is_checked boolean,is_archived boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.shopping_lists;i public.shopping_items;payload jsonb;next_position integer;begin
 select * into r from public.shopping_lists where id=parent;
 if not found or auth.uid() is null or not private.can_write(r.workspace_id) or not private.can_read(r.workspace_id,r.owner_id,r.visibility) then raise exception 'Shopping list is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(r.workspace_id::text,41));select * into r from public.shopping_lists where id=parent for update;
 if r.id is null or not private.can_write(r.workspace_id) or not private.can_read(r.workspace_id,r.owner_id,r.visibility) then raise exception 'Shopping list is inaccessible';end if;
 payload:=jsonb_build_array('item',entry,parent,expected_revision,expected_parent_revision,item_name,item_category,item_quantity,item_unit,item_notes,is_checked,is_archived);
 if private.shopping_replayed(request,r.workspace_id,payload) then return entry;end if;
 if r.archived then raise exception 'Restore the shopping list before changing items';end if;
 if expected_parent_revision is null or expected_parent_revision<>r.revision then raise exception 'Shopping list changed; refresh and try again';end if;
 select * into i from public.shopping_items where id=entry for update;
 if found then
  if i.list_id<>parent or i.workspace_id<>r.workspace_id then raise exception 'Shopping item is inaccessible';end if;
  if expected_revision is null or expected_revision<>i.revision then raise exception 'Shopping item changed; refresh and try again';end if;
  if i.archived and (is_archived is distinct from false or item_name is distinct from i.name or item_category is distinct from i.category or item_quantity is distinct from i.quantity or item_unit is distinct from i.unit or item_notes is distinct from i.notes or is_checked is distinct from i.checked) then raise exception 'Restore the item before editing';end if;
 elsif expected_revision is not null then raise exception 'Shopping item is inaccessible';end if;
 if entry is null or item_name is null or length(trim(item_name)) not between 1 and 200 or item_category is null or length(trim(item_category)) not between 1 and 60 or item_quantity is null or item_quantity<=0 or item_quantity>1000000 or item_quantity<>round(item_quantity,3) or item_unit is null or length(trim(item_unit)) not between 1 and 30 or item_notes is null or length(item_notes)>2000 or is_checked is null or is_archived is null then raise exception 'Enter valid item details and a positive quantity with up to three decimals';end if;
 if i.id is null then
  if is_archived then raise exception 'New items must be current';end if;
  select coalesce(max(position),0)+1 into next_position from public.shopping_items where list_id=parent;
  if next_position>500 then raise exception 'A shopping list supports up to 500 items, including archives';end if;
  insert into public.shopping_items(id,workspace_id,owner_id,list_id,name,category,quantity,unit,notes,position,checked,checked_by,checked_at)values(entry,r.workspace_id,auth.uid(),parent,trim(item_name),trim(item_category),item_quantity,trim(item_unit),item_notes,next_position,is_checked,case when is_checked then auth.uid() end,case when is_checked then now() end);
 else update public.shopping_items set name=trim(item_name),category=trim(item_category),quantity=item_quantity,unit=trim(item_unit),notes=item_notes,checked=is_checked,checked_by=case when not is_checked then null when checked then checked_by else auth.uid() end,checked_at=case when not is_checked then null when checked then checked_at else now() end,archived=is_archived,revision=revision+1 where id=entry;end if;
 update public.shopping_lists set revision=revision+1 where id=parent;
 insert into private.shopping_requests values(request,r.workspace_id,auth.uid(),payload);return entry;
end $$;
create function public.set_shopping_archived(request uuid,entry uuid,expected_revision integer,is_archived boolean) returns void language plpgsql security definer set search_path='' as $$
declare r public.shopping_lists;payload jsonb;begin
 select * into r from public.shopping_lists where id=entry;
 if not found or auth.uid() is null or not private.can_edit(r.workspace_id,r.owner_id,r.visibility) then raise exception 'Shopping list is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(r.workspace_id::text,41));select * into r from public.shopping_lists where id=entry for update;
 if r.id is null or not private.can_edit(r.workspace_id,r.owner_id,r.visibility) then raise exception 'Shopping list is inaccessible';end if;
 payload:=jsonb_build_array('archive',entry,expected_revision,is_archived);
 if private.shopping_replayed(request,r.workspace_id,payload) then return;end if;
 if expected_revision is null or expected_revision<>r.revision then raise exception 'Shopping list changed; refresh and try again';end if;
 if is_archived is null then raise exception 'Choose archive or restore';end if;
 update public.shopping_lists set archived=is_archived,revision=revision+1 where id=entry;
 insert into private.shopping_requests values(request,r.workspace_id,auth.uid(),payload);
end $$;
revoke all on function public.save_shopping_list(uuid,uuid,uuid,integer,text,text,text,public.record_visibility),public.save_shopping_item(uuid,uuid,uuid,integer,integer,text,text,numeric,text,text,boolean,boolean),public.set_shopping_archived(uuid,uuid,integer,boolean) from public,anon;
grant execute on function public.save_shopping_list(uuid,uuid,uuid,integer,text,text,text,public.record_visibility),public.save_shopping_item(uuid,uuid,uuid,integer,integer,text,text,numeric,text,text,boolean,boolean),public.set_shopping_archived(uuid,uuid,integer,boolean) to authenticated;
