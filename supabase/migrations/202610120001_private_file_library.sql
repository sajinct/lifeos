-- File reservations let interrupted uploads be recovered without exposing unfinished files.
alter table public.transactions add constraint transactions_workspace_id_key unique(workspace_id,id);
alter table public.attachments
  add column bucket_id text not null default 'personal-documents' check(bucket_id in ('personal-documents','financial-receipts')),
  add column status text not null default 'ready' check(status in ('uploading','ready','archived','cancelled')),
  add column category text not null default 'Other' check(length(trim(category)) between 1 and 100),
  add column expires_on date,
  add column transaction_id uuid,
  add column previous_version_id uuid unique references public.attachments(id),
  add column version_number integer not null default 1 check(version_number > 0),
  add constraint attachment_transaction_fk foreign key(workspace_id,transaction_id) references public.transactions(workspace_id,id),
  add constraint receipt_transaction_link check(transaction_id is null or bucket_id = 'financial-receipts');
-- Existing metadata remains readable; all new records begin as reservations.
alter table public.attachments alter column status set default 'uploading';
update public.attachments a set bucket_id = 'financial-receipts' where
  exists(select 1 from storage.objects o where o.name = a.object_path and o.bucket_id = 'financial-receipts')
  and not exists(select 1 from storage.objects o where o.name = a.object_path and o.bucket_id = 'personal-documents');
revoke delete on public.attachments from authenticated;

create function private.validate_attachment() returns trigger language plpgsql security definer set search_path = '' as $$
declare previous public.attachments; extension text;
begin
  if tg_op = 'INSERT' then
    if length(trim(new.name)) not between 1 and 200 or new.size_bytes not between 1 and 10485760 then raise exception 'Invalid file name or size'; end if;
    if new.status <> 'uploading' then raise exception 'Upload state is server-owned'; end if;
    extension := case new.mime_type when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'text/plain' then 'txt' end;
    if extension is null or (new.bucket_id = 'financial-receipts' and new.mime_type = 'text/plain') then raise exception 'Unsupported file type'; end if;
    if new.object_path <> new.owner_id::text || '/' || new.workspace_id::text || '/' || new.id::text || '.' || extension then raise exception 'Invalid object path'; end if;
    new.version_number := 1;
    if new.previous_version_id is not null then
      select * into previous from public.attachments where id = new.previous_version_id;
      if previous.id is null or previous.owner_id <> new.owner_id or previous.workspace_id <> new.workspace_id or previous.bucket_id <> new.bucket_id or previous.status not in ('ready','archived') then raise exception 'Previous version is inaccessible'; end if;
      new.version_number := previous.version_number + 1;
    end if;
  end if;
  if new.transaction_id is not null and not exists(select 1 from public.transactions t where t.id = new.transaction_id and t.workspace_id = new.workspace_id and t.owner_id = new.owner_id) then raise exception 'Transaction must belong to file owner in this workspace'; end if;
  return new;
end $$;
create trigger validate_attachment before insert or update on public.attachments for each row execute function private.validate_attachment();

create function public.complete_attachment(upload uuid) returns void language plpgsql security definer set search_path = '' as $$
declare a public.attachments;
begin
  select * into a from public.attachments where id = upload for update;
  if a.id is null or a.owner_id is distinct from auth.uid() or not private.can_write(a.workspace_id) then raise exception 'File owner with write access required'; end if;
  if a.status = 'ready' then return; end if;
  if a.status <> 'uploading' then raise exception 'Upload is no longer pending'; end if;
  if not exists(select 1 from storage.objects o where o.bucket_id = a.bucket_id and o.name = a.object_path and (o.metadata->>'size')::bigint = a.size_bytes and split_part(lower(o.metadata->>'mimetype'),';',1) = a.mime_type) then raise exception 'Uploaded file not found or metadata does not match; retry the upload'; end if;
  update public.attachments set status = 'ready' where id = upload;
  if a.previous_version_id is not null then update public.attachments set status = 'archived' where id = a.previous_version_id; end if;
