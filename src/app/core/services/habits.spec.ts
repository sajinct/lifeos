import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { HabitLibrary } from './habits';
import { Backend } from '../supabase/client';
import { HabitInput, GoalInput, Habit, HabitPeriod, HabitCheckin, Capture } from '../models/domain';
import {
  validateHabit,
  validateGoal,
  habitDue,
  habitStats,
  shiftDay,
  habitsCsv,
  goalsCsv,
  checkinsCsv,
} from '../../shared/utilities/habits';
describe('Habits, routines and goal milestones', () => {
  let store: LifeStore, library: HabitLibrary, habit: HabitInput, goal: GoalInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(HabitLibrary);
    habit = {
      title: 'Read a few pages',
      routine: 'Evening',
      starts_on: shiftDay(library.today(), -1),
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      notes: '',
    };
    goal = {
      title: 'Read books',
      target: '12',
      current: '0',
      unit: 'books',
      due_date: library.today(),
      period: 'monthly',
      notes: '',
      color: 'green',
      visibility: 'private',
    };
  });
  it('validates goal amounts/deadlines and habit schedules without accepting invalid calendar dates', () => {
    for (const patch of [
      { target: '0' },
      { current: '-1' },
      { target: 'NaN' },
      { target: '1.001' },
      { target: '1000000000000' },
      { due_date: '' },
      { due_date: '2026-02-30' },
    ])
      expect(() => validateGoal({ ...goal, ...patch })).toThrow();
    for (const patch of [
      { weekdays: [] },
      { weekdays: [0] },
      { weekdays: [NaN] },
      { starts_on: '2026-02-30' },
      { starts_on: '2200-01-01' },
      { notes: 'x'.repeat(2001) },
    ])
      expect(() => validateHabit({ ...habit, ...patch }, library.today())).toThrow();
    expect(validateHabit({ ...habit, weekdays: [2, 1, 2] }, library.today()).weekdays).toEqual([
      1, 2,
    ]);
  });
  it('preserves goal creation retries, rejects stale progress and archives without deleting milestones', async () => {
    await library.saveGoal('g', goal);
    await library.saveGoal('g', { ...goal, title: 'Ignored' });
    const g = store.goals().find((g) => g.id === 'g')!;
    expect(g.title).toBe(goal.title);
    await store.updateGoal(g, '2');
    await expect(store.updateGoal(g, '1')).rejects.toThrow(/changed/);
    await library.saveMilestone('m', {
      goal_id: 'g',
      title: 'Finish book one',
      due_on: '',
      notes: '',
    });
    await library.archiveGoal(store.goals().find((g) => g.id === 'g')!);
    expect(store.goalMilestones()).toHaveLength(1);
    await expect(
      library.saveMilestone('m2', { goal_id: 'g', title: 'Second book', due_on: '', notes: '' }),
    ).rejects.toThrow(/active goal/);
    await library.archiveGoal(store.goals().find((g) => g.id === 'g')!);
    expect(store.goals().find((g) => g.id === 'g')!.current).toBe(2);
  });
  it('completes and reopens milestones idempotently without changing goal progress', async () => {
    await library.saveGoal('g', goal);
    await library.saveMilestone('m', { goal_id: 'g', title: 'Book one', due_on: '', notes: '' });
    const old = store.goalMilestones()[0];
    await library.milestoneDone(old, true);
    await library.milestoneDone(old, true);
    expect(store.goalMilestones()[0].revision).toBe(2);
    expect(store.goalMilestones()[0].completed_on).toBe(library.today());
    expect(store.goals().find((g) => g.id === 'g')!.current).toBe(0);
    await expect(library.milestoneDone(old, false)).rejects.toThrow(/changed/);
    await library.milestoneDone(store.goalMilestones()[0], false);
    expect(store.goalMilestones()[0].completed_on).toBeNull();
  });
  it('locks schedule history and protects check-in undo from stale actions', async () => {
    await library.saveHabit('h', habit);
    await library.saveHabit('h', { ...habit, title: 'Ignored' });
    const h = store.habits()[0];
    expect(h.title).toBe(habit.title);
    await expect(library.saveHabit('h', { ...habit, weekdays: [1] }, h)).rejects.toThrow(/fixed/);
    await library.checkin(h, library.today(), true);
    await library.checkin(h, library.today(), true);
    const old = store.habitCheckins()[0];
    expect(old.revision).toBe(1);
    await library.checkin(h, library.today(), false, old);
    await library.checkin(h, library.today(), true, store.habitCheckins()[0]);
    await expect(library.checkin(h, library.today(), false, old)).rejects.toThrow(/changed/);
    expect(store.habitCheckins()).toHaveLength(1);
  });
  it('keeps paused-day requirements out of statistics, preserves history and restores activity', async () => {
    await library.saveHabit('h', habit);
    let h = store.habits()[0];
    await library.checkin(h, shiftDay(library.today(), -1), true);
    await library.checkin(h, library.today(), true);
    expect(
      habitStats(h, store.habitPeriods(), store.habitCheckins(), library.today()).current,
    ).toBe(2);
    await library.status(h, 'paused');
    h = store.habits()[0];
    expect(habitDue(h, store.habitPeriods(), library.today())).toBe(false);
    expect(
      habitStats(h, store.habitPeriods(), store.habitCheckins(), library.today()).current,
    ).toBe(1);
    expect(store.habitCheckins()).toHaveLength(2);
    await expect(
      library.checkin(
        h,
        library.today(),
        false,
        store.habitCheckins().find((c) => c.completed_on === library.today()),
      ),
    ).rejects.toThrow(/not active/);
    await library.status(h, 'active');
    expect(
      habitStats(store.habits()[0], store.habitPeriods(), store.habitCheckins(), library.today())
        .current,
    ).toBe(2);
  });
  it('handles scheduled weekdays, weekends, a pending today and missed-day streak breaks', () => {
    const h = {
      id: 'h',
      workspace_id: 'demo',
      owner_id: 'demo-user',
      starts_on: '2026-10-05',
      weekdays: [1, 2, 3, 4, 5],
      status: 'active',
      visibility: 'private',
      title: 'Weekday habit',
      routine: 'Morning',
      notes: '',
      revision: 1,
      created_at: '',
      updated_at: '',
    } as Habit;
    const periods = [
      {
        id: 'p',
        habit_id: 'h',
        workspace_id: 'demo',
        owner_id: 'demo-user',
        starts_on: h.starts_on,
        status: 'active',
      } as HabitPeriod,
    ];
    const checks = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'].map(
      (completed_on) =>
        ({
          id: completed_on,
          habit_id: 'h',
          workspace_id: 'demo',
          owner_id: 'demo-user',
          completed_on,
          done: true,
          revision: 1,
        }) as HabitCheckin,
    );
    expect(habitDue(h, periods, '2026-10-10')).toBe(false);
    expect(habitStats(h, periods, checks, '2026-10-12', 30)).toMatchObject({
      current: 5,
      best: 5,
      scheduled: 6,
      done: 5,
      rate: 83,
    });
    expect(habitStats(h, periods, checks, '2026-10-13').current).toBe(0);
    const pause = [
      ...periods,
      { ...periods[0], id: 'pause', starts_on: '2026-10-12', status: 'paused' as const },
      { ...periods[0], id: 'resume', starts_on: '2026-10-19', status: 'active' as const },
    ];
    expect(habitStats(h, pause, checks, '2026-10-19').current).toBe(5);
  });
  it('handles leap days and year boundaries as date-only values', () => {
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDay('2025-01-01', -1)).toBe('2024-12-31');
    const h = {
        id: 'h',
        workspace_id: 'demo',
        owner_id: 'demo-user',
        starts_on: '2024-02-28',
        weekdays: [1, 2, 3, 4, 5, 6, 7],
      } as Habit,
      periods = [
        {
          habit_id: 'h',
          workspace_id: 'demo',
          owner_id: 'demo-user',
          starts_on: h.starts_on,
          status: 'active',
        } as HabitPeriod,
      ],
      checks = ['2024-02-28', '2024-02-29', '2024-03-01'].map(
        (completed_on) =>
          ({
            habit_id: 'h',
            workspace_id: 'demo',
            owner_id: 'demo-user',
            completed_on,
            done: true,
          }) as HabitCheckin,
      );
    expect(habitStats(h, periods, checks, '2024-03-01')).toMatchObject({
      current: 3,
      best: 3,
      rate: 100,
    });
  });
  it('advances the habit day after local midnight while the page stays open', async () => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-12T18:29:50Z'));
      TestBed.configureTestingModule({});
      TestBed.inject(AuthService).demo.set(true);
      const s = TestBed.inject(LifeStore);
      await s.initialize();
      const l = TestBed.inject(HabitLibrary);
      expect(s.profile()!.timezone).toBe('Asia/Kolkata');
      expect(l.today()).toBe('2026-10-12');
      vi.advanceTimersByTime(60000);
      expect(l.today()).toBe('2026-10-13');
    } finally {
      TestBed.resetTestingModule();
      vi.useRealTimers();
    }
  });
  it('exports formula-safe goal and habit data with a separate full check-in history', async () => {
    await library.saveGoal('g', { ...goal, title: '=Books' });
    await library.saveMilestone('m', { goal_id: 'g', title: 'Book one', due_on: '', notes: '' });
    await library.saveHabit('h', { ...habit, title: '=Read' });
    await library.checkin(store.habits()[0], library.today(), true);
    expect(goalsCsv(store.goals(), store.goalMilestones())).toContain("'=Books");
    expect(
      habitsCsv(store.habits(), store.habitPeriods(), store.habitCheckins(), library.today()),
    ).toContain("'=Read");
    expect(checkinsCsv(store.habits(), store.habitCheckins())).toContain(library.today());
    expect(checkinsCsv([], store.habitCheckins())).toBe('');
  });
  it('reuses the quick-capture goal request instead of duplicating a failed save', async () => {
    const input = {
      kind: 'goal',
      title: 'Quick captured goal',
      amount: '4',
      category: 'books',
      date: library.today(),
      visibility: 'private',
      body: '',
      priority: 'medium',
      project_id: '',
      account_id: '',
      time: '09:00',
      end_time: '10:00',
    } as Capture;
    await store.add(input, 'request-g');
    await store.add({ ...input, title: 'Ignored retry' }, 'request-g');
    expect(store.goals().filter((g) => g.id === 'request-g')).toHaveLength(1);
    expect(store.goals().find((g) => g.id === 'request-g')!.title).toBe('Quick captured goal');
  });
  it('caches all habit data by workspace and clears it on signout', async () => {
    await library.saveHabit('h', habit);
    await library.checkin(store.habits()[0], library.today(), true);
    const original = store.workspace()!;
    await store.createWorkspace('Other habits', 'personal');
    expect(store.habits()).toHaveLength(0);
    await store.switchWorkspace(original);
    expect(store.habits()).toHaveLength(1);
    expect(store.habitPeriods()).toHaveLength(1);
    expect(store.habitCheckins()).toHaveLength(1);
    store.clear();
    expect(store.habits()).toHaveLength(0);
    expect(store.habitCheckins()).toHaveLength(0);
  });
  it('does not publish a late cloud check-in after signout', async () => {
    await library.saveHabit('h', habit);
    const h = store.habits()[0],
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.checkin(h, library.today(), true);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.habitCheckins()).toHaveLength(0);
  });
});
