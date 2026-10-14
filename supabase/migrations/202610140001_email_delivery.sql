-- Account-level opt-ins; every delivery remains owner/workspace private.
create table public.email_preferences(
 owner_id uuid primary key references public.profiles(id) on delete cascade,
 reminder_emails boolean not null default false,daily_digest boolean not null default false,weekly_digest boolean not null default false,
 finance_frequency text not null default 'off' check(finance_frequency in('off','weekly','monthly')),
 delivery_hour integer not null default 9 check(delivery_hour between 0 and 23),weekly_day integer not null default 1 check(weekly_day between 0 and 6),delivery_timezone text not null default 'UTC',
 reminder_since timestamptz,daily_since timestamptz,weekly_since timestamptz,finance_since timestamptz,revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table public.email_deliveries(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id) on delete cascade,
 kind text not null check(kind in('reminder','daily','weekly','financial')),period_key text not null,notification_id uuid references public.notifications(id) on delete set null,
 status text not null default 'queued' check(status in('queued','sending','accepted','failed','cancelled','uncertain')),
 attempts integer not null default 0,next_attempt_at timestamptz not null default now(),first_attempt_at timestamptz,last_attempt_at timestamptz,
 lease_id uuid,lease_until timestamptz,accepted_at timestamptz,provider_id text,error_code text,created_at timestamptz not null default now(),
 unique(workspace_id,owner_id,kind,period_key)
);
create index email_delivery_owner_history on public.email_deliveries(workspace_id,owner_id,created_at desc,id);
create index email_delivery_due on public.email_deliveries(next_attempt_at,created_at) where status in('queued','sending');
alter table public.email_preferences enable row level security;
alter table public.email_deliveries enable row level security;
revoke all on public.email_preferences,public.email_deliveries from public,anon,authenticated;
grant select on public.email_preferences to authenticated;
grant select(id,workspace_id,owner_id,kind,status,attempts,accepted_at,error_code,created_at) on public.email_deliveries to authenticated;
create policy own_email_preferences on public.email_preferences for select to authenticated using(owner_id=(select auth.uid()));
create policy own_email_history on public.email_deliveries for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id));
create table private.email_runtime(singleton boolean primary key default true check(singleton),ready boolean not null default false);
insert into private.email_runtime values(true,false);
create table private.email_payloads(delivery_id uuid primary key references public.email_deliveries(id) on delete cascade,payload jsonb not null);
revoke all on private.email_runtime,private.email_payloads from public,anon,authenticated,service_role;

create function public.email_delivery_available() returns boolean language sql stable security definer set search_path='' as $$select ready from private.email_runtime where singleton$$;
revoke all on function public.email_delivery_available() from public,anon,authenticated;
grant execute on function public.email_delivery_available() to authenticated;
create function public.set_email_delivery_ready(available boolean) returns void language sql security definer set search_path='' as $$update private.email_runtime set ready=available where singleton$$;
revoke all on function public.set_email_delivery_ready(boolean) from public,anon,authenticated;
grant execute on function public.set_email_delivery_ready(boolean) to service_role;

