begin;
create temporary table lifeos_card_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;c uuid:=gen_random_uuid();s uuid:=gen_random_uuid();next_statement uuid:=gen_random_uuid();p uuid:=gen_random_uuid();bank uuid;account uuid;denied boolean;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable card owner"}'),(b,'{"display_name":"Disposable member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable card billing','family');perform public.set_workspace_member(w,b,'editor');
 perform public.save_credit_card(c,w,null,'{"title":"Synthetic card","last_four":"1234","currency":"INR","opening_debt":1000,"credit_limit":5000,"closing_day":31,"due_day":15,"notes":"Synthetic only","reminders_enabled":true}');
 select account_id into account from public.credit_cards where id=c;
 insert into public.accounts(workspace_id,name,currency,opening_balance)values(w,'Synthetic bank','INR',2000)returning id into bank;
 perform public.save_card_statement(s,w,null,c,'{"cycle_end":"2024-01-31","due_on":"2024-02-15","amount":1000,"minimum_due":100,"notes":""}');
 perform public.record_card_payment(p,w,s,bank,250,'2024-03-01','Synthetic');perform public.record_card_payment(p,w,s,bank,250,'2024-03-01','Synthetic');
 if (select count(*) from public.transactions where transfer_id=p)<>2 or exists(select 1 from public.transactions where account_id=account and kind='expense') then raise exception 'Payment retry added expense or duplicate transfer';end if;
 perform public.save_card_statement(next_statement,w,null,c,'{"cycle_end":"2024-02-29","due_on":"2024-03-15","amount":1000,"minimum_due":100,"notes":"Full bank balance including carry"}');
 denied:=false;begin perform public.record_card_payment(gen_random_uuid(),w,next_statement,bank,751,'2024-03-02','');exception when others then denied:=true;end;if not denied then raise exception 'Late prior-statement payment not credited';end if;
 perform public.act_on_card_record(next_statement,'statement',1,'cancel');perform public.void_card_payment(p);perform public.void_card_payment(p);
 if (select count(*) from public.transactions where account_id=account)<>2 or not exists(select 1 from public.card_payments where id=p and voided and reversal_id is not null) then raise exception 'Payment reversal was not idempotent';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.credit_cards where id=c) or exists(select 1 from public.card_statements where id=s) or exists(select 1 from public.card_payments where id=p) then raise exception 'Member read private card records';end if;
 denied:=false;begin perform public.void_card_payment(p);exception when others then denied:=true;end;if not denied then raise exception 'Member changed private payment';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.remove_workspace_member(w,b);
 reset role;insert into lifeos_card_smoke values('Private card billing, full-balance statement rollover, late-payment credit, paired transfer posting without expenses, retry-safe reversal and member isolation passed. All synthetic rows rolled back.');
end $$;
select * from lifeos_card_smoke;
rollback;
