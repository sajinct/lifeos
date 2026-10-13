-- Private manual investment bookkeeping and frozen net-worth snapshots.
create table public.investment_holdings(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 title text not null check(length(trim(title)) between 1 and 200),kind text not null check(kind in('stock','fund','bond','deposit','crypto','other')),currency text not null check(currency ~ '^[A-Z]{3}$'),opened_on date not null check(opened_on between '1900-01-01' and '2100-12-31'),
 opening_cost numeric(14,2) not null check(opening_cost>=0),opening_value numeric(14,2) not null check(opening_value>=0),current_cost numeric(14,2) not null check(current_cost>=0),current_value numeric(14,2) not null check(current_value>=0),last_entry_on date not null,next_sequence integer not null default 1,
 notes text not null default '' check(length(notes)<=2000),archived boolean not null default false,revision integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table public.investment_entries(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),holding_id uuid not null,sequence integer not null,
 kind text not null check(kind in('contribution','withdrawal','valuation')),amount numeric(14,2) not null check(amount>=0),basis_removed numeric(14,2) not null check(basis_removed>=0),occurred_on date not null,account_id uuid,transaction_id uuid unique references public.transactions(id),reversal_id uuid unique,voided boolean not null default false,
 before_cost numeric(14,2) not null,before_value numeric(14,2) not null,notes text not null default '' check(length(notes)<=2000),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(holding_id,sequence),foreign key(workspace_id,holding_id) references public.investment_holdings(workspace_id,id),foreign key(workspace_id,account_id) references public.accounts(workspace_id,id),check((account_id is null)=(transaction_id is null)),check(reversal_id is null or (voided and transaction_id is not null))
);
create table public.wealth_exclusions(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),source_kind text not null check(source_kind in('account','asset','loan','holding')),source_id uuid not null,excluded boolean not null,revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,owner_id,source_kind,source_id)
);
create table public.wealth_asset_values(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),asset_id uuid not null unique,currency text not null check(currency ~ '^[A-Z]{3}$'),amount numeric(14,2) not null check(amount>=0),valued_on date not null,notes text not null default '' check(length(notes)<=2000),revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(workspace_id,asset_id) references public.assets(workspace_id,id)
);
create table public.wealth_snapshots(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),label text not null check(length(trim(label)) between 1 and 200),captured_on date not null,totals jsonb not null check(jsonb_typeof(totals)='array'),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
do $$ declare t text;begin foreach t in array array['investment_holdings','investment_entries','wealth_exclusions','wealth_asset_values','wealth_snapshots'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);execute format('create policy own_wealth_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
 execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;end $$;
create function private.wealth_money(value numeric) returns numeric language plpgsql immutable set search_path='' as $$
begin if value is null or value::text in('NaN','Infinity','-Infinity') or value<0 or value>=1000000000000 or value<>round(value,2) then raise exception 'Enter an amount below one trillion with up to two decimals';end if;return value;end $$;
create function private.holding_parent(entry uuid,w uuid) returns public.investment_holdings language plpgsql security definer set search_path='' as $$
declare r public.investment_holdings;begin
 if auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,30));select * into r from public.investment_holdings where id=entry for update;
 if r.id is null or r.owner_id is distinct from auth.uid() or r.workspace_id<>w then raise exception 'Holding is inaccessible';end if;return r;end $$;
create function public.save_investment_holding(entry uuid,w uuid,expected_revision integer,details jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.investment_holdings;v public.investment_holdings;cost numeric;value numeric;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,30));select * into r from public.investment_holdings where id=entry for update;
 if found then
  if r.owner_id is distinct from auth.uid() or r.workspace_id<>w then raise exception 'Holding is inaccessible';end if;
  if expected_revision is null then return entry;end if;
  if r.revision<>expected_revision or r.archived then raise exception 'Holding changed; restore or refresh';end if;
 elsif expected_revision is not null then raise exception 'Holding is inaccessible';end if;
 if details is null or jsonb_typeof(details)<>'object' then raise exception 'Invalid holding';end if;
 select * into v from jsonb_populate_record(null::public.investment_holdings,details);
 if v.title is null or length(trim(v.title)) not between 1 and 200 or v.kind is null or v.kind not in('stock','fund','bond','deposit','crypto','other') or v.notes is null or length(v.notes)>2000 then raise exception 'Check holding name, type and notes';end if;
 if r.id is null then
  cost:=private.wealth_money((details->>'opening_cost')::numeric);value:=private.wealth_money((details->>'opening_value')::numeric);
  if v.currency is null or v.currency !~ '^[A-Z]{3}$' or v.opened_on is null or v.opened_on not between '1900-01-01' and private.finance_today(auth.uid()) then raise exception 'Check currency and opening date';end if;
  insert into public.investment_holdings(id,workspace_id,owner_id,title,kind,currency,opened_on,opening_cost,opening_value,current_cost,current_value,last_entry_on,notes)values(entry,w,auth.uid(),trim(v.title),v.kind,v.currency,v.opened_on,cost,value,cost,value,v.opened_on,v.notes);
 else
  if v.currency is distinct from r.currency or v.opened_on is distinct from r.opened_on or v.opening_cost is distinct from r.opening_cost or v.opening_value is distinct from r.opening_value then raise exception 'Opening balances, date and currency cannot change';end if;
  update public.investment_holdings set title=trim(v.title),kind=v.kind,notes=v.notes,revision=revision+1 where id=entry;
 end if;return entry;end $$;
