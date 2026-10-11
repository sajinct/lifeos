-- Run with: npx supabase db query --linked --file supabase/tests/cloud-smoke.sql
-- All synthetic identities and records are rolled back; no real passwords/emails are used.
begin;
insert into auth.users(id, raw_user_meta_data) values
  ('e932ca83-e5e5-45ee-8b9e-6a6df37ab101', '{"display_name":"LifeOS smoke owner"}'),
  ('e932ca83-e5e5-45ee-8b9e-6a6df37ab102', '{"display_name":"LifeOS smoke viewer"}');
select set_config('request.jwt.claim.sub','e932ca83-e5e5-45ee-8b9e-6a6df37ab101',true);
set local role authenticated;
do $smoke$
declare
  w uuid;
  a uuid;
  b uuid;
  transfer_request uuid := gen_random_uuid();
begin
  if (select count(*) from public.profiles) <> 1 then
    raise exception 'Own-profile isolation failed';
  end if;
  w := public.create_workspace('LifeOS rollback smoke test','family');
  insert into public.tasks(workspace_id,title) values(w,'Private smoke task');
  insert into public.tasks(workspace_id,title,visibility) values(w,'Shared smoke task','workspace');
  insert into public.accounts(workspace_id,name,opening_balance) values(w,'Smoke source',100) returning id into a;
  insert into public.accounts(workspace_id,name) values(w,'Smoke destination') returning id into b;
  perform public.transfer_funds(w,a,b,20.15,transfer_request);
  perform public.transfer_funds(w,a,b,20.15,transfer_request);
  if (select count(*) from public.transactions where transfer_id=transfer_request) <> 2 then
    raise exception 'Transfer idempotency failed';
  end if;
  if (select sum(case kind when 'transfer_in' then amount else -amount end)
      from public.transactions where transfer_id=transfer_request) <> 0 then
    raise exception 'Transfer balance conservation failed';
  end if;
  perform public.set_workspace_member(w,'e932ca83-e5e5-45ee-8b9e-6a6df37ab102','viewer');
  perform set_config('request.jwt.claim.sub','e932ca83-e5e5-45ee-8b9e-6a6df37ab102',true);
  if (select count(*) from public.tasks where workspace_id=w) <> 1 then
    raise exception 'Viewer private/shared isolation failed';
  end if;
  if exists(select 1 from public.accounts where workspace_id=w) then
    raise exception 'Private finance account leaked';
  end if;
  begin
    insert into public.tasks(workspace_id,title) values(w,'Forbidden viewer write');
    raise exception 'Viewer write unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;
end;
$smoke$;
rollback;
select 'Live profile, workspace, RLS and transfer checks passed; test data rolled back' as verification,
  (select count(*) from auth.users where id in ('e932ca83-e5e5-45ee-8b9e-6a6df37ab101','e932ca83-e5e5-45ee-8b9e-6a6df37ab102')) as persisted_test_users;
