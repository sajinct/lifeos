-- Disposable synthetic identities and metadata only. No file bytes, credentials or mail. All writes roll back.
begin;
create temporary table lifeos_career_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;app uuid:=gen_random_uuid();cert uuid:=gen_random_uuid();file uuid:=gen_random_uuid();d jsonb;today date;denied boolean;
begin
  insert into auth.users(id,raw_user_meta_data) values(a,'{"display_name":"Disposable career check"}'),(b,'{"display_name":"Disposable career member"}');
  perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
  w:=public.create_workspace('Disposable career check','professional');perform public.set_workspace_member(w,b,'editor');today:=(now() at time zone 'UTC')::date;
  insert into public.attachments(id,workspace_id,owner_id,name,object_path,mime_type,size_bytes)values(file,w,a,'Synthetic CV.pdf',a::text||'/'||w::text||'/'||file::text||'.pdf','application/pdf',10);
  reset role;update public.attachments set status='ready' where id=file;set local role authenticated;
  d:=jsonb_build_object('kind','application','title','Synthetic role','organization','Example company','location','Remote','skills','Angular','url','https://example.com','notes','Synthetic only','status','applied','applied_on','2025-01-01','interview_on',today,'follow_up_on',today);
  perform public.save_career_record(app,w,null,d,array[file,file]);perform public.save_career_record(app,w,null,d||'{"title":"Ignored retry"}',array[]::uuid[]);
  if not exists(select 1 from public.career_records where id=app and revision=1 and title='Synthetic role') or (select count(*) from public.career_documents where record_id=app)<>1 then raise exception 'Creation replay or links failed';end if;
  denied:=false;begin perform public.save_career_record(app,w,1,d,array[gen_random_uuid()]);exception when others then denied:=true;end;
  if not denied or not exists(select 1 from public.career_records where id=app and revision=1) then raise exception 'Atomic document validation failed';end if;
  perform public.save_career_record(cert,w,null,jsonb_build_object('kind','certification','title','Synthetic certificate','organization','Example issuer','location','','skills','','url','','notes','','status','active','expires_on',today),array[]::uuid[]);
  perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,true,1,30);
  reset role;perform public.deliver_due_reminders();perform public.deliver_due_reminders();
  if (select count(*) from public.notifications where source_id in(app,cert) and dismissed_at is null)<>3 then raise exception 'Career reminders missing or duplicated';end if;
  set local role authenticated;perform public.act_on_career_record(app,1,'follow_up');perform public.act_on_career_record(app,1,'follow_up');
  if not exists(select 1 from public.career_records where id=app and follow_up_on is null and revision=2) or exists(select 1 from public.notifications where source_id=app and source_kind='career_follow_up' and dismissed_at is null) then raise exception 'Follow-up completion or cleanup failed';end if;
  denied:=false;begin perform public.act_on_career_record(app,1,'interview');exception when others then denied:=true;end;
  if not denied then raise exception 'Stale completion accepted';end if;
  perform public.save_career_record(app,w,2,d||'{"status":"accepted"}',array[file]);perform public.act_on_career_record(cert,1,'archive');
  if exists(select 1 from public.notifications where source_id in(app,cert) and dismissed_at is null) then raise exception 'Closed or archived reminder cleanup failed';end if;
  perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7);
  if not exists(select 1 from public.app_settings where id=a and career_reminders) then raise exception 'Legacy preferences lost Career opt-in';end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.career_records where workspace_id=w) or exists(select 1 from public.career_documents where workspace_id=w) then raise exception 'Other editor privacy failed';end if;
  denied:=false;begin perform public.act_on_career_record(app,3,'archive');exception when others then denied:=true;end;
  if not denied then raise exception 'Other editor mutation accepted';end if;
  reset role;insert into lifeos_career_smoke values('Career privacy, document atomicity, creation retries, stale completion, distinct reminders, closed/archive cleanup and legacy preferences passed; synthetic records rolled back.');
end $$;
select * from lifeos_career_smoke;
rollback;