create function public.append_investment_entry(entry uuid,w uuid,parent uuid,expected_revision integer,entry_kind text,entry_amount numeric,removed_basis numeric,entry_date date,bank_account uuid,entry_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare h public.investment_holdings;r public.investment_entries;a public.accounts;cost numeric;value numeric;tx uuid;
begin
 h:=private.holding_parent(parent,w);if entry is null then raise exception 'Entry id required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,31));select * into r from public.investment_entries where id=entry;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() or r.holding_id is distinct from parent or r.kind is distinct from entry_kind or r.amount is distinct from entry_amount or r.basis_removed is distinct from removed_basis or r.occurred_on is distinct from entry_date or r.account_id is distinct from bank_account or r.notes is distinct from entry_notes then raise exception 'Investment request reused';end if;return entry;
 end if;
 if h.archived or expected_revision is null or h.revision<>expected_revision then raise exception 'Holding changed; restore or refresh';end if;
 entry_amount:=private.wealth_money(entry_amount);removed_basis:=private.wealth_money(removed_basis);
 if entry_kind is null or entry_kind not in('contribution','withdrawal','valuation') or entry_date is null or entry_date<h.last_entry_on or entry_date>private.finance_today(auth.uid()) or entry_notes is null or length(entry_notes)>2000 then raise exception 'Check entry type, chronological date and notes';end if;
 cost:=h.current_cost;value:=h.current_value;
 if entry_kind='contribution' then
  if entry_amount<=0 or removed_basis<>0 then raise exception 'Contribution must be positive with no removed basis';end if;cost:=cost+entry_amount;value:=value+entry_amount;
 elsif entry_kind='withdrawal' then
  if entry_amount>value or removed_basis>cost or (entry_amount=0 and removed_basis=0) then raise exception 'Withdrawal exceeds value or cost basis';end if;cost:=cost-removed_basis;value:=value-entry_amount;
 else
  if removed_basis<>0 or bank_account is not null then raise exception 'Valuation cannot post to a bank account or remove basis';end if;value:=entry_amount;
 end if;
 perform private.wealth_money(cost);perform private.wealth_money(value);
 if bank_account is not null then
  perform 1 from public.accounts where id=bank_account for update;select * into a from public.accounts where id=bank_account and workspace_id=w and owner_id=auth.uid();
  if entry_amount=0 or a.id is null or a.currency<>h.currency or exists(select 1 from public.credit_cards where account_id=bank_account) then raise exception 'Choose your own non-card bank account in the holding currency';end if;
  if exists(select 1 from public.transactions where transfer_id=entry) then raise exception 'Transfer request reused';end if;
  insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,transfer_id)values(w,auth.uid(),bank_account,h.title||' · investment '||entry_kind,entry_amount,case when entry_kind='contribution' then 'transfer_out' else 'transfer_in' end,'Investment transfer',entry_date,entry) returning id into tx;
 end if;
 insert into public.investment_entries(id,workspace_id,owner_id,holding_id,sequence,kind,amount,basis_removed,occurred_on,account_id,transaction_id,before_cost,before_value,notes)values(entry,w,auth.uid(),parent,h.next_sequence,entry_kind,entry_amount,removed_basis,entry_date,bank_account,tx,h.current_cost,h.current_value,entry_notes);
 update public.investment_holdings set current_cost=cost,current_value=value,last_entry_on=entry_date,next_sequence=next_sequence+1,revision=revision+1 where id=parent;return entry;
