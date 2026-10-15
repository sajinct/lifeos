-- Disposable synthetic metadata only. Rollback removes every test identity and record.
begin;
create temporary table lifeos_insurance_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;asset uuid:=gen_random_uuid();member_asset uuid:=gen_random_uuid();policy uuid:=gen_random_uuid();member_policy uuid:=gen_random_uuid();file uuid:=gen_random_uuid();req uuid:=gen_random_uuid();member_req uuid:=gen_random_uuid();path text;details jsonb;denied boolean;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable insurance owner"}'),(b,'{"display_name":"Disposable member policy owner"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable asset insurance review','family');perform public.set_workspace_member(w,b,'editor');
 perform public.save_asset(asset,w,null,'Synthetic vehicle','Vehicle','','','','',null,null,'INR',null,'','{}');
 path:=a::text||'/'||w::text||'/'||file::text||'.txt';
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values(file,w,'Synthetic policy.txt',path,'text/plain',5);
 insert into storage.objects(bucket_id,name,metadata)values('personal-documents',path,'{"size":5,"mimetype":"text/plain"}');perform public.complete_attachment(file);
 details:='{"title":"Vehicle policy","provider":"Example insurer","policy_number":"SYNTHETIC-1","starts_on":"2026-01-01","ends_on":"2026-12-31","coverage_amount":10000,"premium_amount":125.25,"currency":"INR","premium_frequency":"yearly","notes":"Synthetic private policy"}';
 perform public.save_asset_insurance(req,policy,w,null,asset,details,array[file]);perform public.save_asset_insurance(req,policy,w,null,asset,details,array[file]);
 if (select revision from public.asset_insurance where id=policy)<>1 or not exists(select 1 from public.asset_insurance_documents where insurance_id=policy and attachment_id=file) then raise exception 'Initial policy or exact version failed';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.asset_insurance where workspace_id=w) or exists(select 1 from public.asset_insurance_documents where workspace_id=w) then raise exception 'Member read private policy';end if;
 perform public.save_asset(member_asset,w,null,'Synthetic member asset','Other','','','','',null,null,'INR',null,'','{}');
 denied:=false;begin perform public.save_asset_insurance(gen_random_uuid(),gen_random_uuid(),w,null,member_asset,details,array[file]);exception when others then denied:=true;end;if not denied then raise exception 'Foreign document linked';end if;
 perform public.save_asset_insurance(member_req,member_policy,w,null,member_asset,details,'{}');
 perform set_config('request.jwt.claim.sub',a::text,true);if exists(select 1 from public.asset_insurance where id=member_policy) then raise exception 'Workspace owner read member policy';end if;
 denied:=false;begin perform public.save_asset_insurance(gen_random_uuid(),policy,w,1,asset,jsonb_set(details,'{premium_amount}','1.001'),array[file]);exception when others then denied:=true;end;if not denied or (select revision from public.asset_insurance where id=policy)<>1 then raise exception 'Invalid precision changed metadata';end if;
 perform public.set_asset_insurance_state(gen_random_uuid(),policy,1,true,true);perform public.save_asset_insurance(req,policy,w,null,asset,details,array[file]);
 if not exists(select 1 from public.asset_insurance where id=policy and revision=2 and cancelled and archived) then raise exception 'Old retry undid later state';end if;
 perform public.set_asset_insurance_state(gen_random_uuid(),policy,2,false,false);perform public.set_asset_status(asset,1,'sold');
 denied:=false;begin perform public.save_asset_insurance(gen_random_uuid(),policy,w,3,asset,details,array[file]);exception when others then denied:=true;end;if not denied then raise exception 'Inactive asset accepted metadata edits';end if;
 perform public.set_asset_insurance_state(gen_random_uuid(),policy,3,true,true);perform public.set_asset_status(asset,2,'active');
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.save_asset_insurance(member_req,member_policy,w,null,member_asset,details,'{}');exception when others then denied:=true;end;if not denied then raise exception 'Viewer cached save accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.remove_workspace_member(w,b);perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.asset_insurance where id=member_policy) then raise exception 'Removed member retained access';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);if exists(select 1 from public.transactions where workspace_id=w) then raise exception 'Insurance created Finance entries';end if;
 reset role;insert into lifeos_insurance_smoke values('Private insurance and document ownership, workspace-owner isolation, exact retries, revision/precision validation, cancellation/archive corrections, inactive asset guards, current-role checks and Finance isolation passed. All synthetic metadata rolled back; no files, messages or payments transmitted.');
end $$;
select * from lifeos_insurance_smoke;
rollback;
