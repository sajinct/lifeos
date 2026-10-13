-- Synthetic identities and attachment metadata only. Every write rolls back.
-- No email, credentials or Storage objects are created.
begin;
create temporary table lifeos_health_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;p uuid:=gen_random_uuid();f uuid:=gen_random_uuid();foreign_file uuid:=gen_random_uuid();d date:=current_date;denied boolean;details jsonb;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable appointment owner"}'),(b,'{"display_name":"Disposable health member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable health planning','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values(f,w,'Synthetic visit note.pdf',a::text||'/'||w::text||'/'||f::text||'.pdf','application/pdf',10);
 reset role;update public.attachments set status='ready' where id=f;set local role authenticated;
 details:=jsonb_build_object('title','Synthetic appointment','provider','Example clinic','location','Room 2','appointment_on',d,'appointment_time','10:30','notes','Synthetic only','status','scheduled');
 perform public.save_health_appointment(p,w,null,details,array[f]);perform public.save_health_appointment(p,w,null,details||'{"title":"Ignored replay"}',array[]::uuid[]);
 if not exists(select 1 from public.health_appointments where id=p and revision=1 and title='Synthetic appointment') or not exists(select 1 from public.health_documents where appointment_id=p and attachment_id=f) then raise exception 'Appointment replay changed record or file link';end if;
 perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,false,1,30,true,1);
 reset role;perform public.deliver_due_reminders();perform public.deliver_due_reminders();set local role authenticated;
 if (select count(*) from public.notifications where source_id=p and dismissed_at is null)<>1 then raise exception 'Health reminder delivery or dedup failed';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.health_appointments where id=p) or exists(select 1 from public.health_documents where appointment_id=p) or exists(select 1 from public.notifications where source_id=p) then raise exception 'Workspace member read private health data';end if;
 denied:=false;begin perform public.act_on_health_appointment(p,1,'cancel');exception when others then denied:=true;end;if not denied then raise exception 'Member changed private appointment';end if;
 insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values(foreign_file,w,'Other synthetic file.pdf',b::text||'/'||w::text||'/'||foreign_file::text||'.pdf','application/pdf',10);
 reset role;update public.attachments set status='ready' where id=foreign_file;set local role authenticated;perform set_config('request.jwt.claim.sub',a::text,true);
 denied:=false;begin perform public.save_health_appointment(p,w,1,details,array[foreign_file]);exception when others then denied:=true;end;if not denied then raise exception 'Foreign document linked';end if;
 if not exists(select 1 from public.health_appointments where id=p and revision=1) then raise exception 'Failed link changed metadata';end if;
 perform public.act_on_health_appointment(p,1,'complete');perform public.act_on_health_appointment(p,1,'complete');
 if exists(select 1 from public.notifications where source_id=p and dismissed_at is null) then raise exception 'Completion retained reminder';end if;
 denied:=false;begin perform public.act_on_health_appointment(p,1,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Stale health action accepted';end if;
 perform public.act_on_health_appointment(p,2,'archive');perform public.act_on_health_appointment(p,3,'restore');
 if not exists(select 1 from public.health_appointments where id=p and status='completed' and not archived and revision=4) or not exists(select 1 from public.health_documents where appointment_id=p) then raise exception 'Health restore lost visit state or file link';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);perform public.save_health_appointment(gen_random_uuid(),w,null,details,array[]::uuid[]);perform set_config('request.jwt.claim.sub',a::text,true);
 if (select count(*) from public.health_appointments where workspace_id=w)<>1 then raise exception 'Workspace owner read member appointment';end if;
 perform public.remove_workspace_member(w,b);perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.health_appointments where workspace_id=w) then raise exception 'Removed member retained health access';end if;
 reset role;insert into lifeos_health_smoke values('Owner-only health/files/notifications, document ownership and atomic links, replay/revisions, reminder deduplication and cleanup, archive/restore status and membership revocation passed; synthetic rows rolled back.');
end $$;
select * from lifeos_health_smoke;
rollback;
