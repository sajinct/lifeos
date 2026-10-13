-- Synthetic identities/records only. No mail, credentials or Storage objects. Every write rolls back.
begin;
create temporary table lifeos_health_tracking_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;log uuid:=gen_random_uuid();med uuid:=gen_random_uuid();link uuid:=gen_random_uuid();account uuid;expense uuid;day date:=current_date;denied boolean;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable wellness owner"}'),(b,'{"display_name":"Disposable wellness editor"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable wellness','family');perform public.set_workspace_member(w,b,'editor');
 perform public.save_health_log(log,w,null,jsonb_build_object('kind','measurement','title','Synthetic metric','logged_on',day,'minutes',null,'value',70.123,'unit','units','notes','Synthetic only'));
 perform public.save_health_log(log,w,null,'{}');
 if not exists(select 1 from public.health_logs where id=log and revision=1 and value=70.123) then raise exception 'Measurement precision or replay failed';end if;
 perform public.save_medication_plan(med,w,null,jsonb_build_object('title','Synthetic medication reminder','instructions','User entered text','starts_on',day,'ends_on',null,'weekdays',array[0,1,2,3,4,5,6],'reminder_time','00:00','timezone','UTC'));
 perform public.save_reminder_preferences(false,false,false,1,3,30,23,'Pacific/Honolulu',false,7,false,3,false,1,false,7,false,30,7,false,1,30,false,1,true);
 reset role;perform public.deliver_due_reminders();perform public.deliver_due_reminders();set local role authenticated;
 if (select count(*)from public.notifications where source_id=med and dismissed_at is null)<>1 then raise exception 'Medication schedule timing or dedup failed';end if;
 perform public.act_on_health_tracking(med,'medication',1,'pause');perform public.act_on_health_tracking(med,'medication',1,'pause');
 if exists(select 1 from public.notifications where source_id=med and dismissed_at is null) then raise exception 'Paused schedule retained reminder';end if;
 denied:=false;begin perform public.act_on_health_tracking(med,'medication',1,'resume');exception when others then denied:=true;end;if not denied then raise exception 'Stale schedule resume accepted';end if;
 perform public.act_on_health_tracking(med,'medication',2,'archive');perform public.act_on_health_tracking(med,'medication',3,'restore');
 if not exists(select 1 from public.medication_plans where id=med and not active and not archived and revision=4) then raise exception 'Restoration lost pause state';end if;
 insert into public.accounts(workspace_id,name,currency)values(w,'Synthetic medical expenses','INR')returning id into account;expense:=public.record_transaction(w,account,'Synthetic recorded medical expense',1500,'expense','Health',day);
 perform public.save_health_expense(link,w,null,expense,null,'Synthetic');perform public.save_health_expense(link,w,null,expense,null,'Ignored retry');
 if (select count(*)from public.health_expenses where transaction_id=expense)<>1 or not exists(select 1 from public.transactions where id=expense and amount=1500 and account_id=account and kind='expense') then raise exception 'Medical expense replay changed ledger';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.health_logs where id=log) or exists(select 1 from public.medication_plans where id=med) or exists(select 1 from public.health_expenses where id=link) then raise exception 'Member read private wellness records';end if;
 denied:=false;begin perform public.act_on_health_tracking(log,'log',1,'archive');exception when others then denied:=true;end;if not denied then raise exception 'Member changed owner log';end if;
 perform public.save_health_log(gen_random_uuid(),w,null,jsonb_build_object('kind','fitness','title','Synthetic walk','logged_on',day,'minutes',30,'value',null,'unit','','notes',''));
 perform set_config('request.jwt.claim.sub',a::text,true);if (select count(*)from public.health_logs where workspace_id=w)<>1 then raise exception 'Workspace owner read member log';end if;
 perform public.remove_workspace_member(w,b);perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.health_logs where workspace_id=w) then raise exception 'Removed member retained wellness data';end if;
 reset role;insert into lifeos_health_tracking_smoke values('Private fitness/measurement/medication/expense records, precision and replay, schedule-specific reminder delivery/dedup, pause cleanup, restore/revisions, unchanged ledger and membership isolation passed; synthetic rows rolled back.');
end $$;
select * from lifeos_health_tracking_smoke;
rollback;
