-- Household budget spending is explicitly published; source Finance identities remain private.
create table public.household_budgets(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private',category text not null check(length(trim(category)) between 1 and 100),month date not null check(extract(day from month)=1 and month between '1900-01-01' and '2100-12-01'),currency text not null check(currency~'^[A-Z]{3}$'),amount numeric(12,2) not null check(amount>0 and amount<=1000000000),notes text not null default '' check(length(notes)<=2000),archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create unique index household_budget_identity on public.household_budgets(workspace_id,owner_id,month,lower(category),currency);
create table public.household_spending(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),budget_id uuid not null,currency text not null check(currency~'^[A-Z]{3}$'),amount numeric(12,2) not null check(amount>0 and amount<=1000000000),booked_on date not null,notes text not null default '' check(length(notes)<=2000),withdrawn boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),foreign key(workspace_id,budget_id) references public.household_budgets(workspace_id,id) on delete cascade
);
create table public.household_spending_links(
 id uuid primary key references public.household_spending(id) on delete cascade,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),transaction_id uuid references public.transactions(id) on delete set null,active boolean not null default true,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(workspace_id,id) references public.household_spending(workspace_id,id)
);
create unique index household_expense_once on public.household_spending_links(transaction_id) where active and transaction_id is not null;
do $$ declare t text;begin
 foreach t in array array['household_budgets','household_spending','household_spending_links'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,created_at,id)',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create index on public.household_spending(budget_id);
create policy household_budget_read on public.household_budgets for select to authenticated using(private.can_read(workspace_id,owner_id,visibility));
-- Contributors retain their own snapshot and private link even if the budget creator changes sharing.
create policy household_spending_read on public.household_spending for select to authenticated using(private.is_member(workspace_id) and(owner_id=auth.uid() or (not withdrawn and exists(select 1 from public.household_budgets b where b.id=budget_id and b.workspace_id=household_spending.workspace_id and private.can_read(b.workspace_id,b.owner_id,b.visibility)))));
create policy household_spending_link_read on public.household_spending_links for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id));
create table private.household_budget_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null);
revoke all on private.household_budget_requests from public,anon,authenticated,service_role;
create function private.household_budget_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.household_budget_requests;begin
 if request is null then raise exception 'Request ID required';end if;
 select * into r from private.household_budget_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id is distinct from w or r.owner_id is distinct from auth.uid() or r.payload is distinct from payload then raise exception 'Request was already used for another change';end if;return true;
end $$;
create function private.household_budget_parent(entry uuid,manage boolean) returns public.household_budgets language plpgsql security definer set search_path='' as $$
declare b public.household_budgets;begin
 select * into b from public.household_budgets where id=entry;
 if b.id is null or auth.uid() is null or not private.can_write(b.workspace_id) or not private.can_read(b.workspace_id,b.owner_id,b.visibility) or (manage and not private.can_edit(b.workspace_id,b.owner_id,b.visibility)) then raise exception 'Household budget is inaccessible';end if;
 perform pg_advisory_xact_lock(hashtextextended(b.workspace_id::text,42));select * into b from public.household_budgets where id=entry for update;
 if b.id is null or not private.can_write(b.workspace_id) or not private.can_read(b.workspace_id,b.owner_id,b.visibility) or (manage and not private.can_edit(b.workspace_id,b.owner_id,b.visibility)) then raise exception 'Household budget is inaccessible';end if;return b;
