create table public.asset_insurance(
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
 visibility public.record_visibility not null default 'private' check(visibility='private'),asset_id uuid not null,
 title text not null check(length(trim(title)) between 1 and 200),provider text not null check(length(trim(provider)) between 1 and 200),policy_number text not null default '' check(length(policy_number)<=200),
 starts_on date not null check(starts_on between '1900-01-01' and '2100-12-31'),ends_on date not null check(ends_on between '1900-01-01' and '2100-12-31' and ends_on>=starts_on),
 coverage_amount numeric(14,2) check(coverage_amount>0 and coverage_amount<1000000000000),premium_amount numeric(14,2) check(premium_amount>=0 and premium_amount<1000000000000),
 currency text not null check(currency~'^[A-Z]{3}$'),premium_frequency text not null check(premium_frequency in('once','monthly','quarterly','yearly')),notes text not null default '' check(length(notes)<=4000),
 cancelled boolean not null default false,archived boolean not null default false,revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),
 foreign key(workspace_id,asset_id) references public.assets(workspace_id,id) on delete cascade
);
create table public.asset_insurance_documents(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private' check(visibility='private'),
 insurance_id uuid not null,attachment_id uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(workspace_id,insurance_id) references public.asset_insurance(workspace_id,id) on delete cascade,
 foreign key(workspace_id,attachment_id) references public.attachments(workspace_id,id) on delete cascade,unique(insurance_id,attachment_id)
);
create index on public.asset_insurance(workspace_id,created_at,id);
create index on public.asset_insurance(asset_id,ends_on);
create index on public.asset_insurance_documents(workspace_id,created_at,id);
create trigger touch_updated_at before update on public.asset_insurance for each row execute function private.touch_updated_at();
alter table public.asset_insurance enable row level security;
alter table public.asset_insurance_documents enable row level security;
create policy own_insurance_read on public.asset_insurance for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id));
create policy own_insurance_document_read on public.asset_insurance_documents for select to authenticated using(owner_id=auth.uid() and private.is_member(workspace_id));
revoke all on public.asset_insurance,public.asset_insurance_documents from public,anon,authenticated;
grant select on public.asset_insurance,public.asset_insurance_documents to authenticated;
create table private.asset_insurance_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),payload jsonb not null);
revoke all on private.asset_insurance_requests from public,anon,authenticated,service_role;
create function private.insurance_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.asset_insurance_requests;begin
 select * into r from private.asset_insurance_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id<>w or r.owner_id<>auth.uid() or r.payload is distinct from payload then raise exception 'Insurance request was already used for another change';end if;return true;