end $$;
create function public.set_attachment_status(upload uuid, target text) returns void language plpgsql security definer set search_path = '' as $$
declare a public.attachments;
begin
  select * into a from public.attachments where id = upload for update;
  if a.id is null or a.owner_id is distinct from auth.uid() or not private.can_write(a.workspace_id) then raise exception 'File owner with write access required'; end if;
  if target not in ('ready','archived') or a.status not in ('ready','archived') then raise exception 'Only completed files can be archived or restored'; end if;
  update public.attachments set status = target where id = upload;
end $$;
create function public.update_attachment_details(upload uuid, file_category text, expiry date, project uuid, ledger_entry uuid) returns void language plpgsql security definer set search_path = '' as $$
declare a public.attachments;
begin
  select * into a from public.attachments where id = upload for update;
  if a.id is null or a.owner_id is distinct from auth.uid() or not private.can_write(a.workspace_id) then raise exception 'File owner with write access required'; end if;
  if a.status not in ('ready','archived') then raise exception 'Complete the upload before editing'; end if;
  update public.attachments set category = trim(file_category), expires_on = expiry, project_id = project, transaction_id = ledger_entry where id = upload;
end $$;
create function public.cancel_attachment_upload(upload uuid) returns void language plpgsql security definer set search_path = '' as $$
declare a public.attachments;
begin
  select * into a from public.attachments where id = upload for update;
  if a.id is null or a.owner_id is distinct from auth.uid() or not private.can_write(a.workspace_id) then raise exception 'File owner with write access required'; end if;
  if a.status not in ('uploading','cancelled') then raise exception 'Completed files must be archived'; end if;
  update public.attachments set status = 'cancelled' where id = upload;
end $$;
create function public.remove_cancelled_attachment(upload uuid) returns void language plpgsql security definer set search_path = '' as $$
declare a public.attachments;
begin
  select * into a from public.attachments where id = upload for update;
  if a.id is null then return; end if;
  if a.owner_id is distinct from auth.uid() or not private.can_write(a.workspace_id) then raise exception 'File owner with write access required'; end if;
  if a.status <> 'cancelled' or exists(select 1 from storage.objects where bucket_id = a.bucket_id and name = a.object_path) then raise exception 'Cancel and clean up the unfinished object first'; end if;
  delete from public.attachments where id = upload;
end $$;
revoke all on function private.validate_attachment() from public,anon,authenticated;
revoke all on function public.complete_attachment(uuid), public.set_attachment_status(uuid,text), public.update_attachment_details(uuid,text,date,uuid,uuid), public.cancel_attachment_upload(uuid), public.remove_cancelled_attachment(uuid) from public,anon,authenticated;
grant execute on function public.complete_attachment(uuid), public.set_attachment_status(uuid,text), public.update_attachment_details(uuid,text,date,uuid,uuid), public.cancel_attachment_upload(uuid), public.remove_cancelled_attachment(uuid) to authenticated;

-- Storage bytes and metadata obey the same ownership and lifecycle boundaries.
drop policy private_storage_read on storage.objects;
drop policy private_storage_insert on storage.objects;
drop policy private_storage_delete on storage.objects;
create policy private_storage_read on storage.objects for select to authenticated using (
  bucket_id in ('personal-documents','financial-receipts') and exists(
    select 1 from public.attachments a where a.object_path = storage.objects.name and a.bucket_id = storage.objects.bucket_id
    and a.owner_id = (select auth.uid()) and private.is_member(a.workspace_id))
);
create policy private_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id in ('personal-documents','financial-receipts') and exists(
    select 1 from public.attachments a where a.object_path = storage.objects.name and a.bucket_id = storage.objects.bucket_id
    and a.owner_id = (select auth.uid()) and a.status = 'uploading' and private.can_write(a.workspace_id))
);
create policy private_storage_delete on storage.objects for delete to authenticated using (
  bucket_id in ('personal-documents','financial-receipts') and exists(
    select 1 from public.attachments a where a.object_path = storage.objects.name and a.bucket_id = storage.objects.bucket_id
    and a.owner_id = (select auth.uid()) and a.status in ('uploading','cancelled') and private.can_write(a.workspace_id))
);
