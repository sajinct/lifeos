-- Synthetic identities and task records only. All changes roll back; no mail or files.
begin;
create temporary table lifeos_task_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;list uuid:=gen_random_uuid();task uuid:=gen_random_uuid();item uuid:=gen_random_uuid();series uuid;next_id uuid;denied boolean;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable task check"}'),(b,'{"display_name":"Disposable task editor"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable task checks','family');perform public.set_workspace_member(w,b,'editor');
 perform public.save_task_list(list,w,null,'Synthetic planning',false);perform public.save_task_list(list,w,null,'Ignored retry',true);
 insert into public.tasks(id,workspace_id,title,due_date)values(task,w,'Synthetic monthly review','2026-01-31');
 perform public.save_task_checklist(item,task,null,'Synthetic step',false);perform public.save_task_checklist(item,task,1,'Synthetic step',true);
 perform public.configure_task(task,1,list,'monthly');select series_id into series from public.tasks where id=task;
 denied:=false;begin perform public.set_task_status(task,null,'done');exception when others then denied:=true;end;if not denied then raise exception 'Null completion revision accepted';end if;
 perform public.set_task_status(task,2,'done');perform public.set_task_status(task,2,'done');
 if (select count(*) from public.tasks where series_id=series)<>2 then raise exception 'Repeat request duplicated successor';end if;
 select id into next_id from public.tasks where series_id=series and occurrence_index=1 and due_date='2026-02-28';
 if next_id is null or not exists(select 1 from public.task_checklist where task_id=next_id and not done and title='Synthetic step') then raise exception 'Anchored reset checklist failed';end if;
 perform public.set_task_status(next_id,1,'done');
 if not exists(select 1 from public.tasks where series_id=series and occurrence_index=2 and due_date='2026-03-31') then raise exception 'Original month-end anchor drifted';end if;
 denied:=false;begin perform public.set_task_status(task,2,'todo');exception when others then denied:=true;end;if not denied then raise exception 'Stale reopen accepted';end if;
 perform public.set_task_series_active(series,1,false);select id into next_id from public.tasks where series_id=series and occurrence_index=2;perform public.set_task_status(next_id,1,'done');
 if (select count(*) from public.tasks where series_id=series)<>3 then raise exception 'Paused repeat generated task';end if;
 perform public.set_task_series_active(series,2,true);perform public.set_task_series_active(series,2,true);
 if (select count(*) from public.tasks where series_id=series)<>4 then raise exception 'Resume successor deduplication failed';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.tasks where id=task) or exists(select 1 from public.task_lists where id=list) or exists(select 1 from public.task_series where id=series) or exists(select 1 from public.task_checklist where task_id=task) then raise exception 'Other editor saw private task data';end if;
 denied:=false;begin perform public.set_task_series_active(series,3,false);exception when others then denied:=true;end;if not denied then raise exception 'Other editor changed repeat';end if;
 reset role;insert into lifeos_task_smoke values('Task privacy, month-end anchors, reset checklists, retry deduplication, stale/null revisions and pause/resume passed; synthetic records rolled back.');
end $$;
select * from lifeos_task_smoke;
rollback;
