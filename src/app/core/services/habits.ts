import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  Habit,
  HabitCheckin,
  HabitInput,
  Goal,
  GoalInput,
  GoalMilestone,
  MilestoneInput,
  OwnedRecord,
} from '../models/domain';
import {
  validateHabit,
  validateGoal,
  progressAmount,
  validateMilestone,
  habitDue,
  supportedDate,
  shiftDay,
} from '../../shared/utilities/habits';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class HabitLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly clock = signal(Date.now());
  readonly today = computed(() => {
    this.clock();
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  });
  constructor() {
    const timer = setInterval(() => this.clock.set(Date.now()), 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  private context() {
    const workspace = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !workspace ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { workspace, user, session };
  }
  private current(c: ReturnType<HabitLibrary['context']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private own(row: OwnedRecord, c: ReturnType<HabitLibrary['context']>) {
    if (row.workspace_id !== c.workspace || row.owner_id !== c.user)
      throw new Error('Record is inaccessible.');
  }
  private base(c: ReturnType<HabitLibrary['context']>) {
    const time = new Date().toISOString();
    return {
      workspace_id: c.workspace,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: time,
      updated_at: time,
    };
  }
  private async reload(c: ReturnType<HabitLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  async saveGoal(id: string, input: GoalInput, previous?: Goal) {
    const c = this.context(),
      v = validateGoal(input);
    if (previous && (previous.workspace_id !== c.workspace || !this.store.canEdit(previous)))
      throw new Error('Goal is inaccessible.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_personal_goal', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        goal_title: v.title,
        goal_target: progressAmount(v.target, true),
        goal_current: progressAmount(v.current),
        goal_unit: v.unit,
        deadline: v.due_date || null,
        goal_period: v.period,
        goal_color: v.color,
        goal_notes: v.notes,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.goals().find((g) => g.id === id);
    if (old) {
      if (old.workspace_id !== c.workspace || !this.store.canEdit(old))
        throw new Error('Goal is inaccessible.');
      if (!previous) {
        this.own(old, c);
        return;
      }
      if (old.revision !== previous.revision)
        throw new Error('Goal changed; refresh and try again.');
      if (old.status !== 'active') throw new Error('Restore the goal before editing.');
      if (old.owner_id !== c.user && old.visibility !== v.visibility)
        throw new Error('Only the creator can change sharing.');
    } else if (previous) throw new Error('Goal is inaccessible.');
    const row: Goal = {
      ...this.base(c),
      ...v,
      id,
      owner_id: old?.owner_id ?? c.user,
      target: progressAmount(v.target, true),
      current: progressAmount(v.current),
      due_date: v.due_date || null,
      status: 'active',
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? new Date().toISOString(),
    };
    this.store.goals.update((rows) => [row, ...rows.filter((g) => g.id !== id)]);
  }
  async archiveGoal(row: Goal) {
    const c = this.context();
    if (row.workspace_id !== c.workspace || !this.store.canEdit(row))
      throw new Error('Goal edit access required.');
    const archived = row.status !== 'archived';
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('set_goal_archive', { entry: row.id, expected_revision: row.revision, archived });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.goals().find((g) => g.id === row.id);
    if (!old) throw new Error('Goal is inaccessible.');
    if (old.status === (archived ? 'archived' : 'active')) return;
    if (old.revision !== row.revision) throw new Error('Goal changed; refresh and try again.');
    this.store.goals.update((rows) =>
      rows.map((g) =>
        g.id === row.id
          ? { ...g, status: archived ? 'archived' : 'active', revision: g.revision + 1 }
          : g,
      ),
    );
  }
  async saveHabit(id: string, input: HabitInput, previous?: Habit) {
    const c = this.context(),
      v = validateHabit(input, this.today());
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_habit', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        habit_title: v.title,
        routine_name: v.routine,
        habit_notes: v.notes,
        first_day: v.starts_on,
        scheduled_days: v.weekdays,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.habits().find((h) => h.id === id);
    if (old) {
      this.own(old, c);
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('Habit changed; refresh and try again.');
      if (old.status === 'archived') throw new Error('Restore the habit before editing.');
      if (old.starts_on !== v.starts_on || old.weekdays.join() !== v.weekdays.join())
        throw new Error('Schedule is fixed; create a new habit to change it.');
    } else if (previous) throw new Error('Habit is inaccessible.');
    const base = this.base(c),
      row: Habit = {
        ...base,
        ...v,
        id,
        status: old?.status ?? 'active',
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? base.created_at,
      };
    this.store.habits.update((rows) => [row, ...rows.filter((h) => h.id !== id)]);
    if (!old)
      this.store.habitPeriods.update((rows) => [
        ...rows,
        {
          ...base,
          id: crypto.randomUUID(),
          habit_id: id,
          starts_on: v.starts_on,
          status: 'active',
        },
      ]);
  }
  async status(row: Habit, target: Habit['status']) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('set_habit_status', { entry: row.id, expected_revision: row.revision, target });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.habits().find((h) => h.id === row.id);
    if (!old) throw new Error('Habit is inaccessible.');
    if (old.status === target) return;
    if (old.revision !== row.revision) throw new Error('Habit changed; refresh and try again.');
    const today = this.today();
    if (this.store.habitPeriods().some((p) => p.habit_id === row.id && p.starts_on > today))
      throw new Error('Local date precedes the last status change.');
    this.store.habits.update((rows) =>
      rows.map((h) => (h.id === row.id ? { ...h, status: target, revision: h.revision + 1 } : h)),
    );
    this.store.habitPeriods.update((rows) => [
      ...rows.filter((p) => p.habit_id !== row.id || p.starts_on !== today),
      {
        ...this.base(c),
        id: crypto.randomUUID(),
        habit_id: row.id,
        starts_on: today,
        status: target,
      },
    ]);
  }
  async checkin(row: Habit, day: string, completed: boolean, previous?: HabitCheckin) {
    const c = this.context();
    this.own(row, c);
    if (previous) {
      this.own(previous, c);
      if (previous.habit_id !== row.id || previous.completed_on !== day)
        throw new Error('Check-in is inaccessible.');
    }
    if (
      !supportedDate(day) ||
      day > this.today() ||
      day < shiftDay(this.today(), -365) ||
      day < row.starts_on
    )
      throw new Error('Choose a scheduled date within the past 365 days.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_habit_checkin', {
        habit: row.id,
        day,
        expected_revision: previous?.revision ?? 0,
        completed,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const h = this.store.habits().find((h) => h.id === row.id);
    if (!h || h.status === 'archived' || !habitDue(h, this.store.habitPeriods(), day))
      throw new Error('Habit was not active on this date.');
    const old = this.store
      .habitCheckins()
      .find((c) => c.habit_id === row.id && c.completed_on === day);
    if (old?.done === completed) return;
    if ((old?.revision ?? 0) !== (previous?.revision ?? 0))
      throw new Error('Check-in changed; refresh and try again.');
    const check: HabitCheckin = {
      ...this.base(c),
      id: old?.id ?? crypto.randomUUID(),
      habit_id: row.id,
      completed_on: day,
      done: completed,
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? new Date().toISOString(),
    };
    this.store.habitCheckins.update((rows) => [check, ...rows.filter((c) => c.id !== check.id)]);
  }
  private goal(id: string, c: ReturnType<HabitLibrary['context']>) {
    const g = this.store.goals().find((g) => g.id === id);
    if (!g || g.owner_id !== c.user || g.workspace_id !== c.workspace || g.status !== 'active')
      throw new Error('Own active goal in this workspace required.');
    return g;
  }
  async saveMilestone(id: string, input: MilestoneInput, previous?: GoalMilestone) {
    const c = this.context(),
      v = validateMilestone(input);
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_goal_milestone', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        goal: v.goal_id,
        milestone_title: v.title,
        deadline: v.due_on || null,
        milestone_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    this.goal(v.goal_id, c);
    const old = this.store.goalMilestones().find((m) => m.id === id);
    if (old) {
      this.own(old, c);
      if (old.goal_id !== v.goal_id) throw new Error('Milestone is inaccessible.');
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('Milestone changed; refresh and try again.');
    } else if (previous) throw new Error('Milestone is inaccessible.');
    const m: GoalMilestone = {
      ...this.base(c),
      ...v,
      id,
      due_on: v.due_on || null,
      done: old?.done ?? false,
      completed_on: old?.completed_on ?? null,
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? new Date().toISOString(),
    };
    this.store.goalMilestones.update((rows) => [m, ...rows.filter((m) => m.id !== id)]);
  }
  async milestoneDone(row: GoalMilestone, completed: boolean) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_goal_milestone_done', {
        entry: row.id,
        expected_revision: row.revision,
        completed,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    this.goal(row.goal_id, c);
    const old = this.store.goalMilestones().find((m) => m.id === row.id);
    if (!old) throw new Error('Milestone is inaccessible.');
    if (old.done === completed) return;
    if (old.revision !== row.revision) throw new Error('Milestone changed; refresh and try again.');
    this.store.goalMilestones.update((rows) =>
      rows.map((m) =>
        m.id === row.id
          ? {
              ...m,
              done: completed,
              completed_on: completed ? this.today() : null,
              revision: m.revision + 1,
            }
          : m,
      ),
    );
  }
}
