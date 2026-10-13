-- Synthetic identities only; every write rolls back. No mail, credentials or files.
begin;
create temporary table lifeos_project_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;p uuid:=gen_random_uuid();m uuid:=gen_random_uuid();budget uuid:=gen_random_uuid();account uuid;expense uuid;denied boolean;
begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable project owner"}'),(b,'{"display_name":"Disposable budget owner"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable project planning','family');perform public.set_workspace_member(w,b,'editor');
 perform public.save_planned_project(p,w,null,'Synthetic launch','Notes','active','green','2026-12-31','workspace');
 perform public.save_planned_project(p,w,null,'Ignored retry','','paused','blue',null,'private');
 if not exists(select 1 from public.projects where id=p and revision=1 and title='Synthetic launch') then raise exception 'Project replay changed metadata';end if;
 perform public.save_project_milestone(m,w,null,p,'Synthetic milestone','2026-11-30','Plan');
 perform public.act_on_project_milestone(m,1,'complete');perform public.act_on_project_milestone(m,1,'complete');
 denied:=false;begin perform public.act_on_project_milestone(m,1,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Stale milestone accepted';end if;
 perform set_config('request.jwt.claim.sub',b::text,true);
 if not exists(select 1 from public.project_milestones where id=m and done and revision=2) then raise exception 'Shared milestone hidden';end if;
 denied:=false;begin perform public.act_on_project_milestone(m,2,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Member changed creator milestone';end if;
 perform public.save_project_budget(budget,w,null,p,'INR',10000);perform public.save_project_budget(budget,w,null,p,'INR',20000);
 insert into public.accounts(workspace_id,name,currency)values(w,'Synthetic project account','INR')returning id into account;expense:=public.record_transaction(w,account,'Synthetic materials',1500,'expense','Supplies',current_date);
 perform public.link_project_expense(expense,null,p);perform public.link_project_expense(expense,null,p);
 if not exists(select 1 from public.transactions where id=expense and amount=1500 and project_id=p) or not exists(select 1 from public.project_budgets where id=budget and amount=10000 and revision=1) then raise exception 'Expense or budget replay failed';end if;
 denied:=false;begin perform public.link_project_expense(expense,null,null);exception when others then denied:=true;end;if not denied then raise exception 'Stale expense move accepted';end if;
 perform public.set_project_budget_archive(budget,1,true);perform public.set_project_budget_archive(budget,1,true);perform public.set_project_budget_archive(budget,2,false);
 perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.project_budgets where id=budget) or exists(select 1 from public.transactions where id=expense) then raise exception 'Workspace owner read private finances';end if;
 perform public.save_planned_project(p,w,1,'Synthetic launch','Notes','completed','green','2026-12-31','workspace');
 denied:=false;begin perform public.act_on_project_milestone(m,2,'reopen');exception when others then denied:=true;end;if not denied then raise exception 'Completed project milestone changed';end if;
 perform public.remove_workspace_member(w,b);perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.project_milestones where id=m) or exists(select 1 from public.project_budgets where id=budget) then raise exception 'Removed member retained project access';end if;
 reset role;insert into lifeos_project_smoke values('Project/milestone permissions, revisions and replay, private budgets/expenses, unchanged ledger amounts, completed-project protection and membership revocation passed; synthetic rows rolled back.');
end $$;
select * from lifeos_project_smoke;
rollback;