end $$;
create function public.save_household_budget(request uuid,entry uuid,w uuid,expected_revision integer,budget_category text,budget_month date,budget_currency text,budget_amount numeric,budget_notes text,sharing public.record_visibility) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.household_budgets;payload jsonb;begin
 if entry is null or auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,42));if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into b from public.household_budgets where id=entry for update;
 if b.id is not null and (b.workspace_id<>w or not private.can_edit(w,b.owner_id,b.visibility)) then raise exception 'Household budget is inaccessible';end if;
 payload:=jsonb_build_array('budget',entry,expected_revision,budget_category,budget_month,budget_currency,budget_amount,budget_notes,sharing);
 if private.household_budget_replayed(request,w,payload) then return entry;end if;
 if b.id is null and expected_revision is not null then raise exception 'Household budget is inaccessible';end if;
 if b.id is not null then
  if expected_revision is null or expected_revision<>b.revision then raise exception 'Household budget changed; refresh and try again';end if;
  if b.archived then raise exception 'Restore the budget before editing';end if;
  if b.owner_id<>auth.uid() and sharing is distinct from b.visibility then raise exception 'Only the budget creator can change sharing';end if;
  if (budget_month is distinct from b.month or budget_currency is distinct from b.currency or trim(budget_category) is distinct from b.category) and exists(select 1 from public.household_spending where budget_id=entry) then raise exception 'Category, month and currency cannot change after spending history exists';end if;
 end if;
 if budget_category is null or length(trim(budget_category)) not between 1 and 100 or budget_month is null or extract(day from budget_month)<>1 or budget_month not between '1900-01-01' and '2100-12-01' or budget_currency is null or budget_currency!~'^[A-Z]{3}$' or budget_amount is null or budget_amount<=0 or budget_amount>1000000000 or budget_amount<>round(budget_amount,2) or budget_notes is null or length(budget_notes)>2000 or sharing is null then raise exception 'Enter valid household budget details and a positive limit with two decimals';end if;
 if b.id is null then insert into public.household_budgets(id,workspace_id,owner_id,visibility,category,month,currency,amount,notes)values(entry,w,auth.uid(),sharing,trim(budget_category),budget_month,budget_currency,budget_amount,budget_notes);
 else update public.household_budgets set visibility=sharing,category=trim(budget_category),month=budget_month,currency=budget_currency,amount=budget_amount,notes=budget_notes,revision=revision+1 where id=entry;end if;
 insert into private.household_budget_requests values(request,w,auth.uid(),payload);return entry;
end $$;
create function public.set_household_budget_archive(request uuid,entry uuid,expected_revision integer,is_archived boolean) returns void language plpgsql security definer set search_path='' as $$
declare b public.household_budgets;payload jsonb;begin
 b:=private.household_budget_parent(entry,true);payload:=jsonb_build_array('archive',entry,expected_revision,is_archived);
 if private.household_budget_replayed(request,b.workspace_id,payload) then return;end if;
 if expected_revision is null or expected_revision<>b.revision then raise exception 'Household budget changed; refresh and try again';end if;
 if is_archived is null then raise exception 'Choose archive or restore';end if;
 update public.household_budgets set archived=is_archived,revision=revision+1 where id=entry;insert into private.household_budget_requests values(request,b.workspace_id,auth.uid(),payload);
