-- Disposable learning, notes and file metadata only. All changes roll back.
begin;
create temporary table lifeos_learning_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;i uuid:=gen_random_uuid();u uuid:=gen_random_uuid();n uuid;f uuid:=gen_random_uuid();request uuid:=gen_random_uuid();path text;denied boolean;r public.learning_items;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable Learning owner"}'),(b,'{"display_name":"Disposable Learning member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable Learning review','family');perform public.set_workspace_member(w,b,'editor');perform set_config('request.jwt.claim.sub',b::text,true);
 insert into public.notes(workspace_id,title)values(w,'Synthetic study note')returning id into n;
 path:=b::text||'/'||w::text||'/'||f::text||'.txt';
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values(f,w,'Synthetic certificate.txt',path,'text/plain',5);
 insert into storage.objects(bucket_id,name,metadata)values('personal-documents',path,'{"size":5,"mimetype":"text/plain"}');perform public.complete_attachment(f);
 perform public.save_learning_item(request,i,w,null,'course','Synthetic learning','Example','https://example.com/@course','Learn SQL','2026-12-31','Literal <script>text</script>',array[n],'{}',array[f]);
 perform public.save_learning_item(request,i,w,null,'course','Synthetic learning','Example','https://example.com/@course','Learn SQL','2026-12-31','Literal <script>text</script>',array[n],'{}',array[f]);
 select * into r from public.learning_items where id=i;if r.revision<>1 or r.owner_id<>b or r.status<>'active' then raise exception 'Learning creation/retry failed';end if;
 request:=gen_random_uuid();perform public.save_learning_unit(request,u,i,null,1,'First lesson','Private lesson',false,false);perform public.save_learning_unit(request,u,i,null,1,'First lesson','Private lesson',false,false);
 select * into r from public.learning_items where id=i;if r.revision<>2 then raise exception 'Lesson replay duplicated progress';end if;
 denied:=false;begin perform public.set_learning_state(gen_random_uuid(),i,2,'completed',false);exception when others then denied:=true;end;if not denied then raise exception 'Incomplete course marked complete';end if;
 perform public.save_learning_unit(gen_random_uuid(),u,i,1,2,'First lesson','Private lesson',true,false);select * into r from public.learning_items where id=i;if r.status<>'completed' or r.completed_on is null then raise exception 'Final lesson did not complete course';end if;
 perform public.save_learning_unit(gen_random_uuid(),u,i,2,3,'First lesson','Private lesson',false,false);select * into r from public.learning_items where id=i;if r.status<>'active' or r.completed_on is not null then raise exception 'Lesson reopen did not clear completion';end if;
 denied:=false;begin perform public.save_learning_unit(gen_random_uuid(),u,i,2,3,'Stale','',true,false);exception when others then denied:=true;end;if not denied then raise exception 'Stale lesson accepted';end if;
 perform public.set_learning_state(gen_random_uuid(),i,4,'paused',false);denied:=false;begin perform public.save_learning_unit(gen_random_uuid(),gen_random_uuid(),i,null,5,'Paused write','',false,false);exception when others then denied:=true;end;if not denied then raise exception 'Paused learning accepted lesson change';end if;
 perform public.set_learning_state(gen_random_uuid(),i,5,'active',false);request:=gen_random_uuid();perform public.set_learning_state(request,i,6,'active',true);perform public.set_learning_state(request,i,6,'active',true);perform public.set_learning_state(gen_random_uuid(),i,7,'active',false);
 if not exists(select 1 from public.learning_documents where item_id=i and attachment_id=f and purpose='certificate') then raise exception 'Archive lost certificate link';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.learning_items where id=i) or exists(select 1 from public.learning_units where item_id=i) or exists(select 1 from public.learning_notes where item_id=i) or exists(select 1 from public.learning_documents where item_id=i) or exists(select 1 from public.attachments where id=f) then raise exception 'Workspace owner read member learning or certificate';end if;
 denied:=false;begin perform public.save_learning_item(gen_random_uuid(),gen_random_uuid(),w,null,'book','Foreign source','','','','2026-12-31','',array[n],'{}','{}');exception when others then denied:=true;end;if not denied then raise exception 'Foreign note link accepted';end if;
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.set_learning_state(request,i,6,'active',true);exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay accepted';end if;
 denied:=false;begin delete from public.learning_items where id=i;exception when others then denied:=true;end;if not denied then raise exception 'Direct learning delete accepted';end if;
 reset role;insert into lifeos_learning_smoke values('Private learning and lesson progress, exact retries, revision conflicts, final-lesson completion/reopen, pause/archive/restore, owned note/certificate versions, workspace-owner isolation and viewer denial passed. All synthetic records rolled back; no file bytes, email or invitations transmitted.');
end $$;
select * from lifeos_learning_smoke;
rollback;
