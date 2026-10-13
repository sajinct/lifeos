-- Synthetic identities and planning records only. Every write rolls back. No invitations, bookings, mail or payments.
begin;
create temporary table lifeos_travel_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;p uuid:=gen_random_uuid();q uuid:=gen_random_uuid();step uuid:=gen_random_uuid();guest uuid:=gen_random_uuid();budget uuid:=gen_random_uuid();link uuid:=gen_random_uuid();account uuid;expense uuid;denied boolean;plan jsonb;item jsonb;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable trip owner"}'),(b,'{"display_name":"Disposable event owner"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;w:=public.create_workspace('Disposable travel planning','family');perform public.set_workspace_member(w,b,'editor');
 plan:='{"kind":"trip","title":"Synthetic trip","location":"Example destination","starts_on":"2026-11-01","ends_on":"2026-11-05","timezone":"Asia/Kolkata","status":"planning","notes":"Synthetic only"}';
 perform public.save_travel_plan(p,w,null,plan);perform public.save_travel_plan(p,w,null,plan||'{"title":"Ignored retry"}');
 item:='{"kind":"checklist","title":"Synthetic packing item","date_on":null,"end_on":null,"time_at":"","end_time":"","location":"","reference":"","cost":null,"currency":"","email":"","phone":"","guest_count":null,"status":"todo","notes":""}';
 perform public.save_travel_entry(step,w,null,p,item);perform public.act_on_travel_record(step,'entry',1,'complete');perform public.act_on_travel_record(step,'entry',1,'complete');
 if not exists(select 1 from public.travel_plans where id=p and title='Synthetic trip' and revision=1 and status='planning') or not exists(select 1 from public.travel_entries where id=step and status='done' and revision=2) then raise exception 'Plan/checklist replay changed metadata';end if;
 denied:=false;begin perform public.act_on_travel_record(step,'entry',1,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Stale checklist action accepted';end if;
 perform public.save_travel_entry(guest,w,null,p,item||'{"kind":"guest","title":"Synthetic guest party","guest_count":2,"email":"synthetic@example.com","status":"accepted"}');
 perform public.save_travel_budget(budget,w,null,p,'INR',10000);perform public.save_travel_budget(budget,w,null,p,'INR',20000);
 insert into public.accounts(workspace_id,name,currency)values(w,'Synthetic travel expenses','INR')returning id into account;expense:=public.record_transaction(w,account,'Synthetic recorded trip expense',1500,'expense','Travel',current_date);
 perform public.save_travel_expense(link,w,null,p,expense,'Synthetic');perform public.save_travel_expense(link,w,null,p,expense,'Ignored retry');
 if not exists(select 1 from public.travel_budgets where id=budget and amount=10000 and revision=1) or not exists(select 1 from public.transactions where id=expense and amount=1500 and account_id=account) then raise exception 'Budget replay or ledger preservation failed';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.travel_plans where id=p) or exists(select 1 from public.travel_entries where id=guest) or exists(select 1 from public.travel_budgets where id=budget) or exists(select 1 from public.travel_expenses where id=link) then raise exception 'Member read private trip data';end if;
 denied:=false;begin perform public.act_on_travel_record(step,'entry',2,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Member changed owner trip';end if;
 perform public.save_travel_plan(q,w,null,plan||'{"kind":"event","title":"Synthetic personal event"}');perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.travel_plans where id=q) then raise exception 'Workspace owner read member event';end if;
 perform public.save_travel_plan(p,w,1,plan||'{"status":"completed"}');denied:=false;begin perform public.act_on_travel_record(step,'entry',2,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Closed plan allowed checklist edits';end if;
 perform public.act_on_travel_record(p,'plan',2,'archive');perform public.act_on_travel_record(p,'plan',3,'restore');
 if not exists(select 1 from public.travel_plans where id=p and status='completed' and not archived and revision=4) then raise exception 'Restoration lost completed plan status';end if;
 perform public.remove_workspace_member(w,b);perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.travel_plans where id=q) then raise exception 'Removed member retained event access';end if;
 reset role;insert into lifeos_travel_smoke values('Private trip/event/guest/budget/expense records, stable replay/revisions, independent checklist completion, unchanged ledger, closed-plan protection, status-preserving archive/restore and membership revocation passed; synthetic rows rolled back.');
end $$;
select * from lifeos_travel_smoke;
rollback;
