-- Synthetic metadata only; all identities, reservations and grants roll back.
begin;
create temporary table lifeos_document_share_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();c uuid:=gen_random_uuid();w uuid;f uuid:=gen_random_uuid();next uuid:=gen_random_uuid();s uuid:=gen_random_uuid();request uuid:=gen_random_uuid();path text;denied boolean;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable document owner"}'),(b,'{"display_name":"Disposable document reader"}'),(c,'{"display_name":"Disposable other member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable document sharing review','family');perform public.set_workspace_member(w,b,'viewer');perform public.set_workspace_member(w,c,'editor');
 path:=a::text||'/'||w::text||'/'||f::text||'.txt';
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values(f,w,'Synthetic document.txt',path,'text/plain',5);
 insert into storage.objects(bucket_id,name,metadata)values('personal-documents',path,'{"size":5,"mimetype":"text/plain"}');perform public.complete_attachment(f);
 perform public.set_document_share(request,s,w,f,b,null,false);perform public.set_document_share(request,s,w,f,b,null,false);
 path:=a::text||'/'||w::text||'/'||next::text||'.txt';
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes,previous_version_id)values(next,w,'Synthetic newer version.txt',path,'text/plain',5,f);
 insert into storage.objects(bucket_id,name,metadata)values('personal-documents',path,'{"size":5,"mimetype":"text/plain"}');perform public.complete_attachment(next);
 perform set_config('request.jwt.claim.sub',b::text,true);
 if (select count(*) from public.document_share_catalog(w))<>1 or (select version_number from public.document_share_catalog(w))<>1 then raise exception 'Exact selected version sharing failed';end if;
 if exists(select 1 from public.attachments where workspace_id=w) or exists(select 1 from storage.objects where name like '%/'||w::text||'/%') then raise exception 'Shared reader has private metadata or direct Storage access';end if;
 if (select count(*) from public.document_share_download(s))<>1 then raise exception 'Reader download access check failed';end if;
 denied:=false;begin perform public.set_document_share(gen_random_uuid(),s,w,f,b,1,true);exception when others then denied:=true;end;if not denied then raise exception 'Reader modified sharing';end if;
 perform set_config('request.jwt.claim.sub',c::text,true);if exists(select 1 from public.document_share_catalog(w)) or exists(select 1 from public.document_share_download(s)) then raise exception 'Other member can read grant';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_document_share(gen_random_uuid(),s,w,f,b,1,true);perform public.set_document_share(request,s,w,f,b,null,false);
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.document_share_download(s)) then raise exception 'Revoke or old replay restored download';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_document_share(gen_random_uuid(),s,w,f,b,2,false);perform public.remove_workspace_member(w,b);perform public.set_workspace_member(w,b,'viewer');
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.document_share_download(s)) then raise exception 'Rejoining silently restored grant';end if;
 reset role;insert into lifeos_document_share_smoke values('Exact old-version sharing, minimal metadata, direct Storage isolation, viewer denial, other-member isolation, exact retries, revocation and member-removal/rejoin revocation passed. All synthetic metadata rolled back; no file bytes or messages transmitted.');
end $$;
select * from lifeos_document_share_smoke;
rollback;
