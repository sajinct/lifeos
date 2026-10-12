alter table public.goals add column period text not null default 'long_term' check(period in ('long_term','monthly','annual')),
  add column status text not null default 'active' check(status in ('active','archived')),
  add column notes text not null default '' check(length(notes)<=4000),
  add column revision integer not null default 1 check(revision>0),
  add constraint goals_workspace_id_key unique(workspace_id,id);
revoke insert,update,delete on public.goals from authenticated;
revoke update(title,target,current,unit,due_date,color,visibility) on public.goals from authenticated;
create function public.save_personal_goal(entry uuid,w uuid,expected_revision integer,goal_title text,goal_target numeric,goal_current numeric,goal_unit text,deadline date,goal_period text,goal_color text,goal_notes text,sharing public.record_visibility)
returns uuid language plpgsql security definer set search_path='' as $$ declare r public.goals;begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,12));select * into r from public.goals where id=entry for update;
  if r.id is not null then
    if r.workspace_id<>w or not private.can_edit(r.workspace_id,r.owner_id,r.visibility) then raise exception 'Goal is inaccessible';end if;
    if expected_revision is null then
      if r.owner_id is distinct from auth.uid() then raise exception 'Goal is inaccessible';end if;return entry;
    end if;
    if r.revision<>expected_revision then raise exception 'Goal changed; refresh and try again';end if;
    if r.status<>'active' then raise exception 'Restore the goal before editing';end if;
    if r.owner_id is distinct from auth.uid() and sharing is distinct from r.visibility then raise exception 'Only the creator can change sharing';end if;
  elsif expected_revision is not null then raise exception 'Goal is inaccessible';end if;
  if goal_title is null or length(trim(goal_title)) not between 1 and 200 or goal_unit is null or length(goal_unit)>100 or goal_notes is null or length(goal_notes)>4000
    or goal_target is null or goal_target<=0 or goal_target>=1000000000000 or goal_target<>round(goal_target,2)
    or goal_current is null or goal_current<0 or goal_current>=1000000000000 or goal_current<>round(goal_current,2)
    or goal_period is null or goal_period not in ('long_term','monthly','annual') or goal_color is null or goal_color not in ('purple','green','orange','blue') or sharing is null
    or (deadline is not null and (deadline<'1900-01-01' or deadline>'2100-12-31')) or (goal_period<>'long_term' and deadline is null) then raise exception 'Invalid goal details';end if;
  if r.id is null then insert into public.goals(id,workspace_id,owner_id,title,target,current,unit,due_date,period,color,notes,visibility)values(entry,w,auth.uid(),trim(goal_title),goal_target,goal_current,trim(goal_unit),deadline,goal_period,goal_color,goal_notes,sharing);
  else update public.goals set title=trim(goal_title),target=goal_target,current=goal_current,unit=trim(goal_unit),due_date=deadline,period=goal_period,color=goal_color,notes=goal_notes,visibility=sharing,revision=revision+1 where id=entry;end if;
  return entry;
end $$;
create function public.set_goal_archive(entry uuid,expected_revision integer,archived boolean) returns void language plpgsql security definer set search_path='' as $$ declare r public.goals;status_value text;begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,12));select * into r from public.goals where id=entry for update;
  if r.id is null or not private.can_edit(r.workspace_id,r.owner_id,r.visibility) then raise exception 'Goal edit access required';end if;
  if archived is null then raise exception 'Choose a goal status';end if;status_value:=case when archived then 'archived' else 'active' end;
  if r.status=status_value then return;end if;
  if expected_revision is null or r.revision<>expected_revision then raise exception 'Goal changed; refresh and try again';end if;
  update public.goals set status=status_value,revision=revision+1 where id=entry;
end $$;
create table public.habits (
  id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility='private'),title text not null check(length(trim(title)) between 1 and 200),
  routine text not null default '' check(length(routine)<=100),notes text not null default '' check(length(notes)<=2000),starts_on date not null,
  weekdays integer[] not null check(cardinality(weekdays) between 1 and 7 and weekdays<@array[1,2,3,4,5,6,7]),
  status text not null default 'active' check(status in ('active','paused','archived')),revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(workspace_id,id)
);
create table public.habit_periods (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility='private'),habit_id uuid not null,starts_on date not null,
  status text not null check(status in ('active','paused','archived')),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  foreign key(workspace_id,habit_id) references public.habits(workspace_id,id) on delete cascade,unique(habit_id,starts_on)
);
create table public.habit_checkins (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility='private'),habit_id uuid not null,completed_on date not null,done boolean not null,
  revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  foreign key(workspace_id,habit_id) references public.habits(workspace_id,id) on delete cascade,unique(habit_id,completed_on)
);
create table public.goal_milestones (
  id uuid primary key,workspace_id uuid not null references public.workspaces(id) on delete cascade,owner_id uuid not null references public.profiles(id),
  visibility public.record_visibility not null default 'private' check(visibility='private'),goal_id uuid not null,title text not null check(length(trim(title)) between 1 and 200),
  due_on date,notes text not null default '' check(length(notes)<=2000),done boolean not null default false,completed_on date,
  revision integer not null default 1 check(revision>0),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  foreign key(workspace_id,goal_id) references public.goals(workspace_id,id) on delete cascade,check(done=(completed_on is not null))
);
do $$ declare t text;begin
  foreach t in array array['habits','habit_periods','habit_checkins','goal_milestones'] loop
    execute format('create index on public.%I(workspace_id,owner_id)',t);
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('create policy own_habit_read on public.%I for select to authenticated using(owner_id=(select auth.uid()) and private.is_member(workspace_id))',t);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()',t);
  end loop;