end $$;
create function public.save_asset_insurance(request uuid,entry uuid,w uuid,expected_revision integer,asset uuid,details jsonb,documents uuid[]) returns uuid language plpgsql security definer set search_path='' as $$
declare a public.assets;r public.asset_insurance;payload jsonb;f uuid;starts date;ends date;coverage numeric;premium numeric;begin
 if auth.uid() is null or request is null or entry is null or asset is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform 1 from public.workspace_members where workspace_id=w and user_id=auth.uid() for share;
 perform pg_advisory_xact_lock(hashtextextended(request::text,45));perform pg_advisory_xact_lock(hashtextextended(asset::text,8));
 select * into a from public.assets where id=asset and workspace_id=w for update;
 if a.id is null or a.owner_id<>auth.uid() or not private.can_write(w) then raise exception 'Choose your own asset in this workspace';end if;
 select * into r from public.asset_insurance where id=entry for update;
 if r.id is not null and (r.workspace_id<>w or r.owner_id<>auth.uid() or r.asset_id<>asset) then raise exception 'Insurance record is inaccessible or its asset changed';end if;
 payload:=jsonb_build_array('save',entry,w,expected_revision,asset,details,documents);
 if private.insurance_replayed(request,w,payload) then return entry;end if;
 if a.status<>'active' then raise exception 'Restore the asset before recording or editing insurance';end if;
 if r.id is null then
  if expected_revision is not null then raise exception 'Insurance record is inaccessible';end if;
  if (select count(*) from public.asset_insurance where asset_id=asset)>=200 then raise exception 'An asset supports up to 200 policy records, including archives';end if;
 else
  if expected_revision is null or expected_revision<>r.revision then raise exception 'Insurance changed; refresh and try again';end if;
  if r.archived or r.cancelled then raise exception 'Restore or reopen the policy record before editing';end if;
 end if;
 if details is null or jsonb_typeof(details)<>'object' or (select count(*) from jsonb_object_keys(details))<>10 or not details ?& array['title','provider','policy_number','starts_on','ends_on','coverage_amount','premium_amount','currency','premium_frequency','notes'] then raise exception 'Invalid insurance fields';end if;
 if exists(select 1 from jsonb_each(details) where (key in('coverage_amount','premium_amount') and jsonb_typeof(value) not in('number','null')) or (key not in('coverage_amount','premium_amount') and jsonb_typeof(value)<>'string')) then raise exception 'Invalid insurance field types';end if;
 if length(trim(details->>'title')) not between 1 and 200 or length(trim(details->>'provider')) not between 1 and 200 or length(details->>'policy_number')>200 or length(details->>'notes')>4000 or details->>'currency'!~'^[A-Z]{3}$' or details->>'premium_frequency' not in('once','monthly','quarterly','yearly') then raise exception 'Check policy title, provider, currency, premium frequency and details';end if;
 if details->>'starts_on'!~'^\d{4}-\d{2}-\d{2}$' or details->>'ends_on'!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Choose ISO policy dates';end if;
 starts:=(details->>'starts_on')::date;ends:=(details->>'ends_on')::date;
 if starts<'1900-01-01' or ends>'2100-12-31' or ends<starts then raise exception 'Policy dates must be ordered within 1900–2100';end if;
 coverage:=(details->>'coverage_amount')::numeric;premium:=(details->>'premium_amount')::numeric;
 if (coverage is not null and (coverage<=0 or coverage>=1000000000000 or coverage<>round(coverage,2))) or (premium is not null and (premium<0 or premium>=1000000000000 or premium<>round(premium,2))) then raise exception 'Check coverage and premium amounts with up to two decimals';end if;
 if documents is null or cardinality(documents)>50 or array_position(documents,null) is not null then raise exception 'Link up to 50 owned completed documents';end if;
 for f in select distinct unnest(documents) order by 1 loop
  perform 1 from public.attachments where id=f and workspace_id=w and owner_id=auth.uid() and status in('ready','archived') for share;
  if not found then raise exception 'Choose your own completed document version in this workspace';end if;
 end loop;
 if r.id is null then
  insert into public.asset_insurance(id,workspace_id,owner_id,asset_id,title,provider,policy_number,starts_on,ends_on,coverage_amount,premium_amount,currency,premium_frequency,notes)
  values(entry,w,auth.uid(),asset,trim(details->>'title'),trim(details->>'provider'),trim(details->>'policy_number'),starts,ends,coverage,premium,details->>'currency',details->>'premium_frequency',details->>'notes');
 else
  update public.asset_insurance set title=trim(details->>'title'),provider=trim(details->>'provider'),policy_number=trim(details->>'policy_number'),starts_on=starts,ends_on=ends,coverage_amount=coverage,premium_amount=premium,currency=details->>'currency',premium_frequency=details->>'premium_frequency',notes=details->>'notes',revision=revision+1 where id=entry;
 end if;
 delete from public.asset_insurance_documents where insurance_id=entry;
 insert into public.asset_insurance_documents(workspace_id,owner_id,insurance_id,attachment_id) select w,auth.uid(),entry,unnest(documents) on conflict(insurance_id,attachment_id) do nothing;
 insert into private.asset_insurance_requests values(request,w,auth.uid(),payload);return entry;
end $$;
create function public.set_asset_insurance_state(request uuid,entry uuid,expected_revision integer,is_cancelled boolean,is_archived boolean) returns void language plpgsql security definer set search_path='' as $$
declare r public.asset_insurance;a public.assets;payload jsonb;begin
 select * into r from public.asset_insurance where id=entry;
 if r.id is null or auth.uid() is null or request is null or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Insurance owner with write access required';end if;
 perform 1 from public.workspace_members where workspace_id=r.workspace_id and user_id=auth.uid() for share;
 perform pg_advisory_xact_lock(hashtextextended(request::text,45));perform pg_advisory_xact_lock(hashtextextended(r.asset_id::text,8));
 select * into a from public.assets where id=r.asset_id for update;
 select * into r from public.asset_insurance where id=entry for update;
 if r.id is null or a.owner_id<>auth.uid() or r.owner_id<>auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Insurance owner with write access required';end if;
 payload:=jsonb_build_array('state',entry,expected_revision,is_cancelled,is_archived);
 if private.insurance_replayed(request,r.workspace_id,payload) then return;end if;
 if expected_revision is null or expected_revision<>r.revision then raise exception 'Insurance changed; refresh and try again';end if;
 if is_cancelled is null or is_archived is null then raise exception 'Choose policy record states';end if;
 update public.asset_insurance set cancelled=is_cancelled,archived=is_archived,revision=revision+1 where id=entry;
 insert into private.asset_insurance_requests values(request,r.workspace_id,auth.uid(),payload);
end $$;
revoke all on function private.insurance_replayed(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.save_asset_insurance(uuid,uuid,uuid,integer,uuid,jsonb,uuid[]),public.set_asset_insurance_state(uuid,uuid,integer,boolean,boolean) from public,anon,authenticated;
grant execute on function public.save_asset_insurance(uuid,uuid,uuid,integer,uuid,jsonb,uuid[]),public.set_asset_insurance_state(uuid,uuid,integer,boolean,boolean) to authenticated;
