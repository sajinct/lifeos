-- All synthetic identities, loans and ledger entries are rolled back. No mail or credentials are created.
begin;
create temporary table lifeos_loan_smoke(result text);
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); w uuid; account uuid; today date;
  loan uuid:=gen_random_uuid(); payment uuid:=gen_random_uuid(); tracking uuid:=gen_random_uuid(); denied boolean;
begin
  insert into auth.users(id,raw_user_meta_data) values(a,'{"display_name":"Disposable loan check"}'),(b,'{"display_name":"Disposable loan viewer"}');
  perform set_config('request.jwt.claim.sub',a::text,true); set local role authenticated;
  today:=(now() at time zone 'Asia/Kolkata')::date;
  w:=public.create_workspace('Disposable loan check'); perform public.set_workspace_member(w,b,'viewer');
  insert into public.accounts(workspace_id,name) values(w,'Synthetic loan cash') returning id into account;
  perform public.create_loan(loan,w,'Synthetic loan','Synthetic lender','borrowed','INR',1200,12,12,today,today,'Test only',account);
  perform public.create_loan(loan,w,'Synthetic loan','Synthetic lender','borrowed','INR',1200,12,12,today,today,'Test only',account);
  if (select count(*) from public.transactions where loan_id=loan)<>1 then raise exception 'Initial principal duplicated'; end if;
  if not exists(select 1 from public.loans where id=loan and interest_total=144 and installment_amount=112) then raise exception 'Wrong simple-interest terms'; end if;
  perform public.record_loan_repayment(payment,loan,50,6,today,account,'Test only');
  perform public.record_loan_repayment(payment,loan,50,6,today,account,'Test only');
  if (select count(*) from public.transactions where loan_repayment_id=payment)<>2
    or not exists(select 1 from public.transactions where loan_repayment_id=payment and kind='transfer_out' and amount=50)
    or not exists(select 1 from public.transactions where loan_repayment_id=payment and kind='expense' and amount=6)
    or not exists(select 1 from public.loans where id=loan and principal_paid=50 and interest_paid=6 and next_due_on=today)
    then raise exception 'Partial repayment was not recorded atomically once'; end if;
  denied:=false;
  begin perform public.record_loan_repayment(gen_random_uuid(),loan,2000,0,today,account,''); exception when others then denied:=true; end;
  if not denied then raise exception 'Overpayment accepted'; end if;
  perform public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,true,3);
  reset role; perform public.deliver_due_reminders(); perform public.deliver_due_reminders();
  if (select count(*) from public.notifications where source_kind='loan' and source_id=loan and dismissed_at is null)<>1 then raise exception 'Reminder missing or duplicated'; end if;
  set local role authenticated;
  perform public.record_loan_repayment(gen_random_uuid(),loan,1150,138,today,account,'Final repayment');
  if not exists(select 1 from public.loans where id=loan and status='paid' and next_due_on is null)
    or exists(select 1 from public.notifications where source_kind='loan' and source_id=loan and dismissed_at is null)
    then raise exception 'Final settlement or stale reminder cleanup failed'; end if;
  perform public.create_loan(tracking,w,'Synthetic tracking loan','Synthetic borrower','lent','INR',10,0,1,today,today,'Test only',null);
  perform public.record_loan_repayment(gen_random_uuid(),tracking,10,0,today,null,'Already in ledger');
  if exists(select 1 from public.transactions where loan_id=tracking) then raise exception 'Tracking-only loan wrote ledger entries'; end if;
  perform set_config('request.jwt.claim.sub',b::text,true);
  if exists(select 1 from public.loans where workspace_id=w) or exists(select 1 from public.loan_repayments where workspace_id=w) then raise exception 'Viewer reads private loan data'; end if;
  denied:=false;
  begin perform public.record_loan_repayment(gen_random_uuid(),loan,1,0,today,null,''); exception when others then denied:=true; end;
  if not denied then raise exception 'Another user records repayments'; end if;
  reset role;
  insert into lifeos_loan_smoke values('Passed: simple-interest terms, request retries, principal/interest ledger separation, partial and final repayments, overpayment rejection, private reminders and viewer isolation. All synthetic data rolled back.');
end $$;
select result from lifeos_loan_smoke;
rollback;
