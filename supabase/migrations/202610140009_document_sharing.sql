-- Exact-version grants never broaden attachment metadata or Storage RLS.
create table public.document_shares (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,
 owner_id uuid not null references public.profiles(id),recipient_id uuid not null references public.profiles(id),
 attachment_id uuid not null,revoked boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(owner_id<>recipient_id),foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade,
 unique(attachment_id,recipient_id)
);
create index document_shares_recipient_idx on public.document_shares(workspace_id,recipient_id);
create table private.document_share_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null);
create function private.read_document_share(w uuid,o uuid,r uuid,revoked boolean) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid())
 and (o=auth.uid() or (r=auth.uid() and not revoked and exists(select 1 from public.workspace_members where workspace_id=w and user_id=o)))
$$;
alter table public.document_shares enable row level security;
create policy document_shares_read on public.document_shares for select to authenticated using(private.read_document_share(workspace_id,owner_id,recipient_id,revoked));
revoke all on public.document_shares from public,anon,authenticated;
grant select on public.document_shares to authenticated;

create function public.set_document_share(req uuid,entry uuid,w uuid,source uuid,recipient uuid,expected_revision integer,is_revoked boolean) returns void language plpgsql security definer set search_path='' as $$
declare a public.attachments;s public.document_shares;payload jsonb;prior private.document_share_requests;begin
 if auth.uid() is null or req is null or entry is null or w is null or source is null or recipient is null or is_revoked is null then raise exception 'Valid document sharing request required';end if;
 -- Membership locks precede grant locks, matching member deletion and its revocation trigger.
 perform 1 from public.workspace_members where workspace_id=w and user_id in(auth.uid(),recipient) order by user_id for share;
 if not private.is_member(w) then raise exception 'Current workspace membership required';end if;
 if not is_revoked and not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,43));
 select * into a from public.attachments where id=source and workspace_id=w for share;
 if a.id is null or a.owner_id<>auth.uid() or a.bucket_id<>'personal-documents' or a.status not in('ready','archived') then raise exception 'Choose your own completed document version';end if;
 if recipient=auth.uid() then raise exception 'Choose another workspace member';end if;
 if not is_revoked and not exists(select 1 from public.workspace_members where workspace_id=w and user_id=recipient) then raise exception 'Choose a current workspace member';end if;
 if not is_revoked and not exists(select 1 from storage.objects where bucket_id=a.bucket_id and name=a.object_path and (metadata->>'size')::bigint=a.size_bytes and split_part(lower(metadata->>'mimetype'),';',1)=a.mime_type) then raise exception 'Document bytes are unavailable';end if;
 select * into s from public.document_shares where id=entry for update;
 if s.id is not null and (s.owner_id<>auth.uid() or s.workspace_id<>w or s.attachment_id<>source or s.recipient_id<>recipient) then raise exception 'Document share binding cannot change';end if;
 payload:=jsonb_build_array('set',entry,w,source,recipient,expected_revision,is_revoked);
 select * into prior from private.document_share_requests where id=req;
 if prior.id is not null then
  if prior.owner_id<>auth.uid() or prior.workspace_id<>w or prior.payload<>payload then raise exception 'Request identity was already used';end if;return;
 end if;
 if s.id is null then
  if expected_revision is not null or is_revoked then raise exception 'Refresh document shares before changing access';end if;
  if (select count(*) from public.document_shares where attachment_id=source)>=200 then raise exception 'This version already has 200 sharing records';end if;
  insert into public.document_shares(id,workspace_id,owner_id,recipient_id,attachment_id)values(entry,w,auth.uid(),recipient,source);
 else
  if expected_revision is null or s.revision<>expected_revision then raise exception 'Document sharing changed; refresh and try again';end if;
  update public.document_shares set revoked=is_revoked,revision=revision+1,updated_at=now() where id=entry;
 end if;
 insert into private.document_share_requests values(req,w,auth.uid(),payload);
end $$;

create function private.end_member_document_shares() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.document_shares set revoked=true,revision=revision+1,updated_at=now()
 where workspace_id=old.workspace_id and not revoked and (owner_id=old.user_id or recipient_id=old.user_id);
 return old;
end $$;
create trigger end_member_document_shares after delete on public.workspace_members for each row execute function private.end_member_document_shares();

create function public.document_share_catalog(w uuid,after_id uuid default null) returns table(
 id uuid,workspace_id uuid,owner_id uuid,recipient_id uuid,attachment_id uuid,revoked boolean,revision integer,
 name text,mime_type text,size_bytes bigint,version_number integer,sender_name text,recipient_name text
) language sql stable security definer set search_path='' as $$
 select s.id,s.workspace_id,s.owner_id,s.recipient_id,s.attachment_id,s.revoked,s.revision,
 a.name,a.mime_type,a.size_bytes,a.version_number,p.display_name,case when exists(select 1 from public.workspace_members where workspace_id=w and user_id=s.recipient_id) then r.display_name else 'Former member' end
 from public.document_shares s join public.attachments a on a.id=s.attachment_id
 join public.profiles p on p.id=s.owner_id join public.profiles r on r.id=s.recipient_id
 where s.workspace_id=w and private.read_document_share(s.workspace_id,s.owner_id,s.recipient_id,s.revoked)
 and a.bucket_id='personal-documents' and a.status in('ready','archived') and (after_id is null or s.id>after_id)
 order by s.id limit 500
$$;
-- Called with the authenticated user's JWT by the byte proxy. Paths alone confer no Storage access.
create function public.document_share_download(entry uuid) returns table(bucket_id text,object_path text,size_bytes bigint,revision integer)
language sql stable security definer set search_path='' as $$
 select a.bucket_id,a.object_path,a.size_bytes,s.revision from public.document_shares s join public.attachments a on a.id=s.attachment_id
 where s.id=entry and not s.revoked and auth.uid() in(s.owner_id,s.recipient_id)
 and exists(select 1 from public.workspace_members where workspace_id=s.workspace_id and user_id=auth.uid())
 and exists(select 1 from public.workspace_members where workspace_id=s.workspace_id and user_id=s.owner_id)
 and exists(select 1 from public.workspace_members where workspace_id=s.workspace_id and user_id=s.recipient_id)
 and a.bucket_id='personal-documents' and a.status in('ready','archived')
$$;
revoke all on function private.read_document_share(uuid,uuid,uuid,boolean),private.end_member_document_shares() from public,anon,authenticated;
grant execute on function private.read_document_share(uuid,uuid,uuid,boolean) to authenticated;
revoke all on function public.set_document_share(uuid,uuid,uuid,uuid,uuid,integer,boolean),public.document_share_catalog(uuid,uuid),public.document_share_download(uuid) from public,anon,authenticated;
grant execute on function public.set_document_share(uuid,uuid,uuid,uuid,uuid,integer,boolean),public.document_share_catalog(uuid,uuid),public.document_share_download(uuid) to authenticated;