end $$;
create index habit_checkin_date_idx on public.habit_checkins(habit_id,completed_on);
create index goal_milestone_goal_idx on public.goal_milestones(goal_id);
create function public.save_habit(entry uuid,w uuid,expected_revision integer,habit_title text,routine_name text,habit_notes text,first_day date,scheduled_days integer[])
returns uuid language plpgsql security definer set search_path='' as $$ declare r public.habits;days integer[];begin
  if auth.uid() is null or entry is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,13));select * into r from public.habits where id=entry for update;
  if r.id is not null then
    if r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Habit is inaccessible';end if;
    if expected_revision is null then return entry;end if;
    if r.revision<>expected_revision then raise exception 'Habit changed; refresh and try again';end if;
    if r.status='archived' then raise exception 'Restore the habit before editing';end if;
  elsif expected_revision is not null then raise exception 'Habit is inaccessible';end if;
  select array_agg(distinct d order by d) into days from unnest(scheduled_days) d;
  if habit_title is null or length(trim(habit_title)) not between 1 and 200 or routine_name is null or length(routine_name)>100 or habit_notes is null or length(habit_notes)>2000
    or first_day is null or first_day<'1900-01-01' or first_day>private.finance_today(auth.uid()) or first_day>'2100-12-31'
    or days is null or cardinality(scheduled_days)>7 or not days<@array[1,2,3,4,5,6,7] or array_position(scheduled_days,null) is not null then raise exception 'Invalid habit details';end if;
  if r.id is not null and (r.starts_on<>first_day or r.weekdays<>days) then raise exception 'Schedule is fixed; create a new habit to change start date or weekdays';end if;
  if r.id is null then
    insert into public.habits(id,workspace_id,owner_id,title,routine,notes,starts_on,weekdays)values(entry,w,auth.uid(),trim(habit_title),trim(routine_name),habit_notes,first_day,days);
    insert into public.habit_periods(workspace_id,owner_id,habit_id,starts_on,status)values(w,auth.uid(),entry,first_day,'active');
  else update public.habits set title=trim(habit_title),routine=trim(routine_name),notes=habit_notes,revision=revision+1 where id=entry;end if;
  return entry;
end $$;
create function public.set_habit_status(entry uuid,expected_revision integer,target text) returns void language plpgsql security definer set search_path='' as $$ declare r public.habits;today date;begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,13));select * into r from public.habits where id=entry for update;
  if r.id is null or r.owner_id is distinct from auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Habit owner with write access required';end if;
  if target is null or target not in ('active','paused','archived') then raise exception 'Invalid habit status';end if;
  if r.status=target then return;end if;
  if expected_revision is null or r.revision<>expected_revision then raise exception 'Habit changed; refresh and try again';end if;
  today:=private.finance_today(auth.uid());
  if exists(select 1 from public.habit_periods where habit_id=entry and starts_on>today) then raise exception 'Local date precedes the last status change';end if;
  update public.habits set status=target,revision=revision+1 where id=entry;
  insert into public.habit_periods(workspace_id,owner_id,habit_id,starts_on,status)values(r.workspace_id,auth.uid(),entry,today,target)
    on conflict(habit_id,starts_on) do update set status=excluded.status;