end $$;
create function public.save_household_spending(request uuid,entry uuid,parent uuid,expected_revision integer,expected_parent_revision integer,expense uuid,spending_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare b public.household_budgets;s public.household_spending;l public.household_spending_links;t public.transactions;account_currency text;payload jsonb;begin
 b:=private.household_budget_parent(parent,false);
 select * into s from public.household_spending where id=entry for update;
 if s.id is not null and (s.budget_id<>parent or s.workspace_id<>b.workspace_id or s.owner_id<>auth.uid()) then raise exception 'Spending contribution is inaccessible';end if;
 payload:=jsonb_build_array('spending',entry,parent,expected_revision,expected_parent_revision,expense,spending_notes);
 if private.household_budget_replayed(request,b.workspace_id,payload) then return entry;end if;
 if b.archived then raise exception 'Restore the budget before linking or refreshing spending';end if;
 if expected_parent_revision is null or expected_parent_revision<>b.revision then raise exception 'Household budget changed; refresh and try again';end if;
 if s.id is not null then
  if expected_revision is null or expected_revision<>s.revision then raise exception 'Spending contribution changed; refresh and try again';end if;
  select * into l from public.household_spending_links where id=entry for update;
  if expense is distinct from l.transaction_id then raise exception 'Original expense is unavailable or cannot be replaced';end if;
 elsif expected_revision is not null then raise exception 'Spending contribution is inaccessible';end if;
 if entry is null or expense is null or spending_notes is null or length(spending_notes)>2000 then raise exception 'Choose an expense and valid contribution notes';end if;
 select * into t from public.transactions where id=expense and workspace_id=b.workspace_id and owner_id=auth.uid() for share;
 select currency into account_currency from public.accounts where id=t.account_id and workspace_id=b.workspace_id and owner_id=auth.uid() for share;
 if t.id is null or account_currency is null or t.kind<>'expense' or t.amount<=0 or t.amount>1000000000 or account_currency<>b.currency or date_trunc('month',t.booked_on)::date<>b.month then raise exception 'Choose your own expense in the budget month and currency';end if;
 if exists(select 1 from public.household_spending_links where transaction_id=expense and active and id<>entry) then raise exception 'Expense is already included in another household contribution';end if;
 if s.id is null then
  if (select count(*) from public.household_spending where budget_id=parent)>=500 then raise exception 'A budget supports up to 500 contributions including withdrawn history';end if;
  insert into public.household_spending(id,workspace_id,owner_id,budget_id,currency,amount,booked_on,notes)values(entry,b.workspace_id,auth.uid(),parent,b.currency,t.amount,t.booked_on,spending_notes);
  insert into public.household_spending_links(id,workspace_id,owner_id,transaction_id)values(entry,b.workspace_id,auth.uid(),expense);
 else update public.household_spending set amount=t.amount,booked_on=t.booked_on,notes=spending_notes,withdrawn=false,revision=revision+1 where id=entry;update public.household_spending_links set active=true where id=entry;end if;
 update public.household_budgets set revision=revision+1 where id=parent;insert into private.household_budget_requests values(request,b.workspace_id,auth.uid(),payload);return entry;
end $$;
create function public.withdraw_household_spending(request uuid,entry uuid,expected_revision integer) returns void language plpgsql security definer set search_path='' as $$
declare b public.household_budgets;s public.household_spending;payload jsonb;begin
 select * into s from public.household_spending where id=entry;
 if s.id is null or auth.uid() is null or s.owner_id<>auth.uid() or not private.can_write(s.workspace_id) then raise exception 'Your contribution with workspace write access is required';end if;
 perform pg_advisory_xact_lock(hashtextextended(s.workspace_id::text,42));select * into b from public.household_budgets where id=s.budget_id for update;select * into s from public.household_spending where id=entry for update;
 if s.id is null or s.owner_id<>auth.uid() or not private.can_write(s.workspace_id) then raise exception 'Your contribution with workspace write access is required';end if;
 payload:=jsonb_build_array('withdraw',entry,expected_revision);
 if private.household_budget_replayed(request,s.workspace_id,payload) then return;end if;
 if expected_revision is null or expected_revision<>s.revision then raise exception 'Spending contribution changed; refresh and try again';end if;
 -- An editor can withdraw their own published amount even when the budget is archived or no longer shared.
 update public.household_spending set withdrawn=true,revision=revision+1 where id=entry;update public.household_spending_links set active=false where id=entry;update public.household_budgets set revision=revision+1 where id=b.id;insert into private.household_budget_requests values(request,s.workspace_id,auth.uid(),payload);
end $$;
revoke all on function private.household_budget_replayed(uuid,uuid,jsonb),private.household_budget_parent(uuid,boolean) from public,anon,authenticated,service_role;
revoke all on function public.save_household_budget(uuid,uuid,uuid,integer,text,date,text,numeric,text,public.record_visibility),public.set_household_budget_archive(uuid,uuid,integer,boolean),public.save_household_spending(uuid,uuid,uuid,integer,integer,uuid,text),public.withdraw_household_spending(uuid,uuid,integer) from public,anon;
grant execute on function public.save_household_budget(uuid,uuid,uuid,integer,text,date,text,numeric,text,public.record_visibility),public.set_household_budget_archive(uuid,uuid,integer,boolean),public.save_household_spending(uuid,uuid,uuid,integer,integer,uuid,text),public.withdraw_household_spending(uuid,uuid,integer) to authenticated;
