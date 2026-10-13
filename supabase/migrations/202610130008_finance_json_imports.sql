-- Additive finance imports. Source identities are mappings, never permission grants.
create table public.finance_json_batches(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
 payload jsonb not null,result jsonb not null,created_at timestamptz not null default now()
);
create table public.finance_json_links(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
 source_kind text not null check(source_kind in('account','transaction')),source_id text not null check(length(trim(source_id)) between 1 and 200),
 account_id uuid not null,transaction_id uuid references public.transactions(id),details jsonb not null,created_at timestamptz not null default now(),
 foreign key(workspace_id,account_id) references public.accounts(workspace_id,id),unique(workspace_id,owner_id,source_kind,source_id),check((source_kind='transaction')=(transaction_id is not null))
);
do $$ declare t text;begin foreach t in array array['finance_json_batches','finance_json_links'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('create policy own_json_import_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
 execute format('create index on public.%I(workspace_id,owner_id,created_at,id)',t);
 end loop;end $$;
create function public.import_finance_json(entry uuid,w uuid,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.finance_json_batches;l public.finance_json_links;a public.accounts;m jsonb;r jsonb;tx public.transactions;
 targets jsonb:='{}';source text;target uuid;balance numeric;signature jsonb;part jsonb;answer jsonb;
 created integer:=0;reused integer:=0;added integer:=0;skipped integer:=0;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,36));
 select * into b from public.finance_json_batches where id=entry;
 if found then
  if b.workspace_id is distinct from w or b.owner_id is distinct from auth.uid() or b.payload is distinct from payload then raise exception 'JSON import request reused';end if;return b.result;
 end if;
 -- Serialize source binding creation; all existing destination locks are taken in UUID order.
 perform pg_advisory_xact_lock(hashtextextended(w::text||auth.uid()::text,35));
 if payload is null or jsonb_typeof(payload)<>'object' or (select count(*)from jsonb_object_keys(payload))<>2 or not payload ?& array['accounts','transactions'] then raise exception 'Invalid JSON import payload';end if;
 if jsonb_typeof(payload->'accounts')<>'array' or jsonb_typeof(payload->'transactions')<>'array' then raise exception 'Invalid import arrays';end if;
 if jsonb_array_length(payload->'accounts') not between 1 and 50 or jsonb_array_length(payload->'transactions')>500 or octet_length(payload::text)>5242880 then raise exception 'Import 1 to 50 accounts and up to 500 transactions, below 5 MiB';end if;
 if (select count(distinct value->>'source_id')from jsonb_array_elements(payload->'accounts'))<>jsonb_array_length(payload->'accounts') or (select count(distinct value->>'source_id')from jsonb_array_elements(payload->'transactions'))<>jsonb_array_length(payload->'transactions') then raise exception 'Source IDs must be unique';end if;
 perform 1 from public.accounts where id in(select nullif(value->>'target_id','')::uuid from jsonb_array_elements(payload->'accounts')) order by id for update;
 for m in select value from jsonb_array_elements(payload->'accounts') loop
  if jsonb_typeof(m)<>'object' or (select count(*)from jsonb_object_keys(m))<>6 or not m ?& array['source_id','name','currency','opening_balance','card_source','target_id'] then raise exception 'Invalid account mapping columns';end if;
  if exists(select 1 from jsonb_each(m) where key in('source_id','name','currency','opening_balance') and jsonb_typeof(value)<>'string') or jsonb_typeof(m->'card_source')<>'boolean' or jsonb_typeof(m->'target_id') not in('string','null') then raise exception 'Invalid account mapping types';end if;
  source:=m->>'source_id';target:=(m->>'target_id')::uuid;
  if length(trim(source)) not between 1 and 200 or source<>trim(source) or length(trim(m->>'name')) not between 1 and 100 or m->>'currency' !~ '^[A-Z]{3}$' or m->>'opening_balance' !~ '^-?\d{1,12}(\.\d{1,2})?$' then raise exception 'Check source ID, account name, currency and opening balance';end if;
  balance:=(m->>'opening_balance')::numeric;if abs(balance)>=1000000000000 or balance<>round(balance,2) then raise exception 'Invalid opening balance';end if;
  select * into l from public.finance_json_links where workspace_id=w and owner_id=auth.uid() and source_kind='account' and source_id=source;
  if found and (target is null or l.account_id<>target) then raise exception 'Source account already has a saved destination';end if;
  if target is null then
   if (m->>'card_source')::boolean then raise exception 'Map exported cards to existing credit cards';end if;
   insert into public.accounts(workspace_id,owner_id,name,currency,opening_balance)values(w,auth.uid(),trim(m->>'name'),m->>'currency',balance)returning * into a;
   target:=a.id;created:=created+1;
  else
   select * into a from public.accounts where id=target;
   if a.id is null or a.workspace_id is distinct from w or a.owner_id is distinct from auth.uid() or a.currency is distinct from m->>'currency' then raise exception 'Choose your own same-currency account';end if;
   if exists(select 1 from public.credit_cards where account_id=target and archived) then raise exception 'Restore archived card before importing';end if;
   if (m->>'card_source')::boolean and not exists(select 1 from public.credit_cards where account_id=target and not archived) then raise exception 'Map exported cards to existing credit cards';end if;
   reused:=reused+1;
  end if;
  targets:=targets||jsonb_build_object(source,target);
  if l.id is null then insert into public.finance_json_links(workspace_id,owner_id,source_kind,source_id,account_id,details)values(w,auth.uid(),'account',source,target,jsonb_build_object('currency',a.currency));end if;
 end loop;
 for m in select value from jsonb_array_elements(payload->'transactions') loop
  if jsonb_typeof(m)<>'object' or (select count(*)from jsonb_object_keys(m))<>3 or not m ?& array['source_id','account_source','row'] or jsonb_typeof(m->'source_id')<>'string' or jsonb_typeof(m->'account_source')<>'string' or jsonb_typeof(m->'row')<>'object' then raise exception 'Invalid transaction columns';end if;
  source:=m->>'source_id';target:=(targets->>(m->>'account_source'))::uuid;r:=m->'row';
  if length(trim(source)) not between 1 and 200 or source<>trim(source) or target is null then raise exception 'Missing transaction source ID or mapped account';end if;
  -- Validate via the existing atomic CSV boundary, even for already-linked source IDs.
  part:=public.import_finance_csv(gen_random_uuid(),w,target,jsonb_build_array(r));
  r:=jsonb_build_object('date',(r->>'date')::date::text,'title',trim(r->>'title'),'kind',r->>'kind','amount',((r->>'amount')::numeric(14,2))::text,'currency',r->>'currency','category',trim(r->>'category'),'reference',trim(r->>'reference'));
  signature:=jsonb_build_object('account_source',m->>'account_source','row',r);
  select * into l from public.finance_json_links where workspace_id=w and owner_id=auth.uid() and source_kind='transaction' and source_id=source;
  if found then
   if l.account_id<>target or l.details<>signature then raise exception 'Transaction source ID contents changed';end if;
   skipped:=skipped+1;continue;
  end if;
  if source ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
   select * into tx from public.transactions where id=source::uuid and workspace_id=w and owner_id=auth.uid();
   if found and (tx.account_id<>target or tx.booked_on<>(r->>'date')::date or trim(tx.title)<>trim(r->>'title') or tx.kind<>r->>'kind' or tx.amount<>(r->>'amount')::numeric or trim(tx.category)<>trim(r->>'category')) then raise exception 'Existing transaction source ID contents changed';end if;
  end if;
  select * into tx from public.transactions where workspace_id=w and owner_id=auth.uid() and account_id=target and booked_on=(r->>'date')::date and trim(title)=trim(r->>'title') and kind=r->>'kind' and amount=(r->>'amount')::numeric and trim(category)=trim(r->>'category') order by created_at,id limit 1;
  if tx.id is null then raise exception 'Imported transaction unavailable';end if;
  insert into public.finance_json_links(workspace_id,owner_id,source_kind,source_id,account_id,transaction_id,details)values(w,auth.uid(),'transaction',source,target,tx.id,signature);
  added:=added+(part->>'imported')::integer;skipped:=skipped+(part->>'skipped')::integer;
 end loop;
 answer:=jsonb_build_object('accounts_created',created,'accounts_reused',reused,'imported',added,'skipped',skipped);
 insert into public.finance_json_batches(id,workspace_id,owner_id,payload,result)values(entry,w,auth.uid(),payload,answer);
 return answer;
end $$;
revoke all on function public.import_finance_json(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_finance_json(uuid,uuid,jsonb) to authenticated;
