-- Synthetic identities and rows only; all writes roll back. No messages, credentials or files.
begin;
create temporary table lifeos_habit_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;goal uuid:=gen_random_uuid();habit uuid:=gen_random_uuid();milestone uuid:=gen_random_uuid();today date;yesterday date;denied boolean;
begin
  insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable habit check"}'),(b,'{"display_name":"Disposable habit editor"}');
  perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
  w:=public.create_workspace('Disposable habits','family');perform public.set_workspace_member(w,b,'editor');
  reset role;today:=private.finance_today(a);yesterday:=today-1;set local role authenticated;
  perform public.save_personal_goal(goal,w,null,'Synthetic reading goal',12,0,'books',today,'monthly','green','Synthetic only','private');
  perform public.save_personal_goal(goal,w,null,'Ignored retry',99,1,'books',today,'annual','green','','private');
  if not exists(select 1 from public.goals where id=goal and target=12 and revision=1) then raise exception 'Goal replay changed data';end if;
  perform public.save_goal_milestone(milestone,w,null,goal,'Finish first book',today,'Synthetic only');perform public.set_goal_milestone_done(milestone,1,true);perform public.set_goal_milestone_done(milestone,1,true);
  if not exists(select 1 from public.goal_milestones where id=milestone and done and revision=2 and completed_on=today) or not exists(select 1 from public.goals where id=goal and current=0) then raise exception 'Milestone replay or progress independence failed';end if;
  denied:=false;begin perform public.set_goal_milestone_done(milestone,1,false);exception when others then denied:=true;end;if not denied then raise exception 'Stale milestone mutation accepted';end if;
  perform public.save_habit(habit,w,null,'Synthetic reading habit','Evening','Synthetic only',yesterday,array[1,2,3,4,5,6,7]);perform public.save_habit(habit,w,null,'Ignored retry','','',today,array[1]);
  perform public.set_habit_checkin(habit,yesterday,0,true);perform public.set_habit_checkin(habit,today,0,true);perform public.set_habit_checkin(habit,today,0,true);
  if (select count(*) from public.habit_checkins where habit_id=habit)<>2 then raise exception 'Duplicate daily check-in';end if;
  perform public.set_habit_checkin(habit,today,1,false);perform public.set_habit_checkin(habit,today,2,true);
  denied:=false;begin perform public.set_habit_checkin(habit,today,1,false);exception when others then denied:=true;end;if not denied then raise exception 'Stale undo accepted';end if;
  perform public.set_habit_status(habit,1,'paused');
  denied:=false;begin perform public.set_habit_checkin(habit,today,3,false);exception when others then denied:=true;end;if not denied then raise exception 'Paused-day check-in accepted';end if;
  if not exists(select 1 from public.habit_periods where habit_id=habit and starts_on=today and status='paused') or not exists(select 1 from public.habit_periods where habit_id=habit and starts_on=yesterday and status='active') then raise exception 'Pause history failed';end if;
  perform public.set_habit_status(habit,2,'active');perform public.set_goal_archive(goal,1,true);
  denied:=false;begin perform public.save_goal_milestone(gen_random_uuid(),w,null,goal,'Blocked',null,'');exception when others then denied:=true;end;if not denied then raise exception 'Archived goal accepted milestone';end if;
  perform public.set_goal_archive(goal,2,false);
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.goals where id=goal) or exists(select 1 from public.habits where id=habit) or exists(select 1 from public.habit_periods where habit_id=habit) or exists(select 1 from public.habit_checkins where habit_id=habit) or exists(select 1 from public.goal_milestones where goal_id=goal) then raise exception 'Editor private data exposure';end if;
  denied:=false;begin perform public.set_habit_checkin(habit,today,3,false);exception when others then denied:=true;end;if not denied then raise exception 'Other editor check-in accepted';end if;
  reset role;insert into lifeos_habit_smoke values('Goal/habit privacy, request replay, milestone progress independence, stale actions, pause history and archives passed; synthetic records rolled back.');
end $$;
select * from lifeos_habit_smoke;
rollback;
