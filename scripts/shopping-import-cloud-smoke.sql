-- All synthetic identities, lists, items and audit rows roll back. No files or mail.
begin;
create temporary table lifeos_shopping_import_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;other uuid;request uuid:=gen_random_uuid();member_request uuid:=gen_random_uuid();l uuid;payload jsonb;answer jsonb;denied boolean;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable Shopping importer"}'),(b,'{"display_name":"Disposable Shopping reader"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable Shopping import review','family');other:=public.create_workspace('Disposable separate Shopping workspace','personal');perform public.set_workspace_member(w,b,'editor');
 payload:='[{"source_id":"portable-groceries","kind":"grocery","title":" Imported groceries ","notes":"Private import notes","archived":false,"items":[{"position":1,"name":"Rice","category":"Food","quantity":1.25,"unit":"kg","notes":"","checked":true,"archived":true}]}]';
 answer:=public.import_shopping_json(request,w,payload);if answer->>'lists_imported'<>'1' or answer->>'items_imported'<>'1' then raise exception 'Imported counts differ';end if;
 perform public.import_shopping_json(request,w,payload);
 select id into l from public.shopping_lists where workspace_id=w;
 if (select count(*) from public.shopping_lists where workspace_id=w)<>1 or (select visibility from public.shopping_lists where id=l)<>'private' or not exists(select 1 from public.shopping_items where list_id=l and quantity=1.25 and checked and checked_by=a and archived) then raise exception 'Import identity, privacy or state failed';end if;
 perform public.set_shopping_archived(gen_random_uuid(),l,1,true);answer:=public.import_shopping_json(gen_random_uuid(),w,payload);
 if answer->>'skipped'<>'1' or not (select archived from public.shopping_lists where id=l) then raise exception 'Reupload undid later state';end if;
 denied:=false;begin perform public.import_shopping_json(gen_random_uuid(),w,jsonb_set(payload,'{0,title}','"Changed source"'));exception when others then denied:=true;end;if not denied then raise exception 'Changed source accepted';end if;
 denied:=false;begin perform public.import_shopping_json(gen_random_uuid(),w,jsonb_build_array(jsonb_set(payload->0,'{source_id}','"fresh-atomic"'),jsonb_set(payload->0,'{notes}','"Changed source"')));exception when others then denied:=true;end;if not denied or (select count(*) from public.shopping_lists where workspace_id=w)<>1 then raise exception 'Atomic conflict rollback failed';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.shopping_lists where id=l) or exists(select 1 from public.shopping_items where list_id=l) then raise exception 'Private imported records leaked';end if;
 answer:=public.import_shopping_json(member_request,w,payload);if answer->>'lists_imported'<>'1' then raise exception 'Member source isolation failed';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);if exists(select 1 from public.shopping_lists where workspace_id=w and owner_id=b) then raise exception 'Workspace owner sees member-private imports';end if;
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.preview_shopping_import(w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Viewer preview accepted';end if;
 denied:=false;begin perform public.import_shopping_json(member_request,w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Viewer cached retry accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);answer:=public.import_shopping_json(gen_random_uuid(),other,payload);if answer->>'lists_imported'<>'1' then raise exception 'Workspace source isolation failed';end if;
 denied:=false;begin perform public.import_shopping_json(request,other,payload);exception when others then denied:=true;end;if not denied then raise exception 'Cross-workspace request reused';end if;
 reset role;insert into lifeos_shopping_import_smoke values('Private imported lists, quantities/checks/archives, immutable source identities, exact retries, duplicate skips, conflict rollback, member/workspace isolation and viewer denial passed. All synthetic records rolled back; no messages, files or payments sent.');
end $$;
select * from lifeos_shopping_import_smoke;
rollback;
