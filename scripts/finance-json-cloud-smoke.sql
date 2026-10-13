-- Disposable JSON import checks. All writes roll back; no real financial records are read.
begin;
create temporary table lifeos_json_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;bank uuid;batch uuid:=gen_random_uuid();answer jsonb;denied boolean;payload jsonb;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable JSON owner"}'),(b,'{"display_name":"Disposable JSON member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable JSON import review','family');perform public.set_workspace_member(w,b,'editor');
 payload:='{"accounts":[{"source_id":"synthetic-bank","name":"Synthetic JSON bank","currency":"INR","opening_balance":"100.00","card_source":false,"target_id":null}],"transactions":[{"source_id":"synthetic-tx","account_source":"synthetic-bank","row":{"date":"2024-02-01","title":"Synthetic expense","kind":"expense","amount":"12.50","currency":"INR","category":"Other","reference":"synthetic-json-001"}}]}';
 answer:=public.import_finance_json(batch,w,payload);
 if answer<>jsonb_build_object('accounts_created',1,'accounts_reused',0,'imported',1,'skipped',0) then raise exception 'JSON creation failed';end if;
 if public.import_finance_json(batch,w,payload)<>answer then raise exception 'JSON retry changed result';end if;
 select account_id into bank from public.finance_json_links where workspace_id=w and source_kind='account' and source_id='synthetic-bank';
 if (select count(*)from public.accounts where workspace_id=w)<>1 or (select count(*)from public.transactions where account_id=bank)<>1 then raise exception 'JSON retry duplicated data';end if;
 payload:=jsonb_set(payload,'{accounts,0,target_id}',to_jsonb(bank::text));
 answer:=public.import_finance_json(gen_random_uuid(),w,payload);
 if answer<>jsonb_build_object('accounts_created',0,'accounts_reused',1,'imported',0,'skipped',1) then raise exception 'JSON reupload did not reuse bindings';end if;
 denied:=false;begin perform public.import_finance_json(gen_random_uuid(),w,jsonb_set(payload,'{transactions,0,row,title}','"Changed source contents"'));exception when others then denied:=true;end;
 if not denied or (select count(*)from public.transactions where account_id=bank)<>1 then raise exception 'Changed source identity modified ledger';end if;
 denied:=false;begin perform public.import_finance_json(gen_random_uuid(),w,
 '{"accounts":[{"source_id":"rollback-account","name":"Rollback bank","currency":"INR","opening_balance":"0.00","card_source":false,"target_id":null}],"transactions":[{"source_id":"bad-precision","account_source":"rollback-account","row":{"date":"2024-02-01","title":"Invalid precision","kind":"expense","amount":"1.001","currency":"INR","category":"Other","reference":""}}]}');exception when others then denied:=true;end;
 if not denied or (select count(*)from public.accounts where workspace_id=w)<>1 then raise exception 'Invalid JSON batch left partial accounts';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.finance_json_links where workspace_id=w) or exists(select 1 from public.finance_json_batches where workspace_id=w) then raise exception 'Member read private source bindings';end if;
 denied:=false;begin perform public.import_finance_json(gen_random_uuid(),w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Member imported into owner account';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);
 denied:=false;begin perform public.import_finance_json(batch,w,payload);exception when others then denied:=true;end;if not denied then raise exception 'Viewer retried private JSON batch';end if;
 reset role;insert into lifeos_json_smoke values('Private account/source mappings, atomic account and ledger creation, stable retries, reupload reuse, changed-ID conflicts, invalid precision rollback and member/viewer isolation passed. All synthetic records rolled back.');
end $$;
select * from lifeos_json_smoke;
rollback;
