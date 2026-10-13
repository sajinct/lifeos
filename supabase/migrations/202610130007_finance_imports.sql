-- Private, atomic CSV batches. Only validated income/expense rows enter the ledger.
create table public.finance_import_batches (
 id uuid primary key, workspace_id uuid not null references public.workspaces(id) on delete cascade,
 owner_id uuid not null references public.profiles(id), account_id uuid not null,
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(),
 foreign key(workspace_id,account_id) references public.accounts(workspace_id,id)
);
alter table public.finance_import_batches enable row level security;
revoke all on public.finance_import_batches from public,anon,authenticated;
grant select on public.finance_import_batches to authenticated;
create policy own_import_read on public.finance_import_batches for select to authenticated
 using(owner_id=(select auth.uid()) and private.is_member(workspace_id));
create index on public.finance_import_batches(workspace_id,owner_id,created_at,id);
alter table public.transactions add column import_batch_id uuid references public.finance_import_batches(id),
 add column import_reference text check(length(import_reference) between 1 and 200);
create unique index transaction_import_reference on public.transactions(workspace_id,owner_id,account_id,import_reference) where import_reference is not null;
create index transaction_import_match on public.transactions(account_id,booked_on,kind,amount);

create function public.import_finance_csv(entry uuid,w uuid,account uuid,rows jsonb)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.finance_import_batches;a public.accounts;r jsonb;tx public.transactions;
 title_value text;category_value text;reference_value text;kind_value text;date_value date;amount_value numeric;
 added integer:=0;skipped integer:=0;answer jsonb;
begin
 if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(entry::text,34));
 select * into b from public.finance_import_batches where id=entry;
 if found then
  if b.owner_id is distinct from auth.uid() or b.workspace_id is distinct from w or b.account_id is distinct from account or b.payload is distinct from rows then raise exception 'Import request reused';end if;
  return b.result;
 end if;
 -- Account lock serializes overlapping imports and existing ledger writers.
 select * into a from public.accounts where id=account for update;
 if a.id is null or a.workspace_id is distinct from w or a.owner_id is distinct from auth.uid() then raise exception 'Choose your own account';end if;
 if exists(select 1 from public.credit_cards where account_id=account and archived) then raise exception 'Restore the archived card before importing';end if;
 if rows is null or jsonb_typeof(rows)<>'array' then raise exception 'Invalid import rows';end if;
 if jsonb_array_length(rows) not between 1 and 500 or octet_length(rows::text)>1048576 then raise exception 'Import 1 to 500 rows, below 1 MiB';end if;
 insert into public.finance_import_batches(id,workspace_id,owner_id,account_id,payload,result)values(entry,w,auth.uid(),account,rows,'{}');
 for r in select value from jsonb_array_elements(rows) loop
  if jsonb_typeof(r)<>'object' or (select count(*) from jsonb_object_keys(r))<>7 or not r ?& array['date','title','kind','amount','currency','category','reference']
    or exists(select 1 from jsonb_each(r) where jsonb_typeof(value)<>'string') then raise exception 'Invalid import columns';end if;
  title_value:=trim(r->>'title');category_value:=trim(r->>'category');reference_value:=nullif(trim(r->>'reference'),'');kind_value:=r->>'kind';
  if length(title_value) not between 1 and 200 or length(category_value) not between 1 and 100 or length(coalesce(reference_value,''))>200
    or kind_value not in('income','expense') or r->>'currency' is distinct from a.currency then raise exception 'Check title, category, type, reference and account currency';end if;
  if r->>'date' !~ '^\d{4}-\d{2}-\d{2}$' or r->>'amount' !~ '^\d{1,12}(\.\d{1,2})?$' then raise exception 'Check ISO date and decimal amount';end if;
  date_value:=(r->>'date')::date;amount_value:=(r->>'amount')::numeric;
  if date_value not between '1900-01-01' and private.finance_today(auth.uid()) or amount_value<=0 or amount_value>=1000000000000 or amount_value<>round(amount_value,2) then raise exception 'Check date and positive two-decimal amount';end if;
  if reference_value is not null then
   select * into tx from public.transactions where workspace_id=w and owner_id=auth.uid() and account_id=account and import_reference=reference_value;
   if found then
    if tx.booked_on<>date_value or trim(tx.title)<>title_value or tx.kind<>kind_value or tx.amount<>amount_value or trim(tx.category)<>category_value then raise exception 'Reference already identifies a different transaction';end if;
    skipped:=skipped+1;continue;
   end if;
  end if;
  if exists(select 1 from public.transactions where workspace_id=w and owner_id=auth.uid() and account_id=account and booked_on=date_value and trim(title)=title_value and kind=kind_value and amount=amount_value and trim(category)=category_value) then skipped:=skipped+1;continue;end if;
  insert into public.transactions(workspace_id,owner_id,account_id,title,kind,amount,category,booked_on,import_batch_id,import_reference)
   values(w,auth.uid(),account,title_value,kind_value,amount_value,category_value,date_value,entry,reference_value);
  added:=added+1;
 end loop;
 answer:=jsonb_build_object('imported',added,'skipped',skipped);
 update public.finance_import_batches set result=answer where id=entry;
 return answer;
end $$;
revoke all on function public.import_finance_csv(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_finance_csv(uuid,uuid,uuid,jsonb) to authenticated;
