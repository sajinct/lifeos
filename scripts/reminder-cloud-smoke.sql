-- Run through the authenticated Supabase CLI after the migration.
-- Every synthetic identity and record is rolled back; no email or credential is created.
begin;
create temporary table lifeos_reminder_smoke (result text);
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); w uuid; task uuid; bill uuid;
  account uuid; notice uuid; n integer; denied boolean;
begin
  insert into auth.users(id,raw_user_meta_data) values
    (a,'{"display_name":"Disposable reminder SQL check"}'),
    (b,'{"display_name":"Disposable reminder viewer"}');
  perform set_config('request.jwt.claim.sub',a::text,true);
  set local role authenticated;
  w := public.create_workspace('Disposable reminder SQL check');
  perform public.set_workspace_member(w,b,'viewer');
  insert into public.accounts(workspace_id,name) values(w,'Synthetic account') returning id into account;
  insert into public.tasks(workspace_id,title,due_date) values(w,'Synthetic due task',current_date) returning id into task;
  insert into public.bills(workspace_id,title,account_id,amount,due_on) values(w,'Synthetic bill',account,1,current_date) returning id into bill;
  perform public.save_reminder_preferences(true,true,false,1,3,30,0,'UTC');
  denied := false;
  begin perform public.deliver_due_reminders(); exception when insufficient_privilege then denied := true; end;
  if not denied then raise exception 'Scheduler was exposed to browser users'; end if;
  reset role;
  perform public.deliver_due_reminders();
  perform public.deliver_due_reminders();
  select count(*) into n from public.notifications where workspace_id=w;
  if n<>2 then raise exception 'Expected two unique synthetic reminders, got %',n; end if;
  select id into notice from public.notifications where source_id=task;
  set local role authenticated;
  perform public.act_on_notification(notice,'snooze',60);
  if not exists(select 1 from public.notifications where id=notice and snoozed_until>now() and read_at is null) then
    raise exception 'Snooze did not update the original notification';
  end if;
  update public.tasks set status='done' where id=task;
  if exists(select 1 from public.notifications where source_id=task and dismissed_at is null) then
    raise exception 'Completed task retained an active reminder';
  end if;
  perform public.settle_bill(bill);
  if exists(select 1 from public.notifications where source_id=bill and dismissed_at is null) then
    raise exception 'Paid bill retained an active reminder';
  end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  select count(*) into n from public.notifications where workspace_id=w;
  if n<>0 then raise exception 'Viewer can read another owner''s reminders'; end if;
  denied := false;
  begin perform public.act_on_notification(notice,'read'); exception when others then denied := true; end;
  if not denied then raise exception 'Viewer can mutate another owner''s reminder'; end if;
  reset role;
  insert into lifeos_reminder_smoke values('Passed: scheduler grants, duplicate protection, snooze, task completion, bill payment, viewer isolation. Synthetic data rolled back.');
end; $$;
select result from lifeos_reminder_smoke;
rollback;
