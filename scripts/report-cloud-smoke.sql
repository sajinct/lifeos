-- Synthetic fixtures and all ledger metadata edits are rolled back; no mail or credentials are created.
begin;
create temporary table lifeos_report_smoke(result text);
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); w uuid; account uuid; today date;
  sub uuid:=gen_random_uuid(); second uuid:=gen_random_uuid(); plan uuid; revision timestamptz;
begin
  insert into auth.users(id,raw_user_meta_data) values(a,'{"display_name":"Disposable report check"}'),(b,'{"display_name":"Disposable report viewer"}');
  perform set_config('request.jwt.claim.sub',a::text,true); set local role authenticated;
  today:=(now() at time zone 'Asia/Kolkata')::date;
  w:=public.create_workspace('Disposable report check'); perform public.set_workspace_member(w,b,'viewer');
  insert into public.accounts(workspace_id,name) values(w,'Synthetic cash') returning id into account;
  perform public.save_subscription(sub,w,null,'Synthetic subscription',10,'INR','monthly',today,null,'active','Subscriptions','','Test only','create',account,null,false);
  select recurring_id into plan from public.subscriptions where id=sub;
  perform public.post_recurring_due(plan);
  if not exists(select 1 from public.transactions where recurring_id=plan and subscription_id=sub and amount=10) then raise exception 'Subscription attribution missing'; end if;
  select updated_at into revision from public.subscriptions where id=sub;
  perform public.save_subscription(sub,w,revision,'Synthetic subscription',10,'INR','monthly',today,null,'active','Subscriptions','','Test only','track',null,null,false);
  perform public.save_subscription(second,w,null,'Synthetic replacement label',10,'INR','monthly',today,null,'active','Subscriptions','','Test only','existing',account,plan,false);
  perform public.cancel_subscription(second);
  if (select count(*) from public.transactions where recurring_id=plan and subscription_id=sub and amount=10)<>1 then raise exception 'Reassignment changed historical classification or duplicated expense'; end if;
  if (select sum(amount) from public.transactions where workspace_id=w and kind='expense')<>10 then raise exception 'Classification changed the ledger total'; end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.transactions where workspace_id=w) or exists(select 1 from public.subscriptions where workspace_id=w) then raise exception 'Viewer reads private financial report data'; end if;
  reset role;
  insert into lifeos_report_smoke values('Passed: posted expense attribution, preserved historical classification after disconnection/reassignment/cancellation, unchanged expense totals and viewer isolation. All synthetic data rolled back.');
end $$;
select result from lifeos_report_smoke;
rollback;