create function public.save_email_preferences(expected_revision integer,reminders_enabled boolean,daily_enabled boolean,weekly_enabled boolean,finance_schedule text,hour integer,weekday integer,timezone text)
returns public.email_preferences language plpgsql security definer set search_path='' as $$
declare p public.email_preferences;changed boolean;begin
 if auth.uid() is null then raise exception 'Sign in first';end if;
 if expected_revision is null or reminders_enabled is null or daily_enabled is null or weekly_enabled is null or finance_schedule is null or hour is null or weekday is null or timezone is null or finance_schedule not in('off','weekly','monthly') or hour not between 0 and 23 or weekday not between 0 and 6 or not exists(select 1 from pg_catalog.pg_timezone_names where name=timezone) then raise exception 'Check email schedule and timezone';end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,41));select * into p from public.email_preferences where owner_id=auth.uid() for update;
 if ((reminders_enabled and not coalesce(p.reminder_emails,false)) or (daily_enabled and not coalesce(p.daily_digest,false)) or (weekly_enabled and not coalesce(p.weekly_digest,false)) or (finance_schedule<>'off' and finance_schedule is distinct from coalesce(p.finance_frequency,'off'))) and (not (select ready from private.email_runtime where singleton) or not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null and email is not null and email<>'')) then raise exception 'Verified email and configured sender required';end if;
 if found and (p.reminder_emails,p.daily_digest,p.weekly_digest,p.finance_frequency,p.delivery_hour,p.weekly_day,p.delivery_timezone) is not distinct from (reminders_enabled,daily_enabled,weekly_enabled,finance_schedule,hour,weekday,timezone) then return p;end if;
 if (p.owner_id is null and expected_revision<>0) or (p.owner_id is not null and p.revision<>expected_revision) then raise exception 'Email preferences changed; reload first';end if;
 changed:=p.delivery_hour is distinct from hour or p.weekly_day is distinct from weekday or p.delivery_timezone is distinct from timezone;
 insert into public.email_preferences(owner_id,reminder_emails,daily_digest,weekly_digest,finance_frequency,delivery_hour,weekly_day,delivery_timezone,reminder_since,daily_since,weekly_since,finance_since,revision)
 values(auth.uid(),reminders_enabled,daily_enabled,weekly_enabled,finance_schedule,hour,weekday,timezone,
 case when reminders_enabled then case when p.reminder_emails then p.reminder_since else now() end end,
 case when daily_enabled then case when p.daily_digest and not changed then p.daily_since else now() end end,
 case when weekly_enabled then case when p.weekly_digest and not changed then p.weekly_since else now() end end,
 case when finance_schedule<>'off' then case when p.finance_frequency=finance_schedule and not changed then p.finance_since else now() end end,coalesce(p.revision,0)+1)
 on conflict(owner_id) do update set reminder_emails=excluded.reminder_emails,daily_digest=excluded.daily_digest,weekly_digest=excluded.weekly_digest,finance_frequency=excluded.finance_frequency,delivery_hour=excluded.delivery_hour,weekly_day=excluded.weekly_day,delivery_timezone=excluded.delivery_timezone,reminder_since=excluded.reminder_since,daily_since=excluded.daily_since,weekly_since=excluded.weekly_since,finance_since=excluded.finance_since,revision=excluded.revision,updated_at=now() returning * into p;
 update public.email_deliveries set status='cancelled',error_code='preferences_changed' where owner_id=auth.uid() and status='queued';return p;
