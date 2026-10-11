-- Private finance planning; ledger posting is atomic and server-owned.
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  category text not null check(length(trim(category)) between 1 and 100),
  month date not null check(extract(day from month) = 1),
  currency text not null check(currency ~ '^[A-Z]{3}$'),
  amount numeric(14,2) not null check(amount > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(workspace_id,owner_id,month,category,currency)
);
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  account_id uuid not null, title text not null check(length(trim(title)) between 1 and 200),
  category text not null default 'Other' check(length(trim(category)) between 1 and 100),
  amount numeric(14,2) not null check(amount > 0), due_on date not null,
  status text not null default 'pending' check(status in ('pending','paid','cancelled')),
  paid_on date, transaction_id uuid unique references public.transactions(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,account_id) references public.accounts(workspace_id,id),
  check((status = 'paid') = (transaction_id is not null and paid_on is not null)),
  check(status = 'paid' or (transaction_id is null and paid_on is null))
);
create table public.recurring_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility = 'private'),
  account_id uuid not null, title text not null check(length(trim(title)) between 1 and 200),
  category text not null default 'Other' check(length(trim(category)) between 1 and 100),
  amount numeric(14,2) not null check(amount > 0), kind text not null check(kind in ('income','expense')),
  frequency text not null check(frequency in ('daily','weekly','monthly','yearly')),
  start_on date not null, next_on date not null, occurrence_count integer not null default 0 check(occurrence_count >= 0),
  active boolean not null default true, automatic boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(workspace_id,account_id) references public.accounts(workspace_id,id)
);
alter table public.transactions add column bill_id uuid unique references public.bills(id);
alter table public.transactions add column recurring_id uuid references public.recurring_transactions(id);
alter table public.transactions add column occurrence_on date;
alter table public.transactions add constraint transaction_source check(
  not (bill_id is not null and recurring_id is not null)
  and ((recurring_id is not null) = (occurrence_on is not null))
  and (bill_id is null or kind = 'expense')
  and (recurring_id is null or kind in ('income','expense'))
);
create unique index recurring_occurrence_unique on public.transactions(recurring_id,occurrence_on) where recurring_id is not null;

do $$ declare t text; begin
  foreach t in array array['budgets','bills','recurring_transactions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create index %I on public.%I (workspace_id,owner_id)',t||'_workspace_idx',t);
    execute format('create policy own_finance_read on public.%I for select to authenticated using (owner_id = (select auth.uid()) and private.is_member(workspace_id))',t);
    execute format('create policy own_finance_insert on public.%I for insert to authenticated with check (owner_id = (select auth.uid()) and private.can_write(workspace_id))',t);
    execute format('create policy own_finance_update on public.%I for update to authenticated using (owner_id = (select auth.uid()) and private.can_write(workspace_id)) with check (owner_id = (select auth.uid()) and private.can_write(workspace_id))',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert on public.%I to authenticated',t);
  end loop;
end $$;
grant update(amount) on public.budgets to authenticated;
grant delete on public.budgets to authenticated;
create policy own_budget_delete on public.budgets for delete to authenticated using(owner_id = (select auth.uid()) and private.can_write(workspace_id));
grant update(active,automatic) on public.recurring_transactions to authenticated;

create function private.validate_finance_plan() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.accounts a where a.id = new.account_id and a.workspace_id = new.workspace_id and a.owner_id = new.owner_id) then
    raise exception 'Account must be owned by the record owner in this workspace';
  end if;
  if tg_table_name = 'bills' then
    if new.status <> 'pending' or new.transaction_id is not null or new.paid_on is not null then raise exception 'Bill posting is server-owned'; end if;
  elsif new.next_on <> new.start_on or new.occurrence_count <> 0 then
    raise exception 'Recurring cursor is server-owned';
  end if;
  return new;
end $$;
create trigger validate_finance_plan before insert on public.bills for each row execute function private.validate_finance_plan();
create trigger validate_finance_plan before insert on public.recurring_transactions for each row execute function private.validate_finance_plan();

