-- Synthetic recurrence checks. Every identity and record is rolled back.
begin;
create temporary table lifeos_calendar_repeat_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;s uuid:=gen_random_uuid();request uuid:=gen_random_uuid();e public.calendar_events;sr integer;denied boolean;dates text[];begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable Calendar owner"}'),(b,'{"display_name":"Disposable Calendar member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable Calendar repeat review','family');perform public.set_workspace_member(w,b,'editor');
 perform set_config('request.jwt.claim.sub',b::text,true);
 perform public.create_calendar_series(s,w,'Synthetic monthly review','2090-01-31','09:00',3600,'Asia/Kolkata','monthly',4,'Synthetic room','blue',null,'private');
 perform public.create_calendar_series(s,w,'Synthetic monthly review','2090-01-31','09:00',3600,'Asia/Kolkata','monthly',4,'Synthetic room','blue',null,'private');
 select array_agg(to_char(starts_at at time zone 'Asia/Kolkata','YYYY-MM-DD')order by occurrence_index)into dates from public.calendar_events where series_id=s;
 if dates<>array['2090-01-31','2090-02-28','2090-03-31','2090-04-30'] then raise exception 'Anchored dates or retry failed';end if;
 select * into e from public.calendar_events where series_id=s and occurrence_index=2;
 perform public.edit_calendar_event(request,e.id,e.revision,1,'one','Synthetic exception',e.starts_at,e.ends_at,e.location,e.color,null);
 perform public.edit_calendar_event(request,e.id,e.revision,1,'one','Synthetic exception',e.starts_at,e.ends_at,e.location,e.color,null);
 select * into e from public.calendar_events where series_id=s and occurrence_index=1;
 perform public.edit_calendar_event(gen_random_uuid(),e.id,e.revision,2,'future','Synthetic future edit',e.starts_at,e.ends_at,e.location,e.color,null);
 if not exists(select 1 from public.calendar_events where series_id=s and occurrence_index=2 and title='Synthetic exception' and is_exception) or not exists(select 1 from public.calendar_events where series_id=s and occurrence_index=3 and title='Synthetic future edit' and to_char(starts_at at time zone 'Asia/Kolkata','YYYY-MM-DD')='2090-04-30') then raise exception 'Future edit replaced an exception or lost its month anchor';end if;
 select * into e from public.calendar_events where series_id=s and occurrence_index=1;
 select cs.revision into sr from public.calendar_series cs where id=s;
 denied:=false;begin update public.calendar_events set title='Forged direct edit' where id=e.id;exception when others then denied:=true;end;if not denied then raise exception 'Direct recurring edit accepted';end if;
 request:=gen_random_uuid();perform public.set_calendar_state(request,e.id,e.revision,sr,'series','paused');perform public.set_calendar_state(request,e.id,e.revision,sr,'series','paused');
 if exists(select 1 from public.calendar_events where series_id=s and event_state<>'paused') then raise exception 'Pause failed';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.calendar_series where id=s) or exists(select 1 from public.calendar_events where series_id=s) then raise exception 'Owner read a member private repeat';end if;
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.set_calendar_state(request,e.id,e.revision,sr,'series','paused');exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay accepted';end if;
 reset role;insert into lifeos_calendar_repeat_smoke values('Calendar anchors, exact creation/edit/state retries, preserved exceptions, future edits, direct-write rejection, private member isolation and viewer denial passed. All synthetic records rolled back; no emails or invitations sent.');
end $$;
select * from lifeos_calendar_repeat_smoke;
rollback;