end $$;
revoke all on function public.save_email_preferences(integer,boolean,boolean,boolean,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.save_email_preferences(integer,boolean,boolean,boolean,text,integer,integer,text) to authenticated;

-- Only current eligible sources may be mailed. No historic notification backfill.
create function private.email_job_live(d public.email_deliveries,clock timestamptz,check_snooze boolean default true) returns boolean language plpgsql stable security definer set search_path='' as $$
declare p public.email_preferences;day date;begin
 select * into p from public.email_preferences where owner_id=d.owner_id;
 if not found or not exists(select 1 from public.workspace_members where workspace_id=d.workspace_id and user_id=d.owner_id) or not exists(select 1 from auth.users where id=d.owner_id and email_confirmed_at is not null and email is not null and email<>'') then return false;end if;
 if exists(select 1 from private.email_payloads j join auth.users u on u.id=d.owner_id where j.delivery_id=d.id and j.payload->'to'->>0 is distinct from u.email) then return false;end if;
 day:=(clock at time zone p.delivery_timezone)::date;
 if d.kind='reminder' then return p.reminder_emails and exists(
  select 1 from public.notifications n join private.reminder_sources() s on s.workspace_id=n.workspace_id and s.owner_id=n.owner_id and s.source_kind=n.source_kind and s.source_id=n.source_id and s.occurrence_on=n.occurrence_on
  where n.id=d.notification_id and n.owner_id=d.owner_id and n.workspace_id=d.workspace_id and n.source_kind in('task','bill','document','subscription','trial','card_statement') and n.created_at>=p.reminder_since and n.dismissed_at is null and n.read_at is null and (not check_snooze or n.snoozed_until is null or n.snoozed_until<=clock)
  and ((n.phase='overdue' and n.occurrence_on<(clock at time zone s.delivery_timezone)::date) or (n.phase='upcoming' and n.occurrence_on>=(clock at time zone s.delivery_timezone)::date)));
 elsif d.kind='daily' then return p.daily_digest and d.created_at>=p.daily_since and d.period_key=day::text;
 elsif d.kind='weekly' then return p.weekly_digest and d.created_at>=p.weekly_since and extract(dow from day)=p.weekly_day and d.period_key=day::text;
 else return d.created_at>=p.finance_since and ((p.finance_frequency='weekly' and extract(dow from day)=p.weekly_day and d.period_key='weekly:'||day::text) or (p.finance_frequency='monthly' and extract(day from day)=1 and d.period_key='monthly:'||day::text));end if;
end $$;
revoke all on function private.email_job_live(public.email_deliveries,timestamptz,boolean) from public,anon,authenticated,service_role;

create function public.queue_email_deliveries(clock timestamptz default now()) returns integer language plpgsql security definer set search_path='' as $$
declare total integer:=0;added integer;p record;day date;mail_kind text;begin
 if not (select ready from private.email_runtime where singleton) or not pg_try_advisory_xact_lock(140001,1) then return 0;end if;
 perform public.deliver_due_reminders();
 insert into public.email_deliveries(workspace_id,owner_id,kind,period_key,notification_id)
 select n.workspace_id,n.owner_id,'reminder',n.id::text,n.id from public.notifications n join public.email_preferences e on e.owner_id=n.owner_id
 join auth.users u on u.id=n.owner_id and u.email_confirmed_at is not null and u.email is not null and u.email<>''
 where e.reminder_emails and n.created_at>=e.reminder_since and n.created_at>=clock-interval '24 hours' and n.source_kind in('task','bill','document','subscription','trial','card_statement') and n.dismissed_at is null and n.read_at is null
 and not exists(select 1 from public.email_deliveries j where j.workspace_id=n.workspace_id and j.owner_id=n.owner_id and j.kind='reminder' and j.period_key=n.id::text)
 and exists(select 1 from public.workspace_members m where m.workspace_id=n.workspace_id and m.user_id=n.owner_id)
 order by n.created_at,n.id limit 500 on conflict(workspace_id,owner_id,kind,period_key) do nothing;
 get diagnostics total=row_count;
 for p in select e.*,m.workspace_id from public.email_preferences e join public.workspace_members m on m.user_id=e.owner_id join auth.users u on u.id=e.owner_id and u.email_confirmed_at is not null and u.email is not null and u.email<>''
 cross join lateral(select (clock at time zone e.delivery_timezone)::date as local_day,extract(hour from clock at time zone e.delivery_timezone) as local_hour) c
 where c.local_hour>=e.delivery_hour and (
 (e.daily_digest and not exists(select 1 from public.email_deliveries j where j.workspace_id=m.workspace_id and j.owner_id=e.owner_id and j.kind='daily' and j.period_key=c.local_day::text)) or
 (e.weekly_digest and extract(dow from c.local_day)=e.weekly_day and not exists(select 1 from public.email_deliveries j where j.workspace_id=m.workspace_id and j.owner_id=e.owner_id and j.kind='weekly' and j.period_key=c.local_day::text)) or
 (e.finance_frequency<>'off' and ((e.finance_frequency='weekly' and extract(dow from c.local_day)=e.weekly_day) or (e.finance_frequency='monthly' and extract(day from c.local_day)=1)) and not exists(select 1 from public.email_deliveries j where j.workspace_id=m.workspace_id and j.owner_id=e.owner_id and j.kind='financial' and j.period_key=e.finance_frequency||':'||c.local_day::text)))
 order by e.owner_id,m.workspace_id limit 500 loop
  day:=(clock at time zone p.delivery_timezone)::date;if extract(hour from clock at time zone p.delivery_timezone)<p.delivery_hour then continue;end if;
  foreach mail_kind in array array['daily','weekly','financial'] loop
   if (mail_kind='daily' and p.daily_digest) or (mail_kind='weekly' and p.weekly_digest and extract(dow from day)=p.weekly_day) or (mail_kind='financial' and ((p.finance_frequency='weekly' and extract(dow from day)=p.weekly_day) or (p.finance_frequency='monthly' and extract(day from day)=1))) then
    insert into public.email_deliveries(workspace_id,owner_id,kind,period_key)values(p.workspace_id,p.owner_id,mail_kind,case when mail_kind='financial' then p.finance_frequency||':' else '' end||day::text)on conflict(workspace_id,owner_id,kind,period_key)do nothing;get diagnostics added=row_count;total:=total+added;
   end if;
  end loop;
 end loop;return total;
end $$;
revoke all on function public.queue_email_deliveries(timestamptz) from public,anon,authenticated;
grant execute on function public.queue_email_deliveries(timestamptz) to service_role;

-- Plain text avoids executing user-supplied markup; amounts never cross currencies.
create function private.email_text(d public.email_deliveries,clock timestamptz) returns text language plpgsql stable security definer set search_path='' as $$
declare p public.email_preferences;day date;finish date;begin_date date;content text;part text;name text;begin
 select * into p from public.email_preferences where owner_id=d.owner_id;day:=(clock at time zone p.delivery_timezone)::date;
 select w.name into name from public.workspaces w where id=d.workspace_id;
 content:='LifeOS - '||name||E'\n';
 if d.kind='reminder' then select title into part from public.notifications where id=d.notification_id;content:=content||part;
 elsif d.kind in('daily','weekly') then
  finish:=day+case when d.kind='weekly' then 6 else 0 end;
  content:=content||case when d.kind='weekly' then 'Weekly planning' else 'Daily overview' end||' ('||day||' to '||finish||')'||E'\n\nYour open tasks (up to 20):\n';
  select string_agg(title||' - '||coalesce(due_date::text,'no due date'),E'\n' order by due_date nulls last,id) into part from (select id,title,due_date from public.tasks where workspace_id=d.workspace_id and owner_id=d.owner_id and status<>'done' and (due_date is null or due_date<=finish) order by due_date nulls last,id limit 20)t;
  content:=content||coalesce(part,'No open tasks in this window.')||E'\n\nYour events (up to 20), '||p.delivery_timezone||E':\n';
  select string_agg(title||' - '||to_char(starts_at at time zone p.delivery_timezone,'YYYY-MM-DD HH24:MI'),E'\n' order by starts_at,id) into part from (select id,title,starts_at from public.calendar_events where workspace_id=d.workspace_id and owner_id=d.owner_id and starts_at>=day::timestamp at time zone p.delivery_timezone and starts_at<(finish+1)::timestamp at time zone p.delivery_timezone order by starts_at,id limit 20)e;
  content:=content||coalesce(part,'No events in this window.');
 else
  finish:=day-1;begin_date:=case when d.period_key like 'monthly:%' then (date_trunc('month',day::timestamp)-interval '1 month')::date else day-7 end;
  content:=content||'Financial summary ('||begin_date||' to '||finish||E')\nIncome and expenses only; transfers excluded. Each currency is separate.\n';
  select string_agg(currency||': income '||income::text||', expenses '||expenses::text||', net '||(income-expenses)::text,E'\n' order by currency) into part from (
   select a.currency,coalesce(sum(t.amount)filter(where t.kind='income'),0)income,coalesce(sum(t.amount)filter(where t.kind='expense'),0)expenses from public.transactions t join public.accounts a on a.id=t.account_id and a.workspace_id=d.workspace_id and a.owner_id=d.owner_id where t.workspace_id=d.workspace_id and t.owner_id=d.owner_id and t.kind in('income','expense') and t.booked_on between begin_date and finish group by a.currency)f;
  content:=content||coalesce(part,'No income or expenses in this period.');
 end if;
 return content||E'\n\nOpen LifeOS and select this workspace: https://lifeos.sajinct.com/#/'||E'\nManage email preferences: https://lifeos.sajinct.com/#/settings\nOnly your own records are included. Replies are not monitored.';
end $$;
revoke all on function private.email_text(public.email_deliveries,timestamptz) from public,anon,authenticated,service_role;

create function public.claim_email_delivery(sender text,clock timestamptz default now()) returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.email_deliveries;payload jsonb;address text;begin
 if not (select ready from private.email_runtime where singleton) then return null;end if;
 if sender is null or length(sender)>320 or sender~E'[\r\n]' or sender!~'^[^[:space:]<>@]+@[^[:space:]<>@]+\.[^[:space:]<>@]+$' then raise exception 'Use a sender email address';end if;
 update public.email_deliveries j set status=case when first_attempt_at is null then 'cancelled' else 'uncertain' end,error_code=case when attempts>=5 then 'retry_limit_reached' else 'stale_or_retry_window_expired' end,lease_id=null,lease_until=null where status in('queued','sending') and (status='queued' or lease_until<=clock) and (attempts>=5 or created_at<clock-interval '24 hours' or first_attempt_at<clock-interval '22 hours' or not private.email_job_live(j,clock,false));
 select * into d from public.email_deliveries j where status in('queued','sending') and next_attempt_at<=clock and (status='queued' or lease_until<=clock) and attempts<5 and private.email_job_live(j,clock,true) order by next_attempt_at,created_at,id limit 1 for update skip locked;
 if not found then return null;end if;
 select p.payload into payload from private.email_payloads p where p.delivery_id=d.id;
 if payload is null then
  select email into address from auth.users where id=d.owner_id and email_confirmed_at is not null;
  payload:=jsonb_build_object('from',sender,'to',jsonb_build_array(address),'subject',case d.kind when 'reminder' then 'LifeOS reminder' when 'daily' then 'LifeOS daily overview' when 'weekly' then 'LifeOS weekly planning' else 'LifeOS financial summary' end,'text',private.email_text(d,clock));
  insert into private.email_payloads(delivery_id,payload)values(d.id,payload);
 end if;
 update public.email_deliveries set status='sending',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,clock),last_attempt_at=clock,lease_id=gen_random_uuid(),lease_until=clock+interval '5 minutes' where id=d.id returning * into d;
 return jsonb_build_object('id',d.id,'lease',d.lease_id,'payload',payload);
