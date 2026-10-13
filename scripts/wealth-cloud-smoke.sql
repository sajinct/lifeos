begin;
create temporary table lifeos_wealth_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;bank uuid;card uuid:=gen_random_uuid();h uuid:=gen_random_uuid();fund uuid:=gen_random_uuid();mark uuid:=gen_random_uuid();withdrawal uuid:=gen_random_uuid();review uuid:=gen_random_uuid();exclusion uuid:=gen_random_uuid();rev integer;denied boolean;net numeric;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable wealth owner"}'),(b,'{"display_name":"Disposable wealth member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable wealth review','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.accounts(workspace_id,name,currency,opening_balance)values(w,'Synthetic bank','INR',2000)returning id into bank;
 perform public.save_credit_card(card,w,null,'{"title":"Synthetic card","last_four":"","currency":"INR","opening_debt":100,"credit_limit":0,"closing_day":25,"due_day":15,"notes":"Synthetic","reminders_enabled":false}');
 perform public.save_investment_holding(h,w,null,'{"title":"Synthetic fund","kind":"fund","currency":"INR","opened_on":"2024-01-01","opening_cost":0,"opening_value":0,"notes":"Synthetic"}');
 perform public.append_investment_entry(fund,w,h,1,'contribution',500,0,'2024-02-01',bank,'Synthetic');perform public.append_investment_entry(fund,w,h,1,'contribution',500,0,'2024-02-01',bank,'Synthetic');
 if (select count(*)from public.transactions where transfer_id=fund)<>1 then raise exception 'Contribution replay posted twice';end if;
 perform public.capture_wealth_snapshot(review,w,'Synthetic baseline');select (totals->0->>'net')::numeric into net from public.wealth_snapshots where id=review;if net<>1900 then raise exception 'Funding changed net worth or card debt counted twice';end if;
 perform public.append_investment_entry(mark,w,h,2,'valuation',600,0,'2024-02-01',null,'Manual value');perform public.append_investment_entry(withdrawal,w,h,3,'withdrawal',100,80,'2024-02-01',bank,'Synthetic disposal');
 if not exists(select 1 from public.investment_holdings where id=h and current_cost=420 and current_value=500 and revision=4) then raise exception 'Withdrawal cost/value bookkeeping failed';end if;
 if exists(select 1 from public.transactions where workspace_id=w and kind in('income','expense')) then raise exception 'Investment cash movement posted an expense or income';end if;
 perform public.set_wealth_exclusion(exclusion,w,null,'holding',h,true);perform public.capture_wealth_snapshot(gen_random_uuid(),w,'Excluded holding');
 if not exists(select 1 from public.wealth_snapshots where workspace_id=w and label='Excluded holding' and (totals->0->>'net')::numeric=1500) then raise exception 'Exclusion or aggregate failed';end if;
 perform public.set_wealth_exclusion(exclusion,w,1,'holding',h,false);perform public.capture_wealth_snapshot(review,w,'Ignored retry');if not exists(select 1 from public.wealth_snapshots where id=review and label='Synthetic baseline' and (totals->0->>'net')::numeric=1900) then raise exception 'Frozen snapshot changed';end if;
 denied:=false;begin perform public.undo_investment_entry(mark,4);exception when others then denied:=true;end;if not denied then raise exception 'Older correction accepted';end if;
 perform public.undo_investment_entry(withdrawal,4);perform public.undo_investment_entry(withdrawal,4);select revision into rev from public.investment_holdings where id=h;perform public.undo_investment_entry(mark,rev);select revision into rev from public.investment_holdings where id=h;perform public.undo_investment_entry(fund,rev);
 if not exists(select 1 from public.investment_holdings where id=h and current_cost=0 and current_value=0) then raise exception 'Undo failed to restore opening state';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.investment_holdings where id=h) or exists(select 1 from public.investment_entries where holding_id=h) or exists(select 1 from public.wealth_snapshots where id=review) or exists(select 1 from public.wealth_exclusions where id=exclusion) then raise exception 'Member read private wealth';end if;
 denied:=false;begin perform public.capture_wealth_snapshot(review,w,'Attack');exception when others then denied:=true;end;if not denied then raise exception 'Member reused owner snapshot id';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.remove_workspace_member(w,b);reset role;
 insert into lifeos_wealth_smoke values('Private holdings and snapshots, contribution/withdrawal transfers without expense duplication, cost-basis tracking, card debt once, inclusion controls, frozen snapshots, chronological corrections and stable retries passed. All synthetic rows rolled back.');
end $$;
select * from lifeos_wealth_smoke;
rollback;
