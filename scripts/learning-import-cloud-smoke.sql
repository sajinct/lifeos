-- Synthetic Learning import records only; all identities/content roll back.
begin;
create temporary table lifeos_learning_import_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;item uuid;request uuid:=gen_random_uuid();payload jsonb;answer jsonb;preview jsonb;denied boolean;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable import owner"}'),(b,'{"display_name":"Disposable import member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable Learning import review','family');perform public.set_workspace_member(w,b,'editor');perform set_config('request.jwt.claim.sub',b::text,true);
 payload:='[{"source_id":"synthetic-learning","kind":"course","title":"Synthetic course","provider":"Example","url":"https://example.com/@course","goal":"Learn SQL","due_on":"2027-01-31","notes":"Literal <script>text</script>","status":"completed","completed_on":"2026-01-01","archived":true,"units":[{"position":1,"title":"First lesson","notes":"Keep history","done":true,"archived":false}]}]';
 preview:=public.preview_learning_import(w,payload);if preview->0->>'state'<>'ready' then raise exception 'New learning preview failed';end if;
 answer:=public.import_learning_json(request,w,payload);if answer<>jsonb_build_object('items_imported',1,'lessons_imported',1,'skipped',0) then raise exception 'Learning import counts failed';end if;if public.import_learning_json(request,w,payload)<>answer then raise exception 'Exact batch retry failed';end if;
 select id into item from public.learning_items where workspace_id=w and owner_id=b;if item is null or not exists(select 1 from public.learning_items where id=item and archived and completed_on='2026-01-01') or not exists(select 1 from public.learning_units where item_id=item and done and notes='Keep history') then raise exception 'Import lost history';end if;
 perform public.set_learning_state(gen_random_uuid(),item,1,'completed',false);perform public.set_learning_state(gen_random_uuid(),item,2,'active',true);
 if public.import_learning_json(gen_random_uuid(),w,payload)->>'skipped'<>'1' or not exists(select 1 from public.learning_items where id=item and status='active' and archived and revision=3) then raise exception 'Reupload overwrote destination edits';end if;
 preview:=public.preview_learning_import(w,payload);if preview->0->>'state'<>'duplicate' then raise exception 'Reupload preview failed';end if;
 denied:=false;begin perform public.import_learning_json(gen_random_uuid(),w,jsonb_build_array((payload->0)||'{"source_id":"atomic-new"}',(payload->0)||'{"title":"Changed source"}'));exception when others then denied:=true;end;if not denied then raise exception 'Conflicting source accepted';end if;
 preview:=public.preview_learning_import(w,jsonb_build_array((payload->0)||'{"source_id":"atomic-new"}'));if preview->0->>'state'<>'ready' then raise exception 'Import did not roll back source binding';end if;
 denied:=false;begin perform public.import_learning_json(gen_random_uuid(),w,jsonb_build_array((payload->0)||jsonb_build_object('owner_id',a)));exception when others then denied:=true;end;if not denied then raise exception 'Forged owner accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);if exists(select 1 from public.learning_items where id=item) or exists(select 1 from public.learning_units where item_id=item) then raise exception 'Workspace owner read member learning';end if;preview:=public.preview_learning_import(w,payload);if preview->0->>'state'<>'ready' then raise exception 'Member source bindings leaked to workspace owner';end if;
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.import_learning_json(request,w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay accepted';end if;
 denied:=false;begin perform 1 from private.learning_import_sources;exception when others then denied:=true;end;if not denied then raise exception 'Private import metadata accessible';end if;
 reset role;insert into lifeos_learning_import_smoke values('Learning JSON preview, exact batch replay, fresh private IDs, lesson/archive/completion history, immutable source bindings, conflict rollback, forged-field denial and workspace-owner/viewer isolation passed. Synthetic records rolled back; no files or messages transmitted.');
end $$;
select * from lifeos_learning_import_smoke;
rollback;
