-- Disposable records and identities only; all changes are rolled back. No Storage bytes, mail or credentials are created.
begin;
create temporary table lifeos_asset_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;asset uuid:=gen_random_uuid();file uuid:=gen_random_uuid();plan uuid:=gen_random_uuid();service uuid:=gen_random_uuid();today date;denied boolean;ledger integer;
begin
  insert into auth.users(id,raw_user_meta_data) values(a,'{"display_name":"Disposable asset check"}'),(b,'{"display_name":"Disposable asset viewer"}');
  perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
  w:=public.create_workspace('Disposable asset check');perform public.set_workspace_member(w,b,'viewer');today:=(now() at time zone 'Asia/Kolkata')::date;
  insert into public.attachments(id,workspace_id,owner_id,name,object_path,mime_type,size_bytes)values(file,w,a,'Synthetic warranty.pdf',a::text||'/'||w::text||'/'||file::text||'.pdf','application/pdf',10);
  reset role;update public.attachments set status='ready' where id=file;set local role authenticated;
  perform public.save_asset(asset,w,null,'Synthetic washer','Appliance','Example','A','SAMPLE-1','Home','2025-01-01',500,'INR',today,'Synthetic only',array[file]);
  perform public.save_asset(asset,w,null,'Ignored retry','Other','','','','',null,null,'USD',null,'',array[]::uuid[]);
  if not exists(select 1 from public.assets where id=asset and name='Synthetic washer' and revision=1) or (select count(*) from public.asset_documents where asset_id=asset)<>1 then raise exception 'Asset retry changed records';end if;
  denied:=false;begin perform public.save_asset(asset,w,1,'Bad link','Other','','','','',null,null,'INR',null,'',array[gen_random_uuid()]);exception when others then denied:=true;end;
  if not denied or not exists(select 1 from public.assets where id=asset and revision=1) then raise exception 'Link validation or atomicity failed';end if;
  perform public.save_maintenance_plan(plan,w,null,asset,'Clean filter','2025-01-31','monthly','Synthetic only');
  perform public.save_maintenance_plan(plan,w,null,asset,'Ignored retry',today,'once','');
  perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,true,30,7);
  reset role;perform public.deliver_due_reminders();perform public.deliver_due_reminders();
  if (select count(*) from public.notifications where owner_id=a and source_id in(asset,plan) and dismissed_at is null)<>2 then raise exception 'Asset reminders missing or duplicated';end if;
  set local role authenticated;select count(*) into ledger from public.transactions where workspace_id=w;
  perform public.record_maintenance(service,plan,1,'2025-01-31',today,10,'Synthetic service');perform public.record_maintenance(service,plan,1,'2025-01-31',today,999,'Retry ignored');
  if (select count(*) from public.maintenance_logs where plan_id=plan)<>1 or not exists(select 1 from public.maintenance_plans where id=plan and revision=2 and next_on='2025-02-28') or (select count(*) from public.transactions where workspace_id=w)<>ledger then raise exception 'Service replay, month-end date or Finance isolation failed';end if;
  denied:=false;begin perform public.record_maintenance(gen_random_uuid(),plan,1,'2025-01-31',today,10,'Stale');exception when others then denied:=true;end;
  if not denied then raise exception 'Stale completion accepted';end if;
  perform public.set_asset_status(asset,1,'retired');
  if exists(select 1 from public.notifications where source_id in(asset,plan) and dismissed_at is null) or (select count(*) from public.maintenance_logs where asset_id=asset)<>1 then raise exception 'Retirement cleanup or history preservation failed';end if;
  perform public.set_asset_status(asset,2,'active');perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7);
  if not exists(select 1 from public.app_settings where id=a and asset_reminders) then raise exception 'Legacy settings lost asset preferences';end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.assets where workspace_id=w) or exists(select 1 from public.asset_documents where workspace_id=w) or exists(select 1 from public.maintenance_logs where workspace_id=w) then raise exception 'Viewer privacy failed';end if;
  denied:=false;begin perform public.record_maintenance(gen_random_uuid(),plan,2,'2025-02-28',today,10,'Forbidden');exception when others then denied:=true;end;
  if not denied then raise exception 'Viewer completion accepted';end if;
  reset role;insert into lifeos_asset_smoke values('Asset privacy, atomic document links, service replay/revision safety, month-end dates, Finance isolation and reminder cleanup passed; synthetic records rolled back.');
end $$;
select * from lifeos_asset_smoke;
rollback;
