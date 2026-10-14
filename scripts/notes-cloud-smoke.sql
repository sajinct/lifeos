-- Synthetic Notes checks; all identities, files, metadata and changes roll back.
begin;
create temporary table lifeos_notes_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;n uuid:=gen_random_uuid();journal uuid:=gen_random_uuid();file uuid:=gen_random_uuid();request uuid:=gen_random_uuid();path text;denied boolean;r public.notes;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable Notes owner"}'),(b,'{"display_name":"Disposable Notes member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable Notes review','family');perform public.set_workspace_member(w,b,'editor');perform set_config('request.jwt.claim.sub',b::text,true);
 path:=b::text||'/'||w::text||'/'||file::text||'.txt';
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values(file,w,'Synthetic private context.txt',path,'text/plain',5);
 insert into storage.objects(bucket_id,name,metadata)values('personal-documents',path,'{"size":5,"mimetype":"text/plain"}');perform public.complete_attachment(file);
 perform public.save_note(request,n,w,null,'Synthetic shared note','  <script>literal</script>  ',null,array['Ideas',' planning ','ideas'],null,'workspace',array[file]);
 perform public.save_note(request,n,w,null,'Synthetic shared note','  <script>literal</script>  ',null,array['Ideas',' planning ','ideas'],null,'workspace',array[file]);
 select * into r from public.notes where id=n;if r.revision<>1 or r.body<>'  <script>literal</script>  ' or r.tags<>array['ideas','planning'] then raise exception 'Note content, tags or retry failed';end if;
 perform public.save_note(gen_random_uuid(),journal,w,null,'Synthetic private journal','Private reflection',null,'{}','2026-10-14','private','{}');
 request:=gen_random_uuid();perform public.set_note_archived(request,journal,1,true);perform public.set_note_archived(request,journal,1,true);
 denied:=false;begin perform public.save_note(gen_random_uuid(),gen_random_uuid(),w,null,'Duplicate journal','Body',null,'{}','2026-10-14','private','{}');exception when others then denied:=true;end;if not denied then raise exception 'Archived journal date reused';end if;
 perform public.set_note_archived(gen_random_uuid(),journal,2,false);
 denied:=false;begin delete from public.notes where id=n;exception when others then denied:=true;end;if not denied then raise exception 'Permanent note delete accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.notes where id=journal) or exists(select 1 from public.note_documents where note_id=n) or exists(select 1 from public.attachments where id=file) then raise exception 'Workspace owner read private journal or file metadata';end if;
 perform public.save_note(gen_random_uuid(),n,w,1,'Owner edited shared text','Updated shared text',null,'{}',null,'workspace',null);
 denied:=false;begin perform public.save_note(gen_random_uuid(),n,w,2,'File takeover','Body',null,'{}',null,'workspace',array[file]);exception when others then denied:=true;end;if not denied then raise exception 'Shared note editor took over private files';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);if not exists(select 1 from public.note_documents where note_id=n and attachment_id=file and owner_id=b) then raise exception 'Shared owner edit lost private file link';end if;
 denied:=false;begin perform public.save_note(gen_random_uuid(),n,w,1,'Stale edit','Body',null,'{}',null,'workspace',array[file]);exception when others then denied:=true;end;if not denied then raise exception 'Stale note edit accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.set_note_archived(request,journal,1,true);exception when others then denied:=true;end;if not denied then raise exception 'Viewer retry accepted';end if;
 reset role;insert into lifeos_notes_smoke values('Literal note content, normalized tags, exact save/archive retries, revision conflicts, private journals and date uniqueness, private document/version ownership on shared notes, reversible archives, permanent-delete denial and viewer isolation passed. All synthetic records rolled back; no file bytes, emails or invitations transmitted.');
end $$;
select * from lifeos_notes_smoke;
rollback;
