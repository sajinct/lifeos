-- Disposable private Tasks/Notes import checks; every write is rolled back.
begin;
create temporary table lifeos_record_import_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;p uuid;batch uuid:=gen_random_uuid();payload jsonb;answer jsonb;denied boolean;task uuid;note uuid;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable record owner"}'),(b,'{"display_name":"Disposable importing member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable record import review','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.projects(workspace_id,title,visibility)values(w,'Synthetic shared project','workspace')returning id into p;
 perform set_config('request.jwt.claim.sub',b::text,true);
 payload:=jsonb_build_object('projects',jsonb_build_array(jsonb_build_object('source_id','synthetic-project','target_id',p)),'rows',
 '[{"kind":"task","source_id":"synthetic-task","project_source":"synthetic-project","title":"Synthetic imported task","status":"in_progress","priority":"high","due_date":"2027-01-01","body":null},{"kind":"note","source_id":"synthetic-note","project_source":"synthetic-project","title":"Synthetic imported note","status":null,"priority":null,"due_date":null,"body":"Synthetic literal content"}]'::jsonb);
 answer:=public.import_record_json(batch,w,payload);
 if answer<>jsonb_build_object('tasks_imported',1,'notes_imported',1,'skipped',0) or public.import_record_json(batch,w,payload)<>answer then raise exception 'Import/retry result failed';end if;
 select task_id into task from public.record_json_links where workspace_id=w and record_kind='task' and source_id='synthetic-task';select note_id into note from public.record_json_links where workspace_id=w and record_kind='note' and source_id='synthetic-note';
 if not exists(select 1 from public.tasks where id=task and owner_id=b and visibility='private' and assignee_id is null and list_id is null and series_id is null and status='in_progress') then raise exception 'Imported task inherited unsupported permissions/structure';end if;
 if public.import_record_json(gen_random_uuid(),w,payload)<>jsonb_build_object('tasks_imported',0,'notes_imported',0,'skipped',2) then raise exception 'Reupload duplicated records';end if;
 denied:=false;begin perform public.import_record_json(gen_random_uuid(),w,jsonb_set(payload,'{rows,1,body}','"Changed source content"'));exception when others then denied:=true;end;if not denied then raise exception 'Changed source ID accepted';end if;
 denied:=false;begin perform public.import_record_json(gen_random_uuid(),w,'{"projects":[],"rows":[{"kind":"note","source_id":"rollback-first","project_source":null,"title":"Rollback candidate","status":null,"priority":null,"due_date":null,"body":"Synthetic"},{"kind":"task","source_id":"bad-date","project_source":null,"title":"Invalid date","status":"todo","priority":"low","due_date":"2024-02-30","body":null}]}');exception when others then denied:=true;end;
 if not denied or exists(select 1 from public.notes where workspace_id=w and title='Rollback candidate') then raise exception 'Invalid batch left partial records';end if;
 perform public.set_task_status(task,1,'done');reset role;delete from public.notes where id=note;set local role authenticated;
 if (public.import_record_json(gen_random_uuid(),w,payload)->>'skipped')::integer<>2 or exists(select 1 from public.notes where id=note) then raise exception 'Reupload overwrote edits or resurrected deletion';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.tasks where id=task) or exists(select 1 from public.record_json_links where workspace_id=w) or exists(select 1 from public.record_json_batches where workspace_id=w) then raise exception 'Shared project owner read private imported records';end if;
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.import_record_json(batch,w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay was authorized';end if;
 reset role;insert into lifeos_record_import_smoke values('Atomic private task/note imports, explicit shared-project mapping without permission inheritance, stable retries, duplicate reuploads, source conflicts, invalid-date rollback, preserved edits/deletions and viewer isolation passed. All synthetic records rolled back.');
end $$;
select * from lifeos_record_import_smoke;
rollback;
