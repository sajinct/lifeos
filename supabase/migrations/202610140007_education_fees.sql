-- Education histories inherit the student's current sharing. Finance links stay owner-private.
create table public.education_students (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),visibility public.record_visibility not null default 'private',
 member_id uuid,name text not null check(length(trim(name)) between 1 and 200),institution text not null check(length(trim(institution)) between 1 and 200),class_name text not null check(length(trim(class_name)) between 1 and 100),academic_year text not null check(length(trim(academic_year)) between 1 and 60),notes text not null default '' check(length(notes)<=2000),
 archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),foreign key(workspace_id,member_id) references public.household_members(workspace_id,id)
);
create table public.education_fees (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),student_id uuid not null,title text not null check(length(trim(title)) between 1 and 200),due_on date not null check(due_on between '1900-01-01' and '2100-12-31'),amount numeric(12,2) not null check(amount>0 and amount<=1000000000),currency text not null check(currency~'^[A-Z]{3}$'),notes text not null default '' check(length(notes)<=2000),
 archived boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),foreign key(workspace_id,student_id) references public.education_students(workspace_id,id) on delete cascade
);
create table public.education_payments (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),fee_id uuid not null,amount numeric(12,2) not null check(amount>0 and amount<=1000000000),paid_on date not null check(paid_on between '1900-01-01' and '2100-12-31'),reference text not null default '' check(length(reference)<=120),notes text not null default '' check(length(notes)<=2000),voided boolean not null default false,revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id),foreign key(workspace_id,fee_id) references public.education_fees(workspace_id,id) on delete cascade
);
create table public.education_payment_links (
 id uuid primary key references public.education_payments(id) on delete cascade,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),transaction_id uuid unique references public.transactions(id) on delete set null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(workspace_id,id) references public.education_payments(workspace_id,id)
);
do $$ declare t text;begin
 foreach t in array array['education_students','education_fees','education_payments','education_payment_links'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create index on public.%I(workspace_id,created_at,id)',t);
  execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
 end loop;
end $$;
create index on public.education_fees(student_id);
create index on public.education_payments(fee_id);
create index on public.education_students(member_id);
create policy education_student_read on public.education_students for select to authenticated using(private.can_read(workspace_id,owner_id,visibility));
create policy education_fee_read on public.education_fees for select to authenticated using(exists(select 1 from public.education_students s where s.id=student_id and s.workspace_id=education_fees.workspace_id and private.can_read(s.workspace_id,s.owner_id,s.visibility)));
create policy education_payment_read on public.education_payments for select to authenticated using(exists(select 1 from public.education_fees f join public.education_students s on s.id=f.student_id and s.workspace_id=f.workspace_id where f.id=fee_id and f.workspace_id=education_payments.workspace_id and private.can_read(s.workspace_id,s.owner_id,s.visibility)));
create policy education_link_read on public.education_payment_links for select to authenticated using(owner_id=auth.uid() and exists(select 1 from public.education_payments p join public.education_fees f on f.id=p.fee_id and f.workspace_id=p.workspace_id join public.education_students s on s.id=f.student_id and s.workspace_id=f.workspace_id where p.id=education_payment_links.id and p.workspace_id=education_payment_links.workspace_id and private.can_read(s.workspace_id,s.owner_id,s.visibility)));
create table private.education_requests(id uuid primary key,workspace_id uuid not null references public.workspaces(id),owner_id uuid not null references public.profiles(id),payload jsonb not null);
revoke all on private.education_requests from public,anon,authenticated,service_role;
create function private.education_replayed(request uuid,w uuid,payload jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare r private.education_requests;begin
 if request is null then raise exception 'Request ID required';end if;
 select * into r from private.education_requests where id=request;
 if not found then return false;end if;
 if r.workspace_id is distinct from w or r.owner_id is distinct from auth.uid() or r.payload is distinct from payload then raise exception 'Request was already used for another change';end if;return true;
end $$;
create function private.education_parent(entry uuid) returns public.education_students language plpgsql security definer set search_path='' as $$
declare s public.education_students;begin
 select * into s from public.education_students where id=entry;
 if s.id is null or auth.uid() is null or not private.can_edit(s.workspace_id,s.owner_id,s.visibility) then raise exception 'Student is inaccessible';end if;
 -- Same lock as household member edits, so member sharing cannot race a student publication.
 perform pg_advisory_xact_lock(hashtextextended(s.workspace_id::text,7));
 select * into s from public.education_students where id=entry for update;
 if s.id is null or not private.can_edit(s.workspace_id,s.owner_id,s.visibility) then raise exception 'Student is inaccessible';end if;return s;
end $$;
create function private.guard_education_member_sharing() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if new.visibility='private' and exists(select 1 from public.education_students s where s.member_id=old.id and s.visibility='workspace') then raise exception 'Unlink or make linked education records private before making this household member private';end if;return new;
end $$;
create trigger guard_education_member_sharing before update of visibility on public.household_members for each row execute function private.guard_education_member_sharing();
create function public.save_education_student(request uuid,entry uuid,w uuid,expected_revision integer,student_name text,school text,school_class text,school_year text,student_notes text,household_member uuid,sharing public.record_visibility) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.education_students;m public.household_members;payload jsonb;begin
 if entry is null or auth.uid() is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
 perform pg_advisory_xact_lock(hashtextextended(w::text,7));
 if not private.can_write(w) then raise exception 'Workspace write access required';end if;
 select * into s from public.education_students where id=entry for update;
 if s.id is not null and (s.workspace_id<>w or not private.can_edit(w,s.owner_id,s.visibility)) then raise exception 'Student is inaccessible';end if;
 payload:=jsonb_build_array('student',entry,expected_revision,student_name,school,school_class,school_year,student_notes,household_member,sharing);
 if private.education_replayed(request,w,payload) then return entry;end if;
 if s.id is null and expected_revision is not null then raise exception 'Student is inaccessible';end if;
 if s.id is not null then
  if expected_revision is null or expected_revision<>s.revision then raise exception 'Student changed; refresh and try again';end if;
  if s.archived then raise exception 'Restore the student before editing';end if;
  if s.owner_id<>auth.uid() and (sharing is distinct from s.visibility or household_member is distinct from s.member_id) then raise exception 'Only the student creator changes sharing or household links';end if;
 end if;
 if student_name is null or length(trim(student_name)) not between 1 and 200 or school is null or length(trim(school)) not between 1 and 200 or school_class is null or length(trim(school_class)) not between 1 and 100 or school_year is null or length(trim(school_year)) not between 1 and 60 or student_notes is null or length(student_notes)>2000 or sharing is null then raise exception 'Enter valid student details';end if;
 if household_member is not null then
  select * into m from public.household_members where id=household_member and workspace_id=w for update;
  if m.id is null or not private.can_read(w,m.owner_id,m.visibility) or (m.status<>'active' and (s.id is null or s.member_id is distinct from household_member)) or (sharing='workspace' and m.visibility<>'workspace') then raise exception 'Choose an accessible household member with matching sharing';end if;
 end if;
 if s.id is null then insert into public.education_students(id,workspace_id,owner_id,visibility,member_id,name,institution,class_name,academic_year,notes) values(entry,w,auth.uid(),sharing,household_member,trim(student_name),trim(school),trim(school_class),trim(school_year),student_notes);
 else update public.education_students set visibility=sharing,member_id=household_member,name=trim(student_name),institution=trim(school),class_name=trim(school_class),academic_year=trim(school_year),notes=student_notes,revision=revision+1 where id=entry;end if;
 insert into private.education_requests values(request,w,auth.uid(),payload);return entry;
end $$;
create function public.save_education_fee(request uuid,entry uuid,parent uuid,expected_revision integer,expected_parent_revision integer,fee_title text,deadline date,fee_amount numeric,fee_currency text,fee_notes text) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.education_students;f public.education_fees;payload jsonb;paid numeric;begin
 s:=private.education_parent(parent);
 payload:=jsonb_build_array('fee',entry,parent,expected_revision,expected_parent_revision,fee_title,deadline,fee_amount,fee_currency,fee_notes);
 if private.education_replayed(request,s.workspace_id,payload) then return entry;end if;
 if s.archived then raise exception 'Restore the student before changing fees';end if;
 if expected_parent_revision is null or s.revision<>expected_parent_revision then raise exception 'Student changed; refresh and try again';end if;
 select * into f from public.education_fees where id=entry for update;
 if f.id is not null then
  if f.student_id<>parent or f.workspace_id<>s.workspace_id then raise exception 'Fee is inaccessible';end if;
  if expected_revision is null or expected_revision<>f.revision then raise exception 'Fee changed; refresh and try again';end if;
  if f.archived then raise exception 'Restore the fee before editing';end if;
  if fee_currency is distinct from f.currency and exists(select 1 from public.education_payments where fee_id=entry) then raise exception 'Currency cannot change after payment history exists';end if;
 elsif expected_revision is not null then raise exception 'Fee is inaccessible';end if;
 if entry is null or fee_title is null or length(trim(fee_title)) not between 1 and 200 or deadline is null or deadline not between '1900-01-01' and '2100-12-31' or fee_amount is null or fee_amount<=0 or fee_amount>1000000000 or fee_amount<>round(fee_amount,2) or fee_currency is null or fee_currency!~'^[A-Z]{3}$' or fee_notes is null or length(fee_notes)>2000 then raise exception 'Enter valid fee details and a positive amount with two decimals';end if;
 select coalesce(sum(amount),0) into paid from public.education_payments where fee_id=entry and not voided;
 if fee_amount<paid then raise exception 'Fee amount cannot be below recorded payments';end if;
 if f.id is null then
  if (select count(*) from public.education_fees where student_id=parent)>=200 then raise exception 'A student supports up to 200 fees including archives';end if;
  insert into public.education_fees(id,workspace_id,owner_id,student_id,title,due_on,amount,currency,notes)values(entry,s.workspace_id,s.owner_id,parent,trim(fee_title),deadline,fee_amount,fee_currency,fee_notes);
 else update public.education_fees set title=trim(fee_title),due_on=deadline,amount=fee_amount,currency=fee_currency,notes=fee_notes,revision=revision+1 where id=entry;end if;
 update public.education_students set revision=revision+1 where id=parent;insert into private.education_requests values(request,s.workspace_id,auth.uid(),payload);return entry;
end $$;
create function public.record_education_payment(request uuid,entry uuid,parent uuid,expected_fee_revision integer,expected_student_revision integer,payment_amount numeric,payment_date date,payment_reference text,payment_notes text,expense uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.education_students;f public.education_fees;t public.transactions;account_currency text;payload jsonb;paid numeric;begin
 select * into f from public.education_fees where id=parent;
 if f.id is null then raise exception 'Fee is inaccessible';end if;
 s:=private.education_parent(f.student_id);select * into f from public.education_fees where id=parent for update;
 payload:=jsonb_build_array('payment',entry,parent,expected_fee_revision,expected_student_revision,payment_amount,payment_date,payment_reference,payment_notes,expense);
 if private.education_replayed(request,s.workspace_id,payload) then return entry;end if;
 if s.archived or f.archived then raise exception 'Restore the student and fee before recording payments';end if;
 if expected_student_revision is null or expected_student_revision<>s.revision then raise exception 'Student changed; refresh and try again';end if;
 if expected_fee_revision is null or expected_fee_revision<>f.revision then raise exception 'Fee changed; refresh and try again';end if;
 if entry is null or exists(select 1 from public.education_payments where id=entry) then raise exception 'Payment ID is already used or invalid';end if;
 if payment_amount is null or payment_amount<=0 or payment_amount>1000000000 or payment_amount<>round(payment_amount,2) or payment_date is null or payment_date not between '1900-01-01' and '2100-12-31' or payment_date>private.finance_today(auth.uid()) or payment_reference is null or length(payment_reference)>120 or payment_notes is null or length(payment_notes)>2000 then raise exception 'Enter valid payment details, a past or current date and a positive amount with two decimals';end if;
 select coalesce(sum(amount),0) into paid from public.education_payments where fee_id=parent and not voided;
 if paid+payment_amount>f.amount then raise exception 'Payment exceeds the outstanding fee';end if;
 if (select count(*) from public.education_payments where fee_id=parent)>=200 then raise exception 'A fee supports up to 200 payments including voided history';end if;
 if expense is not null then
  select * into t from public.transactions where id=expense and workspace_id=s.workspace_id and owner_id=auth.uid() for share;
  select currency into account_currency from public.accounts where id=t.account_id and owner_id=auth.uid() and workspace_id=s.workspace_id for share;
  if t.id is null or account_currency is null or t.kind<>'expense' or t.amount<>payment_amount or t.booked_on<>payment_date or account_currency<>f.currency then raise exception 'Choose your own expense with matching amount, currency and payment date';end if;
  if exists(select 1 from public.education_payment_links where transaction_id=expense) then raise exception 'Expense is already linked to a school payment';end if;
 end if;
 insert into public.education_payments(id,workspace_id,owner_id,fee_id,amount,paid_on,reference,notes)values(entry,s.workspace_id,auth.uid(),parent,payment_amount,payment_date,payment_reference,payment_notes);
 if expense is not null then insert into public.education_payment_links(id,workspace_id,owner_id,transaction_id)values(entry,s.workspace_id,auth.uid(),expense);end if;
 update public.education_fees set revision=revision+1 where id=parent;update public.education_students set revision=revision+1 where id=s.id;insert into private.education_requests values(request,s.workspace_id,auth.uid(),payload);return entry;
end $$;
create function public.set_education_archive(request uuid,entry uuid,record_kind text,expected_revision integer,expected_student_revision integer,is_archived boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.education_students;f public.education_fees;payload jsonb;begin
 if record_kind='student' then s:=private.education_parent(entry);
 elsif record_kind='fee' then select * into f from public.education_fees where id=entry;if f.id is null then raise exception 'Fee is inaccessible';end if;s:=private.education_parent(f.student_id);select * into f from public.education_fees where id=entry for update;
 else raise exception 'Choose student or fee';end if;
 payload:=jsonb_build_array('archive',entry,record_kind,expected_revision,expected_student_revision,is_archived);
 if private.education_replayed(request,s.workspace_id,payload) then return;end if;
 if is_archived is null then raise exception 'Choose archive or restore';end if;
 if expected_student_revision is null or expected_student_revision<>s.revision then raise exception 'Student changed; refresh and try again';end if;
 if record_kind='student' then
  if expected_revision is null or expected_revision<>s.revision then raise exception 'Student changed; refresh and try again';end if;
  update public.education_students set archived=is_archived,revision=revision+1 where id=entry;
 else
  if s.archived then raise exception 'Restore the student before changing fees';end if;
  if expected_revision is null or expected_revision<>f.revision then raise exception 'Fee changed; refresh and try again';end if;
  update public.education_fees set archived=is_archived,revision=revision+1 where id=entry;update public.education_students set revision=revision+1 where id=s.id;
 end if;
 insert into private.education_requests values(request,s.workspace_id,auth.uid(),payload);
end $$;
create function public.set_education_payment_void(request uuid,entry uuid,expected_revision integer,expected_fee_revision integer,expected_student_revision integer,is_voided boolean) returns void language plpgsql security definer set search_path='' as $$
declare s public.education_students;f public.education_fees;p public.education_payments;payload jsonb;paid numeric;begin
 select * into p from public.education_payments where id=entry;
 if p.id is null then raise exception 'Payment is inaccessible';end if;select * into f from public.education_fees where id=p.fee_id;s:=private.education_parent(f.student_id);
 select * into f from public.education_fees where id=p.fee_id for update;select * into p from public.education_payments where id=entry for update;
 payload:=jsonb_build_array('void',entry,expected_revision,expected_fee_revision,expected_student_revision,is_voided);
 if private.education_replayed(request,s.workspace_id,payload) then return;end if;
 if s.archived or f.archived then raise exception 'Restore the student and fee before correcting payments';end if;
 if expected_student_revision is null or expected_student_revision<>s.revision then raise exception 'Student changed; refresh and try again';end if;
 if expected_fee_revision is null or expected_fee_revision<>f.revision then raise exception 'Fee changed; refresh and try again';end if;
 if expected_revision is null or expected_revision<>p.revision then raise exception 'Payment changed; refresh and try again';end if;
 if is_voided is null then raise exception 'Choose void or restore';end if;
 select coalesce(sum(amount),0) into paid from public.education_payments where fee_id=p.fee_id and id<>entry and not voided;
 if not is_voided and paid+p.amount>f.amount then raise exception 'Restored payment exceeds the outstanding fee';end if;
 update public.education_payments set voided=is_voided,revision=revision+1 where id=entry;update public.education_fees set revision=revision+1 where id=f.id;update public.education_students set revision=revision+1 where id=s.id;
 insert into private.education_requests values(request,s.workspace_id,auth.uid(),payload);
end $$;
revoke all on function private.education_replayed(uuid,uuid,jsonb),private.education_parent(uuid),private.guard_education_member_sharing() from public,anon,authenticated,service_role;
revoke all on function public.save_education_student(uuid,uuid,uuid,integer,text,text,text,text,text,uuid,public.record_visibility),public.save_education_fee(uuid,uuid,uuid,integer,integer,text,date,numeric,text,text),public.record_education_payment(uuid,uuid,uuid,integer,integer,numeric,date,text,text,uuid),public.set_education_archive(uuid,uuid,text,integer,integer,boolean),public.set_education_payment_void(uuid,uuid,integer,integer,integer,boolean) from public,anon;
grant execute on function public.save_education_student(uuid,uuid,uuid,integer,text,text,text,text,text,uuid,public.record_visibility),public.save_education_fee(uuid,uuid,uuid,integer,integer,text,date,numeric,text,text),public.record_education_payment(uuid,uuid,uuid,integer,integer,numeric,date,text,text,uuid),public.set_education_archive(uuid,uuid,text,integer,integer,boolean),public.set_education_payment_void(uuid,uuid,integer,integer,integer,boolean) to authenticated;
