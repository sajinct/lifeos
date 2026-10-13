-- Synthetic-only rollback smoke. Does not read user financial records or execute payments.
begin;
create temporary table lifeos_import_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;bank uuid;batch uuid:=gen_random_uuid();
 rows jsonb:='[{"date":"2024-02-01","title":"Synthetic purchase","kind":"expense","amount":"12.50","currency":"INR","category":"Other","reference":"synthetic-001"}]';
 answer jsonb;denied boolean;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable import owner"}'),(b,'{"display_name":"Disposable import member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable import review','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.accounts(workspace_id,name,currency,opening_balance)values(w,'Synthetic import bank','INR',100)returning id into bank;
 answer:=public.import_finance_csv(batch,w,bank,rows);
 if answer<>jsonb_build_object('imported',1,'skipped',0) then raise exception 'Import did not post';end if;
 answer:=public.import_finance_csv(batch,w,bank,rows);
 if answer<>jsonb_build_object('imported',1,'skipped',0) or (select count(*)from public.transactions where account_id=bank)<>1 then raise exception 'Replay duplicated import';end if;
 answer:=public.import_finance_csv(gen_random_uuid(),w,bank,rows);
 if answer<>jsonb_build_object('imported',0,'skipped',1) then raise exception 'Reupload did not skip';end if;
 denied:=false;begin perform public.import_finance_csv(gen_random_uuid(),w,bank,
  '[{"date":"2024-02-01","title":"Rollback first","kind":"income","amount":"20.00","currency":"INR","category":"Other","reference":"synthetic-002"},{"date":"2024-02-01","title":"Bad precision","kind":"expense","amount":"1.001","currency":"INR","category":"Other","reference":"synthetic-003"}]');exception when others then denied:=true;end;
 if not denied or (select count(*)from public.transactions where account_id=bank)<>1 then raise exception 'Invalid batch was not atomic';end if;
 denied:=false;begin perform public.import_finance_csv(gen_random_uuid(),w,bank,jsonb_set(rows,'{0,amount}','"13.00"'));exception when others then denied:=true;end;
 if not denied then raise exception 'Changed bank reference accepted';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.finance_import_batches where workspace_id=w) or exists(select 1 from public.transactions where account_id=bank) then raise exception 'Private import read by member';end if;
 denied:=false;begin perform public.import_finance_csv(gen_random_uuid(),w,bank,rows);exception when others then denied:=true;end;
 if not denied then raise exception 'Member imported into another account';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_workspace_member(w,b,'viewer');
 perform set_config('request.jwt.claim.sub',b::text,true);
 denied:=false;begin perform public.import_finance_csv(batch,w,bank,rows);exception when others then denied:=true;end;
 if not denied then raise exception 'Viewer retried private batch';end if;
 reset role;
 insert into lifeos_import_smoke values('Atomic private CSV imports, stable retries, reupload duplicate detection, precision rollback, reference conflicts, owner-only reads and viewer/member write rejection passed. All synthetic rows rolled back.');
end $$;
select * from lifeos_import_smoke;
rollback;