end $$;
revoke all on function public.claim_email_delivery(text,timestamptz) from public,anon,authenticated;
grant execute on function public.claim_email_delivery(text,timestamptz) to service_role;

create function public.finish_email_delivery(entry uuid,lease uuid,outcome text,provider text default null,code text default null,clock timestamptz default now()) returns void language plpgsql security definer set search_path='' as $$
declare d public.email_deliveries;begin
 select * into d from public.email_deliveries where id=entry for update;
 if not found or d.status<>'sending' or d.lease_id is distinct from lease then return;end if;
 if outcome not in('accepted','retry','failed','uncertain') or outcome is null or (code is not null and code !~'^[a-z0-9_]{1,80}$') or (provider is not null and provider !~'^[a-zA-Z0-9_-]{1,200}$') or (outcome='accepted' and provider is null) then raise exception 'Invalid email outcome';end if;
 update public.email_deliveries set status=case when outcome='retry' then case when d.attempts>=5 then 'uncertain' else 'queued' end else outcome end,next_attempt_at=clock+make_interval(mins=>case d.attempts when 1 then 1 when 2 then 5 when 3 then 15 else 60 end),accepted_at=case when outcome='accepted' then clock else null end,provider_id=provider,error_code=code,lease_id=null,lease_until=null where id=entry;
end $$;
revoke all on function public.finish_email_delivery(uuid,uuid,text,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.finish_email_delivery(uuid,uuid,text,text,text,timestamptz) to service_role;
