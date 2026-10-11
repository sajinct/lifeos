-- Rollback-only cloud verification of private planning and ledger posting.
begin;
insert into auth.users(id,raw_user_meta_data) values
  ('e932ca83-e5e5-45ee-8b9e-6a6df37ab201','{"display_name":"Finance smoke owner"}'),
  ('e932ca83-e5e5-45ee-8b9e-6a6df37ab202','{"display_name":"Finance smoke viewer"}');
select set_config('request.jwt.claim.sub','e932ca83-e5e5-45ee-8b9e-6a6df37ab201',true);
set local role authenticated;
do $smoke$
declare w uuid; account uuid; bill uuid; plan uuid; first_tx uuid; posted integer;
begin
  w := public.create_workspace('Finance rollback smoke','personal');
  insert into public.accounts(workspace_id,name) values(w,'Smoke account') returning id into account;
  insert into public.budgets(workspace_id,category,month,currency,amount)
    values(w,'Utilities',date_trunc('month',current_date)::date,'INR',100);
  insert into public.bills(workspace_id,account_id,title,amount,due_on,category)
    values(w,account,'Smoke bill',12.15,current_date,'Utilities') returning id into bill;
  first_tx := public.settle_bill(bill);
  if public.settle_bill(bill) <> first_tx or (select count(*) from public.transactions t where t.bill_id = bill) <> 1 then
    raise exception 'Bill idempotency failed';
  end if;
  insert into public.recurring_transactions(workspace_id,account_id,title,amount,kind,frequency,start_on,next_on)
    values(w,account,'Smoke schedule',3.45,'income','monthly',current_date,current_date) returning id into plan;
  posted := public.post_recurring_due(plan);
  if posted <> 1 or public.post_recurring_due(plan) <> 0 then raise exception 'Recurring idempotency failed'; end if;
  if (select count(*) from public.transactions where workspace_id = w) <> 2 then raise exception 'Ledger count failed'; end if;
  perform public.set_workspace_member(w,'e932ca83-e5e5-45ee-8b9e-6a6df37ab202','viewer');
  perform set_config('request.jwt.claim.sub','e932ca83-e5e5-45ee-8b9e-6a6df37ab202',true);
  if exists(select 1 from public.budgets where workspace_id=w)
    or exists(select 1 from public.bills where workspace_id=w)
    or exists(select 1 from public.recurring_transactions where workspace_id=w)
    or exists(select 1 from public.transactions where workspace_id=w) then raise exception 'Private finance leaked'; end if;
  begin
    perform public.settle_bill(bill);
    raise exception 'Foreign bill posting unexpectedly allowed';
  exception when raise_exception then
    if sqlerrm not like 'Bill owner%' then raise; end if;
  end;
end;
$smoke$;
rollback;
select 'Live bill posting, recurring posting, and finance isolation passed; all test records rolled back' as verification,
  (select count(*) from auth.users where id in ('e932ca83-e5e5-45ee-8b9e-6a6df37ab201','e932ca83-e5e5-45ee-8b9e-6a6df37ab202')) as persisted_test_users;
