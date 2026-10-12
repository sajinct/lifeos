import {
  Habit,
  HabitInput,
  HabitCheckin,
  HabitPeriod,
  Goal,
  GoalInput,
  GoalMilestone,
  MilestoneInput,
} from '../../core/models/domain';
import { validLoanDate } from './loans';
import { csv } from './finance';
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function shiftDay(day: string, amount: number) {
  return new Date(Date.parse(day + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10);
}
export function supportedDate(day: string) {
  return validLoanDate(day) && day >= '1900-01-01' && day <= '2100-12-31';
}
export function progressAmount(value: string, positive = false) {
  if (
    !/^\d{1,12}(\.\d{1,2})?$/.test(value) ||
    Number(value) >= 1000000000000 ||
    (positive && Number(value) <= 0)
  )
    throw new Error(
      'Use an amount with up to two decimal places; the target must be greater than zero.',
    );
  return Number(value);
}
export function validateGoal(input: GoalInput) {
  const v = { ...input, title: input.title.trim(), unit: input.unit.trim() };
  if (
    !v.title ||
    v.title.length > 200 ||
    v.unit.length > 100 ||
    v.notes.length > 4000 ||
    !['long_term', 'monthly', 'annual'].includes(v.period) ||
    !['purple', 'green', 'orange', 'blue'].includes(v.color) ||
    !['private', 'workspace'].includes(v.visibility) ||
    (v.due_date && !supportedDate(v.due_date)) ||
    (v.period !== 'long_term' && !v.due_date)
  )
    throw new Error('Check the goal details. Monthly and annual goals need a target date.');
  progressAmount(v.target, true);
  progressAmount(v.current);
  return v;
}
export function validateHabit(input: HabitInput, today: string) {
  const v = {
    ...input,
    title: input.title.trim(),
    routine: input.routine.trim(),
    weekdays: [...new Set(input.weekdays)].sort((a, b) => a - b),
  };
  if (
    !v.title ||
    v.title.length > 200 ||
    v.routine.length > 100 ||
    v.notes.length > 2000 ||
    !supportedDate(v.starts_on) ||
    v.starts_on > today ||
    !v.weekdays.length ||
    input.weekdays.length > 7 ||
    v.weekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
  )
    throw new Error(
      'Choose a habit title, a start date today or earlier and at least one weekday.',
    );
  return v;
}
export function validateMilestone(v: MilestoneInput) {
  const r = { ...v, title: v.title.trim() };
  if (
    !r.goal_id ||
    !r.title ||
    r.title.length > 200 ||
    r.notes.length > 2000 ||
    (r.due_on && !supportedDate(r.due_on))
  )
    throw new Error('Choose a goal, milestone title and valid optional date.');
  return r;
}
function stateOn(h: Habit, periods: HabitPeriod[], day: string) {
  return periods
    .filter(
      (p) =>
        p.habit_id === h.id &&
        p.owner_id === h.owner_id &&
        p.workspace_id === h.workspace_id &&
        p.starts_on <= day,
    )
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0];
}
export function habitDue(h: Habit, periods: HabitPeriod[], day: string) {
  const weekday = ((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;
  return (
    day >= h.starts_on &&
    h.weekdays.includes(weekday) &&
    stateOn(h, periods, day)?.status === 'active'
  );
}
export function habitStats(
  h: Habit,
  periods: HabitPeriod[],
  checkins: HabitCheckin[],
  today: string,
  days = 30,
) {
  const completed = new Set(
    checkins
      .filter(
        (c) =>
          c.habit_id === h.id &&
          c.owner_id === h.owner_id &&
          c.workspace_id === h.workspace_id &&
          c.done,
      )
      .map((c) => c.completed_on),
  );
  let scheduled = 0,
    done = 0;
  for (let i = 0; i < days; i++) {
    const day = shiftDay(today, -i);
    if (habitDue(h, periods, day)) {
      scheduled++;
      if (completed.has(day)) done++;
    }
  }
  let best = 0,
    run = 0;
  for (let i = 89; i >= 0; i--) {
    const day = shiftDay(today, -i);
    if (habitDue(h, periods, day)) {
      run = completed.has(day) ? run + 1 : 0;
      best = Math.max(best, run);
    }
  }
  let cursor = habitDue(h, periods, today) && !completed.has(today) ? shiftDay(today, -1) : today,
    current = 0;
  while (cursor >= h.starts_on) {
    const state = stateOn(h, periods, cursor);
    if (!state) break;
    if (state.status !== 'active') {
      cursor = shiftDay(state.starts_on, -1);
      continue;
    }
    if (habitDue(h, periods, cursor)) {
      if (!completed.has(cursor)) break;
      current++;
    }
    cursor = shiftDay(cursor, -1);
  }
  return {
    scheduled,
    done,
    rate: scheduled ? Math.round((done / scheduled) * 100) : 0,
    current,
    best,
  };
}
export function goalsCsv(goals: Goal[], milestones: GoalMilestone[]) {
  return csv(
    goals.map((g) => ({
      id: g.id,
      title: g.title,
      period: g.period,
      status: g.status,
      target: g.target,
      current: g.current,
      unit: g.unit,
      due_date: g.due_date,
      visibility: g.visibility,
      notes: g.notes,
      milestones: milestones
        .filter((m) => m.goal_id === g.id)
        .map((m) => (m.done ? 'Done: ' : 'Open: ') + m.title)
        .join('; '),
    })),
  );
}
export function habitsCsv(
  habits: Habit[],
  periods: HabitPeriod[],
  checkins: HabitCheckin[],
  today: string,
) {
  return csv(
    habits.map((h) => ({
      id: h.id,
      title: h.title,
      routine: h.routine,
      status: h.status,
      starts_on: h.starts_on,
      weekdays: h.weekdays.map((d) => WEEKDAYS[d - 1]).join('; '),
      notes: h.notes,
      ...habitStats(h, periods, checkins, today),
    })),
  );
}
export function checkinsCsv(habits: Habit[], checkins: HabitCheckin[]) {
  return csv(
    checkins
      .filter((c) => habits.some((h) => h.id === c.habit_id))
      .map((c) => ({
        habit_id: c.habit_id,
        habit: habits.find((h) => h.id === c.habit_id)!.title,
        date: c.completed_on,
        done: c.done,
      })),
  );
}
