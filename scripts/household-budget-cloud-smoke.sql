-- Synthetic metadata only. Transaction rollback leaves existing data untouched.
begin;
create temporary table lifeos_household_budget_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;budget uuid:=gen_random_uuid();sa uuid:=gen_random_uuid();sb uuid:=gen_random_uuid();aa uuid;ba uuid;atx uuid;btx uuid;request uuid:=gen_random_uuid();denied boolean;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable household budget creator"}'),(b,'{"display_name":"Disposable household contributor"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable household budget review','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.accounts(workspace_id,name,currency)values(w,'Private creator cash','INR')returning id into aa;atx:=public.record_transaction(w,aa,'Private merchant A',80,'expense','Food','2026-01-15');
 perform public.save_household_budget(gen_random_uuid(),budget,w,null,'Groceries','2026-01-01','INR',100,'','private');perform public.save_household_spending(gen_random_uuid(),sa,budget,null,1,atx,'Explicit creator note');
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.household_budgets where id=budget) or exists(select 1 from public.household_spending where id=sa) then raise exception 'Private budget or snapshot leaked';end if;
 insert into public.accounts(workspace_id,name,currency)values(w,'Private contributor cash','INR')returning id into ba;btx:=public.record_transaction(w,ba,'Private merchant B',30,'expense','Food','2026-01-15');
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.save_household_budget(gen_random_uuid(),budget,w,2,'Groceries','2026-01-01','INR',100,'','workspace');
 perform set_config('request.jwt.claim.sub',b::text,true);perform public.save_household_spending(request,sb,budget,null,3,btx,'Explicit contributor note');perform public.save_household_spending(request,sb,budget,null,3,btx,'Explicit contributor note');
 if (select revision from public.household_spending where id=sb)<>1 or (select revision from public.household_budgets where id=budget)<>4 then raise exception 'Contribution replay duplicated history';end if;
 if (select sum(amount) from public.household_spending where budget_id=budget and not withdrawn)<>110 then raise exception 'Published spending total differs';end if;
 if exists(select 1 from public.household_spending_links where id=sa) or exists(select 1 from public.transactions where id=atx) then raise exception 'Shared budget exposed private Finance links';end if;
 denied:=false;begin perform public.save_household_spending(gen_random_uuid(),gen_random_uuid(),budget,null,4,btx,'Duplicate');exception when others then denied:=true;end;if not denied then raise exception 'Duplicate expense inclusion accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.save_household_budget(gen_random_uuid(),budget,w,4,'Groceries','2026-01-01','INR',100,'','private');
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.household_budgets where id=budget) or not exists(select 1 from public.household_spending where id=sb) then raise exception 'Own history or private budget access incorrect';end if;
 perform public.withdraw_household_spending(gen_random_uuid(),sb,1);
 perform set_config('request.jwt.claim.sub',a::text,true);if exists(select 1 from public.household_spending where id=sb) then raise exception 'Withdrawn foreign snapshot remains visible';end if;
 perform public.save_household_budget(gen_random_uuid(),budget,w,6,'Groceries','2026-01-01','INR',100,'','workspace');perform public.set_household_budget_archive(gen_random_uuid(),budget,7,true);
 perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.save_household_spending(gen_random_uuid(),sb,budget,2,8,btx,'Explicit contributor note');exception when others then denied:=true;end;if not denied then raise exception 'Archived budget accepted refreshed spending';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_household_budget_archive(gen_random_uuid(),budget,8,false);
 perform set_config('request.jwt.claim.sub',b::text,true);perform public.save_household_spending(gen_random_uuid(),sb,budget,2,9,btx,'Explicit contributor note');
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_workspace_member(w,b,'viewer');perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.save_household_spending(request,sb,budget,null,3,btx,'Explicit contributor note');exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay accepted';end if;
 denied:=false;begin perform public.withdraw_household_spending(gen_random_uuid(),sb,3);exception when others then denied:=true;end;if not denied then raise exception 'Viewer withdrawal accepted';end if;
 if (select amount from public.transactions where id=btx)<>30 then raise exception 'Household budget changed Finance';end if;
 denied:=false;begin update public.household_spending set amount=1 where id=sb;exception when others then denied:=true;end;if not denied then raise exception 'Direct snapshot update accepted';end if;
 reset role;insert into lifeos_household_budget_smoke values('Private budget isolation, explicit shared spending, owner-private Finance links, editor contribution rights, exact retries, duplicate expense protection, privacy-safe withdrawal, archive/restore and viewer denial passed. All synthetic records rolled back; no payment or message sent.');
end $$;
select * from lifeos_household_budget_smoke;
rollback;