end $$;
create function public.set_habit_checkin(habit uuid,day date,expected_revision integer,completed boolean) returns void language plpgsql security definer set search_path='' as $$ declare r public.habits;c public.habit_checkins;today date;active_state text;begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(habit::text,13));select * into r from public.habits where id=habit for update;
  if r.id is null or r.owner_id is distinct from auth.uid() or not private.can_write(r.workspace_id) then raise exception 'Habit owner with write access required';end if;
  today:=private.finance_today(auth.uid());
  if day is null or day>today or day<today-365 or day<r.starts_on or not extract(isodow from day)::integer=any(r.weekdays) or completed is null then raise exception 'Choose a scheduled date within the past 365 days';end if;
  select status into active_state from public.habit_periods where habit_id=habit and starts_on<=day order by starts_on desc limit 1;
  if r.status='archived' or active_state is distinct from 'active' then raise exception 'Habit was not active on this date';end if;
  select * into c from public.habit_checkins where habit_id=habit and completed_on=day for update;
  if c.id is not null and c.done=completed then return;end if;
  if expected_revision is null or expected_revision<>coalesce(c.revision,0) then raise exception 'Check-in changed; refresh and try again';end if;
  if c.id is null then insert into public.habit_checkins(workspace_id,owner_id,habit_id,completed_on,done)values(r.workspace_id,auth.uid(),habit,day,completed);
  else update public.habit_checkins set done=completed,revision=revision+1 where id=c.id;end if;
end $$;
create function public.save_goal_milestone(entry uuid,w uuid,expected_revision integer,goal uuid,milestone_title text,deadline date,milestone_notes text)
returns uuid language plpgsql security definer set search_path='' as $$ declare g public.goals;r public.goal_milestones;begin
  if auth.uid() is null or entry is null or goal is null or not private.can_write(w) then raise exception 'Workspace write access required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(goal::text,12));select * into g from public.goals where id=goal for update;
  if g.id is null or g.workspace_id<>w or g.owner_id is distinct from auth.uid() or g.status<>'active' then raise exception 'Own active goal in this workspace required';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(entry::text,14));select * into r from public.goal_milestones where id=entry for update;
  if r.id is not null then
    if r.goal_id<>goal or r.workspace_id<>w or r.owner_id is distinct from auth.uid() then raise exception 'Milestone is inaccessible';end if;
    if expected_revision is null then return entry;end if;
    if r.revision<>expected_revision then raise exception 'Milestone changed; refresh and try again';end if;
  elsif expected_revision is not null then raise exception 'Milestone is inaccessible';end if;
  if milestone_title is null or length(trim(milestone_title)) not between 1 and 200 or milestone_notes is null or length(milestone_notes)>2000 or (deadline is not null and (deadline<'1900-01-01' or deadline>'2100-12-31')) then raise exception 'Invalid milestone details';end if;
  if r.id is null then insert into public.goal_milestones(id,workspace_id,owner_id,goal_id,title,due_on,notes)values(entry,w,auth.uid(),goal,trim(milestone_title),deadline,milestone_notes);
  else update public.goal_milestones set title=trim(milestone_title),due_on=deadline,notes=milestone_notes,revision=revision+1 where id=entry;end if;
  return entry;
end $$;
create function public.set_goal_milestone_done(entry uuid,expected_revision integer,completed boolean) returns void language plpgsql security definer set search_path='' as $$ declare g public.goals;r public.goal_milestones;gid uuid;begin
  select goal_id into gid from public.goal_milestones where id=entry;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(gid::text,12));select * into g from public.goals where id=gid for update;
  select * into r from public.goal_milestones where id=entry for update;
  if r.id is null or r.owner_id is distinct from auth.uid() or g.owner_id is distinct from auth.uid() or g.status<>'active' or not private.can_write(r.workspace_id) then raise exception 'Own active goal with write access required';end if;
  if completed is null then raise exception 'Choose milestone completion';end if;
  if r.done=completed then return;end if;
  if expected_revision is null or expected_revision<>r.revision then raise exception 'Milestone changed; refresh and try again';end if;
  update public.goal_milestones set done=completed,completed_on=case when completed then private.finance_today(auth.uid()) else null end,revision=revision+1 where id=entry;
end $$;
revoke all on function public.save_personal_goal(uuid,uuid,integer,text,numeric,numeric,text,date,text,text,text,public.record_visibility),public.set_goal_archive(uuid,integer,boolean),public.save_habit(uuid,uuid,integer,text,text,text,date,integer[]),public.set_habit_status(uuid,integer,text),public.set_habit_checkin(uuid,date,integer,boolean),public.save_goal_milestone(uuid,uuid,integer,uuid,text,date,text),public.set_goal_milestone_done(uuid,integer,boolean) from public,anon,authenticated;
grant execute on function public.save_personal_goal(uuid,uuid,integer,text,numeric,numeric,text,date,text,text,text,public.record_visibility),public.set_goal_archive(uuid,integer,boolean),public.save_habit(uuid,uuid,integer,text,text,text,date,integer[]),public.set_habit_status(uuid,integer,text),public.set_habit_checkin(uuid,date,integer,boolean),public.save_goal_milestone(uuid,uuid,integer,uuid,text,date,text),public.set_goal_milestone_done(uuid,integer,boolean) to authenticated;