end $$;
create function public.undo_investment_entry(entry uuid,expected_revision integer) returns void language plpgsql security definer set search_path='' as $$
declare r public.investment_entries;h public.investment_holdings;tx public.transactions;reversal uuid;last_date date;
begin
 select * into r from public.investment_entries where id=entry;h:=private.holding_parent(r.holding_id,r.workspace_id);select * into r from public.investment_entries where id=entry for update;
 if r.voided then return;end if;
 if h.archived or expected_revision is null or h.revision<>expected_revision then raise exception 'Holding changed; restore or refresh';end if;
 if exists(select 1 from public.investment_entries where holding_id=h.id and sequence>r.sequence and not voided) then raise exception 'Undo newer entries before correcting an older one';end if;
 if r.transaction_id is not null then
  select * into tx from public.transactions where id=r.transaction_id;reversal:=gen_random_uuid();
  insert into public.transactions(workspace_id,owner_id,account_id,title,amount,kind,category,booked_on,transfer_id)values(r.workspace_id,r.owner_id,r.account_id,h.title||' · investment reversal',r.amount,case when tx.kind='transfer_out' then 'transfer_in' else 'transfer_out' end,'Investment reversal',private.finance_today(r.owner_id),reversal);
 end if;
 update public.investment_entries set voided=true,reversal_id=reversal where id=entry;
 select greatest(h.opened_on,coalesce(max(occurred_on),h.opened_on))into last_date from public.investment_entries where holding_id=h.id and not voided;
 update public.investment_holdings set current_cost=r.before_cost,current_value=r.before_value,last_entry_on=last_date,revision=revision+1 where id=h.id;
end $$;
create function public.archive_investment_holding(entry uuid,expected_revision integer,archived_value boolean) returns void language plpgsql security definer set search_path='' as $$
declare h public.investment_holdings;begin
 select * into h from public.investment_holdings where id=entry;h:=private.holding_parent(entry,h.workspace_id);
 if archived_value is null then raise exception 'Choose archive or restore';end if;if h.archived=archived_value then return;end if;
 if expected_revision is null or h.revision<>expected_revision then raise exception 'Holding changed; refresh';end if;
 if archived_value and (h.current_cost<>0 or h.current_value<>0) then raise exception 'Clear holding value and cost basis before archiving';end if;
 update public.investment_holdings set archived=archived_value,revision=revision+1 where id=entry;
end $$;
create function public.set_wealth_exclusion(entry uuid,w uuid,expected_revision integer,source_kind text,source_id uuid,excluded_value boolean) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.wealth_exclusions;valid boolean;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,32));select * into r from public.wealth_exclusions where id=entry for update;
 if found then
  if r.owner_id is distinct from auth.uid() or r.workspace_id<>w or r.source_kind is distinct from source_kind or r.source_id is distinct from source_id then raise exception 'Wealth source is inaccessible';end if;
  if r.excluded=excluded_value then return entry;end if;
  if expected_revision is null or r.revision<>expected_revision then raise exception 'Inclusion changed; refresh';end if;
 elsif expected_revision is not null then raise exception 'Wealth source is inaccessible';end if;
 if excluded_value is null then raise exception 'Choose inclusion';end if;
 case source_kind
 when 'account' then select exists(select 1 from public.accounts where id=source_id and workspace_id=w and owner_id=auth.uid())into valid;
 when 'asset' then select exists(select 1 from public.assets where id=source_id and workspace_id=w and owner_id=auth.uid())into valid;
 when 'loan' then select exists(select 1 from public.loans where id=source_id and workspace_id=w and owner_id=auth.uid())into valid;
 when 'holding' then select exists(select 1 from public.investment_holdings where id=source_id and workspace_id=w and owner_id=auth.uid())into valid;
 else raise exception 'Unknown wealth source';end case;
 if not valid then raise exception 'Choose your own wealth source';end if;
 if r.id is null then insert into public.wealth_exclusions(id,workspace_id,owner_id,source_kind,source_id,excluded)values(entry,w,auth.uid(),source_kind,source_id,excluded_value);
 else update public.wealth_exclusions set excluded=excluded_value,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function public.save_wealth_asset_value(entry uuid,w uuid,expected_revision integer,asset uuid,value_amount numeric,value_date date,value_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare a public.assets;r public.wealth_asset_values;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(asset::text,8));select * into a from public.assets where id=asset for update;
 if a.id is null or a.workspace_id<>w or a.owner_id is distinct from auth.uid() or a.status<>'active' then raise exception 'Choose your own active asset';end if;
 select * into r from public.wealth_asset_values where id=entry for update;
 if found then
  if r.workspace_id<>w or r.owner_id is distinct from auth.uid() or r.asset_id is distinct from asset then raise exception 'Asset valuation is inaccessible';end if;
  if expected_revision is null then return entry;end if;if r.revision<>expected_revision then raise exception 'Asset value changed; refresh';end if;
 elsif expected_revision is not null then raise exception 'Asset valuation is inaccessible';end if;
 value_amount:=private.wealth_money(value_amount);
 if value_date is null or value_date not between coalesce(a.purchased_on,'1900-01-01') and private.finance_today(auth.uid()) or value_notes is null or length(value_notes)>2000 then raise exception 'Check asset valuation date and notes';end if;
 if r.id is null then insert into public.wealth_asset_values(id,workspace_id,owner_id,asset_id,currency,amount,valued_on,notes)values(entry,w,auth.uid(),asset,a.currency,value_amount,value_date,value_notes);
 else update public.wealth_asset_values set currency=a.currency,amount=value_amount,valued_on=value_date,notes=value_notes,revision=revision+1 where id=entry;end if;return entry;
