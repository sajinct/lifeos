create table public.travel_plans (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 kind text not null check(kind in ('trip','event')),title text not null check(length(trim(title)) between 1 and 200),location text not null default '' check(length(location)<=300),
 starts_on date not null check(starts_on between '1900-01-01' and '2100-12-31'),ends_on date not null check(ends_on between starts_on and '2100-12-31'),timezone text not null,
 status text not null default 'planning' check(status in ('planning','active','completed','cancelled')),notes text not null default '' check(length(notes)<=4000),archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table public.travel_entries (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),plan_id uuid not null,
 kind text not null check(kind in ('itinerary','booking','checklist','guest')),title text not null check(length(trim(title)) between 1 and 200),date_on date,end_on date,
 time_at text not null default '',end_time text not null default '',location text not null default '' check(length(location)<=300),reference text not null default '' check(length(reference)<=200),
 cost numeric(14,2),currency text not null default '',email text not null default '' check(length(email)<=200),phone text not null default '' check(length(phone)<=50),guest_count integer,
 status text not null,notes text not null default '' check(length(notes)<=2000),archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,plan_id) references public.travel_plans(workspace_id,id) on delete cascade,
 check(time_at='' or time_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),check(end_time='' or end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),check(cost is null or (cost>=0 and cost<1000000000000)),check((cost is null and currency='')or(cost is not null and currency ~ '^[A-Z]{3}$')),
 check((kind='itinerary' and status in ('scheduled','done','cancelled'))or(kind='booking' and status in ('planned','confirmed','cancelled'))or(kind='checklist' and status in ('todo','done'))or(kind='guest' and status in ('invited','accepted','declined','tentative')))
);
create table public.travel_budgets (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),plan_id uuid not null,
 currency text not null check(currency ~ '^[A-Z]{3}$'),amount numeric(14,2) not null check(amount>0 and amount<1000000000000),archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,plan_id) references public.travel_plans(workspace_id,id) on delete cascade,unique(plan_id,currency)
);
create table public.travel_expenses (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),plan_id uuid not null,transaction_id uuid not null,
 notes text not null default '' check(length(notes)<=2000),archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,plan_id) references public.travel_plans(workspace_id,id) on delete cascade,foreign key(workspace_id,transaction_id) references public.transactions(workspace_id,id)
);
create unique index travel_expense_once on public.travel_expenses(workspace_id,owner_id,transaction_id) where not archived;
do $$declare t text;begin
 foreach t in array array['travel_plans','travel_entries','travel_budgets','travel_expenses'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);execute format('create policy own_travel_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create function private.travel_parent(parent uuid,w uuid,allow_archived boolean default false) returns public.travel_plans language plpgsql security definer set search_path='' as $$
declare p public.travel_plans;begin
 perform pg_advisory_xact_lock(hashtextextended(parent::text,24));select * into p from public.travel_plans where id=parent for update;
 if not found or auth.uid() is null or p.workspace_id is distinct from w or p.owner_id is distinct from auth.uid() or not private.can_write(w) then raise exception 'Travel owner with workspace write access required';end if;
 if p.archived and not allow_archived then raise exception 'Restore the travel plan first';end if;return p;
end $$;
create function public.save_travel_plan(entry uuid,w uuid,expected_revision integer,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.travel_plans;v public.travel_plans;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,24));select * into r from public.travel_plans where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Travel plan is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Travel plan changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Travel plan is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid travel details';end if;select * into v from jsonb_populate_record(null::public.travel_plans,details);
 if v.kind is null or v.kind not in ('trip','event') or (r.id is not null and v.kind<>r.kind) or v.title is null or length(trim(v.title)) not between 1 and 200 or v.location is null or length(v.location)>300 or v.notes is null or length(v.notes)>4000 or v.starts_on is null or v.ends_on is null or v.starts_on not between '1900-01-01' and '2100-12-31' or v.ends_on not between v.starts_on and '2100-12-31' or v.status is null or v.status not in ('planning','active','completed','cancelled') or v.timezone is null or not exists(select 1 from pg_timezone_names where name=v.timezone) then raise exception 'Check travel name, dates, status and time zone';end if;
 if exists(select 1 from public.travel_entries where plan_id=entry and (date_on<v.starts_on or date_on>v.ends_on or end_on>v.ends_on)) then raise exception 'Keep plan dates around all saved itinerary and booking dates, including archives';end if;
 if r.id is null then insert into public.travel_plans(id,workspace_id,owner_id,kind,title,location,starts_on,ends_on,timezone,status,notes)values(entry,w,auth.uid(),v.kind,trim(v.title),trim(v.location),v.starts_on,v.ends_on,v.timezone,v.status,v.notes);
 else update public.travel_plans set title=trim(v.title),location=trim(v.location),starts_on=v.starts_on,ends_on=v.ends_on,timezone=v.timezone,status=v.status,notes=v.notes,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.save_travel_entry(entry uuid,w uuid,expected_revision integer,parent uuid,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.travel_plans;r public.travel_entries;v public.travel_entries;raw_cost numeric;
begin
 p:=private.travel_parent(parent,w);if p.status in ('completed','cancelled') then raise exception 'Reopen the plan before changing planning details';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,25));select * into r from public.travel_entries where id=entry for update;
 if found then
  if r.workspace_id<>w or r.plan_id<>parent or r.owner_id is distinct from auth.uid() then raise exception 'Planning entry is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Planning entry changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Planning entry is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid planning details';end if;
 raw_cost:=(details->>'cost')::numeric;if raw_cost is not null and (raw_cost::text in ('NaN','Infinity','-Infinity') or raw_cost<0 or raw_cost>=1000000000000 or raw_cost<>round(raw_cost,2))then raise exception 'Use a non-negative booking cost with two decimals';end if;
 select * into v from jsonb_populate_record(null::public.travel_entries,details);
 if v.kind is null or v.kind not in ('itinerary','booking','checklist','guest') or (r.id is not null and v.kind<>r.kind) or v.title is null or length(trim(v.title)) not between 1 and 200 or v.location is null or length(v.location)>300 or v.reference is null or length(v.reference)>200 or v.notes is null or length(v.notes)>2000 or v.email is null or length(v.email)>200 or (v.email<>'' and v.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') or v.phone is null or length(v.phone)>50 or v.time_at is null or (v.time_at<>'' and v.time_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') or v.end_time is null or (v.end_time<>'' and v.end_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') or v.currency is null or v.status is null then raise exception 'Check planning details';end if;
 if not ((v.kind='itinerary' and v.status in ('scheduled','done','cancelled'))or(v.kind='booking' and v.status in ('planned','confirmed','cancelled'))or(v.kind='checklist' and v.status in ('todo','done'))or(v.kind='guest' and v.status in ('invited','accepted','declined','tentative'))) then raise exception 'Invalid planning status';end if;
 if v.kind in ('itinerary','booking') then
  if v.date_on is null or v.date_on not between p.starts_on and p.ends_on or (v.end_on is not null and v.end_on not between v.date_on and p.ends_on) or (v.end_time<>'' and (v.time_at='' or (coalesce(v.end_on,v.date_on)=v.date_on and v.end_time<v.time_at))) or v.email<>'' or v.phone<>'' or v.guest_count is not null then raise exception 'Keep itinerary and booking dates within the plan, with valid time order';end if;
 else
  if v.date_on is not null or v.end_on is not null or v.time_at<>'' or v.end_time<>'' or v.location<>'' or v.reference<>'' then raise exception 'These fields do not belong to a checklist or guest';end if;
 end if;
 if (v.kind<>'booking' and (v.cost is not null or v.currency<>'')) or (v.cost is null and v.currency<>'') or (v.cost is not null and v.currency !~ '^[A-Z]{3}$') then raise exception 'Cost and currency apply to bookings';end if;
 if (v.kind='guest' and (v.guest_count is null or v.guest_count not between 1 and 100000)) or (v.kind<>'guest' and (v.guest_count is not null or v.email<>'' or v.phone<>'')) then raise exception 'Check guest count and contact fields';end if;
 if r.id is null then insert into public.travel_entries(id,workspace_id,owner_id,plan_id,kind,title,date_on,end_on,time_at,end_time,location,reference,cost,currency,email,phone,guest_count,status,notes)values(entry,w,auth.uid(),parent,v.kind,trim(v.title),v.date_on,v.end_on,v.time_at,v.end_time,trim(v.location),trim(v.reference),v.cost,v.currency,trim(v.email),trim(v.phone),v.guest_count,v.status,v.notes);
 else update public.travel_entries set title=trim(v.title),date_on=v.date_on,end_on=v.end_on,time_at=v.time_at,end_time=v.end_time,location=trim(v.location),reference=trim(v.reference),cost=v.cost,currency=v.currency,email=trim(v.email),phone=trim(v.phone),guest_count=v.guest_count,status=v.status,notes=v.notes,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.save_travel_budget(entry uuid,w uuid,expected_revision integer,parent uuid,budget_currency text,budget_amount numeric) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.travel_budgets;p public.travel_plans;
begin
 p:=private.travel_parent(parent,w);perform pg_advisory_xact_lock(hashtextextended(entry::text,26));select * into r from public.travel_budgets where id=entry for update;
 if found then
  if r.plan_id<>parent or r.workspace_id<>w or r.owner_id is distinct from auth.uid() or r.currency is distinct from budget_currency then raise exception 'Budget binding is immutable';end if;
  if expected_revision is null then return entry;end if;if r.revision<>expected_revision or r.archived then raise exception 'Travel budget changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Travel budget is inaccessible';end if;
 if budget_currency is null or budget_currency !~ '^[A-Z]{3}$' or budget_amount is null or budget_amount::text in ('NaN','Infinity','-Infinity') or budget_amount<=0 or budget_amount>=1000000000000 or budget_amount<>round(budget_amount,2) then raise exception 'Use a positive budget with two decimals and a three-letter currency';end if;
 if r.id is null then
  if exists(select 1 from public.travel_budgets where plan_id=parent and currency=budget_currency)then raise exception 'Budget exists; edit or restore this currency';end if;
  insert into public.travel_budgets(id,workspace_id,owner_id,plan_id,currency,amount)values(entry,w,auth.uid(),parent,budget_currency,budget_amount);
 else update public.travel_budgets set amount=budget_amount,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.save_travel_expense(entry uuid,w uuid,expected_revision integer,parent uuid,expense uuid,expense_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.travel_plans;r public.travel_expenses;
begin
 p:=private.travel_parent(parent,w);perform pg_advisory_xact_lock(hashtextextended(entry::text,27));select * into r from public.travel_expenses where id=entry for update;
 if found then
  if r.plan_id<>parent or r.workspace_id<>w or r.owner_id is distinct from auth.uid() or r.transaction_id is distinct from expense then raise exception 'Expense binding is immutable';end if;
  if expected_revision is null then return entry;end if;if r.revision<>expected_revision or r.archived then raise exception 'Travel expense changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Travel expense is inaccessible';end if;
 if not exists(select 1 from public.transactions where id=expense and workspace_id=w and owner_id=auth.uid() and kind='expense')then raise exception 'Choose your own recorded expense';end if;
 if expense_notes is null or length(expense_notes)>2000 then raise exception 'Notes must be up to 2000 characters';end if;
 if r.id is null then
  if exists(select 1 from public.travel_expenses where workspace_id=w and owner_id=auth.uid() and transaction_id=expense and not archived)then raise exception 'Expense already linked; archive its active link first';end if;
  insert into public.travel_expenses(id,workspace_id,owner_id,plan_id,transaction_id,notes)values(entry,w,auth.uid(),parent,expense,expense_notes);
 else update public.travel_expenses set notes=expense_notes,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.act_on_travel_record(entry uuid,record_kind text,expected_revision integer,action text) returns void language plpgsql security definer set search_path='' as $$
declare t text;r record;p public.travel_plans;parent uuid;w uuid;arch boolean;s text;
begin
 t:=case record_kind when 'plan' then 'travel_plans' when 'entry' then 'travel_entries' when 'budget' then 'travel_budgets' when 'expense' then 'travel_expenses' else null end;
 if t is null or action is null or action not in ('archive','restore','complete','reopen') or (record_kind<>'entry' and action in ('complete','reopen')) then raise exception 'Invalid travel action';end if;
 if record_kind='plan' then select id,workspace_id into parent,w from public.travel_plans where id=entry;
 else execute format('select plan_id,workspace_id from public.%I where id=$1',t)into parent,w using entry;end if;
 p:=private.travel_parent(parent,w,record_kind='plan');execute format('select * from public.%I where id=$1 for update',t)into r using entry;
 if r.id is null or r.owner_id is distinct from auth.uid() then raise exception 'Travel record is inaccessible';end if;
 if record_kind='entry' and p.status in ('completed','cancelled') then raise exception 'Reopen the plan before changing planning details';end if;
 if action in ('complete','reopen') then if r.kind not in ('itinerary','checklist')then raise exception 'Completion applies to itinerary or checklists';end if;end if;
 arch:=case action when 'archive' then true when 'restore' then false else r.archived end;
 if record_kind='entry' then
  s:=case action when 'complete' then 'done' when 'reopen' then case r.kind when 'checklist' then 'todo' else 'scheduled' end else r.status end;
  if r.archived=arch and r.status=s then return;end if;
 else if r.archived=arch then return;end if;end if;
 if expected_revision is null or r.revision<>expected_revision or (r.archived and action in ('complete','reopen')) then raise exception 'Travel record changed; restore or refresh';end if;
 if record_kind='expense' and action='restore' then
  if exists(select 1 from public.travel_expenses e where e.id<>entry and e.workspace_id=w and e.owner_id=auth.uid() and e.transaction_id=r.transaction_id and not e.archived)then raise exception 'Expense is active under another link; archive it first';end if;
 end if;
 if record_kind='entry' then update public.travel_entries set archived=arch,status=s,revision=revision+1 where id=entry;
 else execute format('update public.%I set archived=$2,revision=revision+1 where id=$1',t)using entry,arch;end if;
end $$;
revoke all on function private.travel_parent(uuid,uuid,boolean) from public,anon,authenticated;
revoke all on function public.save_travel_plan(uuid,uuid,integer,jsonb),public.save_travel_entry(uuid,uuid,integer,uuid,jsonb),public.save_travel_budget(uuid,uuid,integer,uuid,text,numeric),public.save_travel_expense(uuid,uuid,integer,uuid,uuid,text),public.act_on_travel_record(uuid,text,integer,text) from public,anon,authenticated;
grant execute on function public.save_travel_plan(uuid,uuid,integer,jsonb),public.save_travel_entry(uuid,uuid,integer,uuid,jsonb),public.save_travel_budget(uuid,uuid,integer,uuid,text,numeric),public.save_travel_expense(uuid,uuid,integer,uuid,uuid,text),public.act_on_travel_record(uuid,text,integer,text) to authenticated;
