-- Synthetic Calendar import review; all identities and records roll back.
begin;
create temporary table lifeos_calendar_import_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;p uuid;batch uuid:=gen_random_uuid();payload jsonb;answer jsonb;denied boolean;e uuid;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable calendar owner"}'),(b,'{"display_name":"Disposable calendar member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable calendar import review','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.projects(workspace_id,title,visibility)values(w,'Synthetic calendar project','workspace')returning id into p;
 perform set_config('request.jwt.claim.sub',b::text,true);
 payload:=jsonb_build_object('projects',jsonb_build_array(jsonb_build_object('source_id','synthetic-project','target_id',p)),'rows',
 '[{"kind":"event","source_id":"synthetic-event","project_source":"synthetic-project","title":"Synthetic calendar meeting","status":null,"priority":null,"due_date":null,"body":null,"starts_at":"2027-01-01T03:30:00.000Z","ends_at":"2027-01-01T04:30:00.000Z","location":"Synthetic room","color":"blue"}]'::jsonb);
 answer:=public.import_record_json(batch,w,payload);
 if (answer->>'events_imported')::integer<>1 or public.import_record_json(batch,w,payload)<>answer then raise exception 'Event import/retry failed';end if;
 select event_id into e from public.record_json_links where workspace_id=w and record_kind='event' and source_id='synthetic-event';
 if not exists(select 1 from public.calendar_events where id=e and owner_id=b and visibility='private' and project_id=p and starts_at='2027-01-01T03:30:00Z'::timestamptz) then raise exception 'Calendar event identity/time/privacy failed';end if;
 if (public.import_record_json(gen_random_uuid(),w,payload)->>'skipped')::integer<>1 then raise exception 'Reupload duplicated event';end if;
 denied:=false;begin perform public.import_record_json(gen_random_uuid(),w,jsonb_set(payload,'{rows,0,location}','"Changed source"'));exception when others then denied:=true;end;if not denied then raise exception 'Changed source accepted';end if;
 denied:=false;begin perform public.import_record_json(gen_random_uuid(),w,jsonb_set(payload,'{rows}',jsonb_build_array((payload->'rows'->0)||'{"source_id":"rollback-candidate","title":"Rollback candidate"}'::jsonb,(payload->'rows'->0)||'{"source_id":"invalid-date","starts_at":"2027-02-30T03:30:00.000Z"}'::jsonb)));exception when others then denied:=true;end;
 if not denied or exists(select 1 from public.calendar_events where workspace_id=w and title='Rollback candidate') then raise exception 'Invalid batch partially persisted';end if;
 update public.calendar_events set title='Intentional local edit' where id=e;
 if (public.import_record_json(gen_random_uuid(),w,payload)->>'skipped')::integer<>1 or not exists(select 1 from public.calendar_events where id=e and title='Intentional local edit') then raise exception 'Reupload overwrote edit';end if;
 delete from public.calendar_events where id=e;
 if (public.import_record_json(gen_random_uuid(),w,payload)->>'skipped')::integer<>1 or exists(select 1 from public.calendar_events where id=e) or exists(select 1 from public.record_json_links where workspace_id=w and record_kind='event' and event_id is not null) then raise exception 'Reupload resurrected event';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.record_json_links where workspace_id=w) or exists(select 1 from public.record_json_batches where workspace_id=w) then raise exception 'Workspace owner read private import data';end if;
 perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.import_record_json(batch,w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay accepted';end if;
 reset role;insert into lifeos_calendar_import_smoke values('Private Calendar ownership, explicit shared-project links without sharing inheritance, UTC instants, stable retries, duplicate/conflict checks, invalid-date rollback, preserved edits/deletions and viewer isolation passed. All synthetic records rolled back.');
end $$;
select * from lifeos_calendar_import_smoke;
rollback;
