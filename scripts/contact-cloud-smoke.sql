-- All synthetic contacts, identities and linked records are rolled back. No messages or credentials are created.
begin;
create temporary table lifeos_contact_smoke(result text);
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); w uuid; project uuid; loan uuid:=gen_random_uuid();
  contact uuid:=gen_random_uuid(); today date; denied boolean;
begin
  insert into auth.users(id,raw_user_meta_data) values(a,'{"display_name":"Disposable contact check"}'),(b,'{"display_name":"Disposable contact viewer"}');
  perform set_config('request.jwt.claim.sub',a::text,true); set local role authenticated;
  today:=(now() at time zone 'Asia/Kolkata')::date;
  w:=public.create_workspace('Disposable contact check'); perform public.set_workspace_member(w,b,'viewer');
  insert into public.projects(workspace_id,title) values(w,'Synthetic project') returning id into project;
  perform public.create_loan(loan,w,'Synthetic loan','Synthetic lender','borrowed','INR',10,0,1,today,today,'',null);
  perform public.save_contact(contact,w,null,'Synthetic contact','person','Example organization','Professional','sample@example.com','+91 555 0100','https://example.com','','Test only',today,'Discuss project',null,array[project],array[loan]);
  perform public.save_contact(contact,w,null,'Retry ignored','person','','Personal','','','','','',null,'',null,array[]::uuid[],array[]::uuid[]);
  if (select count(*) from public.contact_links where contact_id=contact)<>2 or not exists(select 1 from public.contacts where id=contact and revision=1 and name='Synthetic contact') then raise exception 'Creation retry changed contact or links'; end if;
  perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,true,1);
  reset role; perform public.deliver_due_reminders(); perform public.deliver_due_reminders();
  if (select count(*) from public.notifications where source_kind='contact' and source_id=contact and dismissed_at is null)<>1 then raise exception 'Follow-up reminder missing or duplicated'; end if;
  set local role authenticated;
  perform public.complete_contact_follow_up(contact,1); perform public.complete_contact_follow_up(contact,1);
  if not exists(select 1 from public.contacts where id=contact and revision=2 and next_follow_up is null and last_contacted_on=today)
    or exists(select 1 from public.notifications where source_id=contact and dismissed_at is null) then raise exception 'Follow-up completion failed'; end if;
  denied:=false;
  begin perform public.save_contact(contact,w,1,'Stale change','person','','Personal','','','','','',null,'',null,array[]::uuid[],array[]::uuid[]); exception when others then denied:=true; end;
  if not denied then raise exception 'Stale edit accepted'; end if;
  perform public.set_contact_status(contact,2,'archived'); perform public.set_contact_status(contact,3,'active');
  if (select count(*) from public.contact_links where contact_id=contact)<>2 or not exists(select 1 from public.contacts where id=contact and status='active' and revision=4) then raise exception 'Archive/restore did not preserve contact links'; end if;
  perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3);
  if not exists(select 1 from public.app_settings where id=a and contact_reminders) then raise exception 'Legacy settings lost contact preference'; end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.contacts where workspace_id=w) or exists(select 1 from public.contact_links where workspace_id=w) then raise exception 'Viewer reads private contacts or links'; end if;
  denied:=false; begin perform public.set_contact_status(contact,4,'archived'); exception when others then denied:=true; end;
  if not denied then raise exception 'Another user can archive contacts'; end if;
  reset role;
  insert into lifeos_contact_smoke values('Passed: private contacts/links, stable creation retries, revision conflicts, linked records, reversible archive, retry-safe follow-up completion, reminder cleanup, legacy preference compatibility and viewer isolation. Synthetic data rolled back.');
end $$;
select result from lifeos_contact_smoke;
rollback;
