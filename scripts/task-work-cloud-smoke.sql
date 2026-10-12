-- Synthetic identities only. All writes roll back. No email or file operations.
begin;
create temporary table lifeos_task_work_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;task uuid:=gen_random_uuid();manual uuid:=gen_random_uuid();timer uuid:=gen_random_uuid();day date;denied boolean;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable task owner"}'),(b,'{"display_name":"Disposable time editor"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable work time','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.tasks(id,workspace_id,title,visibility)values(task,w,'Synthetic shared responsibility','workspace');perform public.assign_workspace_task(task,1,b);
 if not exists(select 1 from public.tasks where id=task and assignee_id=b and visibility='workspace') or (select count(*) from public.workspace_task_members(w))<>2 then raise exception 'Assignment or directory failed';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);reset role;day:=private.finance_today(b);set local role authenticated;
 denied:=false;begin perform public.set_task_status(task,2,'done');exception when others then denied:=true;end;if not denied then raise exception 'Assignment changed edit rights';end if;
 perform public.save_manual_task_time(manual,w,null,task,day,1800,'Synthetic work');perform public.save_manual_task_time(manual,w,null,task,day,3600,'Ignored retry');
 if not exists(select 1 from public.task_time_entries where id=manual and seconds=1800 and revision=1) then raise exception 'Manual replay changed history';end if;
 perform public.start_task_timer(timer,w,task,'Synthetic timer');perform public.start_task_timer(timer,w,task,'Ignored retry');
 denied:=false;begin perform public.start_task_timer(gen_random_uuid(),w,task,'Duplicate');exception when others then denied:=true;end;if not denied then raise exception 'Two timers accepted';end if;
 reset role;update public.task_time_entries set started_at=clock_timestamp()-interval '90 seconds' where id=timer;set local role authenticated;
 perform public.act_on_task_time(timer,1,'stop');perform public.act_on_task_time(timer,1,'stop');
 if not exists(select 1 from public.task_time_entries where id=timer and seconds between 90 and 95 and revision=2 and status='recorded') then raise exception 'Timer duration or stop replay failed';end if;
 perform public.act_on_task_time(manual,1,'void');denied:=false;begin perform public.act_on_task_time(manual,1,'restore');exception when others then denied:=true;end;if not denied then raise exception 'Stale restore accepted';end if;perform public.act_on_task_time(manual,2,'restore');
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.task_time_entries where id in(manual,timer)) then raise exception 'Workspace owner read member time';end if;
 perform public.remove_workspace_member(w,b);if not exists(select 1 from public.tasks where id=task and assignee_id is null) then raise exception 'Removed member assignment retained';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.task_time_entries where id=manual) or exists(select 1 from public.workspace_task_members(w)) then raise exception 'Removed member retained workspace access';end if;
 reset role;insert into lifeos_task_work_smoke values('Assignment permissions, private time, manual replay, one running timer, accurate/retry-safe stopping, restore revisions and membership cleanup passed; synthetic rows rolled back.');
end $$;
select * from lifeos_task_work_smoke;
rollback;