create function private.finance_today(person uuid) returns date language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce((select z.name from public.profiles p join pg_catalog.pg_timezone_names z on z.name = p.timezone where p.id = person),'UTC'))::date;
$$;
create function public.settle_bill(bill uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare b public.bills; tx uuid;
begin
  select * into b from public.bills where id = bill for update;
  if b.id is null or b.owner_id is distinct from auth.uid() or not private.can_write(b.workspace_id) then raise exception 'Bill owner with write access required'; end if;
  if b.status = 'paid' then return b.transaction_id; end if;
  if b.status <> 'pending' then raise exception 'Cancelled bills cannot be paid'; end if;
  insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,bill_id)
    values(b.workspace_id,b.owner_id,b.account_id,b.title,b.amount,'expense',b.category,private.finance_today(b.owner_id),b.id) returning id into tx;
  update public.bills set status = 'paid', paid_on = private.finance_today(b.owner_id), transaction_id = tx where id = bill;
  return tx;
end $$;
create function public.cancel_bill(bill uuid) returns void language plpgsql security definer set search_path = '' as $$
declare b public.bills;
begin
  select * into b from public.bills where id = bill for update;
  if b.id is null or b.owner_id is distinct from auth.uid() or not private.can_write(b.workspace_id) then raise exception 'Bill owner with write access required'; end if;
  if b.status = 'paid' then raise exception 'Paid bills cannot be cancelled'; end if;
  update public.bills set status = 'cancelled' where id = bill;
end $$;

-- Calculate each occurrence from the original anchor, avoiding month-end drift.
create function private.recurrence_date(anchor date, frequency text, occurrence integer) returns date language sql immutable set search_path = '' as $$
  select case frequency
    when 'daily' then anchor + occurrence
    when 'weekly' then anchor + 7 * occurrence
    when 'monthly' then (anchor + pg_catalog.make_interval(months => occurrence))::date
    when 'yearly' then (anchor + pg_catalog.make_interval(years => occurrence))::date end;
$$;
create function private.post_recurring(plan uuid) returns integer language plpgsql security definer set search_path = '' as $$
declare r public.recurring_transactions; posted integer := 0; today date;
begin
  select * into r from public.recurring_transactions where id = plan for update;
  if r.id is null or not r.active then return 0; end if;
  if not exists(select 1 from public.workspace_members m where m.workspace_id = r.workspace_id and m.user_id = r.owner_id and m.role in ('owner','editor')) then return 0; end if;
  today := private.finance_today(r.owner_id);
  while r.next_on <= today and posted < 100 loop
    insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,recurring_id,occurrence_on)
      values(r.workspace_id,r.owner_id,r.account_id,r.title,r.amount,r.kind,r.category,r.next_on,r.id,r.next_on)
      on conflict(recurring_id,occurrence_on) where recurring_id is not null do nothing;
    r.occurrence_count := r.occurrence_count + 1;
    r.next_on := private.recurrence_date(r.start_on,r.frequency,r.occurrence_count);
    posted := posted + 1;
  end loop;
  update public.recurring_transactions set occurrence_count = r.occurrence_count, next_on = r.next_on where id = plan;
  return posted;
end $$;
create function public.post_recurring_due(plan uuid) returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.recurring_transactions r where r.id = plan and r.owner_id = auth.uid() and private.can_write(r.workspace_id)) then raise exception 'Schedule owner with write access required'; end if;
  return private.post_recurring(plan);
end $$;
create function public.post_due_recurring_transactions() returns integer language plpgsql security definer set search_path = '' as $$
declare r record; posted integer := 0;
begin
  for r in select id from public.recurring_transactions where active and automatic and next_on <= current_date + 1 order by next_on,id limit 500 for update skip locked loop
    posted := posted + private.post_recurring(r.id);
  end loop;
  return posted;
end $$;
revoke all on function private.validate_finance_plan(), private.finance_today(uuid), private.recurrence_date(date,text,integer), private.post_recurring(uuid) from public,anon,authenticated;
revoke all on function public.settle_bill(uuid), public.cancel_bill(uuid), public.post_recurring_due(uuid), public.post_due_recurring_transactions() from public,anon,authenticated;
grant execute on function public.settle_bill(uuid), public.cancel_bill(uuid), public.post_recurring_due(uuid) to authenticated;
grant execute on function public.post_due_recurring_transactions() to service_role;