end $$;
create function private.wealth_totals(person uuid,w uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with excluded as(select source_kind,source_id from public.wealth_exclusions where workspace_id=w and owner_id=person and excluded),
 balances as(select a.currency,a.opening_balance+coalesce((select sum(case when t.kind in('income','transfer_in')then t.amount else -t.amount end)from public.transactions t where t.account_id=a.id and t.owner_id=person and t.workspace_id=w and t.booked_on<=private.finance_today(person)),0) value from public.accounts a where a.workspace_id=w and a.owner_id=person and not exists(select 1 from excluded e where e.source_kind='account' and e.source_id=a.id)),
 sources as(
 select currency,greatest(value,0)account_assets,greatest(-value,0)account_debt,0::numeric investments,0::numeric physical_assets,0::numeric lent_principal,0::numeric borrowed_principal from balances
 union all select currency,0,0,current_value,0,0,0 from public.investment_holdings h where h.workspace_id=w and h.owner_id=person and not exists(select 1 from excluded e where e.source_kind='holding' and e.source_id=h.id)
 union all select a.currency,0,0,0,coalesce(v.amount,a.purchase_price,0),0,0 from public.assets a left join public.wealth_asset_values v on v.asset_id=a.id and v.owner_id=person and v.workspace_id=w and v.currency=a.currency where a.workspace_id=w and a.owner_id=person and a.status='active' and (a.purchased_on is null or a.purchased_on<=private.finance_today(person)) and not exists(select 1 from excluded e where e.source_kind='asset' and e.source_id=a.id)
 union all select currency,0,0,0,0,case when direction='lent' then greatest(0,principal-principal_paid) else 0 end,case when direction='borrowed' then greatest(0,principal-principal_paid) else 0 end from public.loans l where l.workspace_id=w and l.owner_id=person and not exists(select 1 from excluded e where e.source_kind='loan' and e.source_id=l.id)),
 grouped as(select currency,sum(account_assets)account_assets,sum(account_debt)account_debt,sum(investments)investments,sum(physical_assets)physical_assets,sum(lent_principal)lent_principal,sum(borrowed_principal)borrowed_principal from sources group by currency),
 totals as(select *,account_assets+investments+physical_assets+lent_principal assets_total,account_debt+borrowed_principal liabilities_total,account_assets+investments+physical_assets+lent_principal-account_debt-borrowed_principal net from grouped)
 select coalesce(jsonb_agg(to_jsonb(t)order by currency),'[]'::jsonb)from totals t;
$$;
create function public.capture_wealth_snapshot(entry uuid,w uuid,snapshot_label text) returns uuid language plpgsql security definer set search_path='' as $$
declare r public.wealth_snapshots;totals jsonb;begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,33));select * into r from public.wealth_snapshots where id=entry;
 if found then if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Snapshot is inaccessible';end if;return entry;end if;
 if snapshot_label is null or length(trim(snapshot_label)) not between 1 and 200 then raise exception 'Enter a snapshot label';end if;
 totals:=private.wealth_totals(auth.uid(),w);
 if exists(select 1 from jsonb_array_elements(totals)g cross join lateral jsonb_each(g)kv where kv.key<>'currency' and abs((kv.value#>>'{}')::numeric)*100>9007199254740991) then raise exception 'Wealth totals exceed the supported precision';end if;
 insert into public.wealth_snapshots(id,workspace_id,owner_id,label,captured_on,totals)values(entry,w,auth.uid(),trim(snapshot_label),private.finance_today(auth.uid()),totals);return entry;
end $$;
revoke all on function private.wealth_money(numeric),private.holding_parent(uuid,uuid),private.wealth_totals(uuid,uuid) from public,anon,authenticated;
revoke all on function public.save_investment_holding(uuid,uuid,integer,jsonb),public.append_investment_entry(uuid,uuid,uuid,integer,text,numeric,numeric,date,uuid,text),public.undo_investment_entry(uuid,integer),public.archive_investment_holding(uuid,integer,boolean),public.set_wealth_exclusion(uuid,uuid,integer,text,uuid,boolean),public.save_wealth_asset_value(uuid,uuid,integer,uuid,numeric,date,text),public.capture_wealth_snapshot(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.save_investment_holding(uuid,uuid,integer,jsonb),public.append_investment_entry(uuid,uuid,uuid,integer,text,numeric,numeric,date,uuid,text),public.undo_investment_entry(uuid,integer),public.archive_investment_holding(uuid,integer,boolean),public.set_wealth_exclusion(uuid,uuid,integer,text,uuid,boolean),public.save_wealth_asset_value(uuid,uuid,integer,uuid,numeric,date,text),public.capture_wealth_snapshot(uuid,uuid,text) to authenticated;
