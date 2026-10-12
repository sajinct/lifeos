import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { Reminders } from './reminders';
import { DEFAULT_REMINDERS } from '../models/domain';
import { Notification } from '../models/domain';
import { User } from '@supabase/supabase-js';
import { Backend } from '../supabase/client';
import { reminderClock, reminderPhase } from '../../shared/utilities/reminders';

describe('Personal reminders and demo lifecycle', () => {
  let store: LifeStore;
  let reminders: Reminders;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    reminders = TestBed.inject(Reminders);
  });
  async function enable() {
    await reminders.save({
      ...DEFAULT_REMINDERS,
      task_reminders: true,
      bill_reminders: true,
      task_lead_days: 30,
      bill_lead_days: 30,
      reminder_hour: 0,
    });
    TestBed.tick();
  }
  it('defaults to opt-in and rejects invalid timing and time zones', async () => {
    TestBed.tick();
    expect(reminders.visible()).toEqual([]);
    await expect(reminders.save({ ...DEFAULT_REMINDERS, reminder_hour: 24 })).rejects.toThrow(
      /timing/,
    );
    await expect(reminders.save({ ...DEFAULT_REMINDERS, task_lead_days: 0.5 })).rejects.toThrow(
      /timing/,
    );
    await expect(
      reminders.save({ ...DEFAULT_REMINDERS, reminder_timezone: 'Unknown/Zone' }),
    ).rejects.toThrow();
  });
  it('uses local calendar dates through midnight and daylight saving transitions', () => {
    expect(reminderClock(new Date('2026-10-12T00:30:00Z'), 'America/Los_Angeles')).toEqual({
      day: '2026-10-11',
      hour: 17,
    });
    expect(reminderClock(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toEqual({
      day: '2026-03-08',
      hour: 3,
    });
    expect(reminderClock(new Date('2026-10-11T20:00:00Z'), 'Asia/Kolkata')).toEqual({
      day: '2026-10-12',
      hour: 1,
    });
  });
  it('separates upcoming and overdue occurrences across month boundaries', () => {
    const source = {
      id: 'a',
      workspace_id: 'demo',
      owner_id: 'demo-user',
      kind: 'task' as const,
      title: 'Task',
      date: '2026-03-01',
      days: 1,
    };
    expect(reminderPhase(source, '2026-02-27')).toBeNull();
    expect(reminderPhase(source, '2026-02-28')).toBe('upcoming');
    expect(reminderPhase(source, '2026-03-02')).toBe('overdue');
  });
  it('snoozes without duplicating and returns unread at the chosen time', async () => {
    await enable();
    const n = reminders.visible()[0];
    const count = store.notifications().length;
    await reminders.act(n, 'snooze', 60);
    expect(reminders.visible().some((row) => row.id === n.id)).toBe(false);
    reminders.now.set(Date.now() + 61 * 60000);
    TestBed.tick();
    expect(reminders.visible().find((row) => row.id === n.id)?.read_at).toBeNull();
    expect(store.notifications().length).toBe(count);
    await reminders.act(
      store.notifications().find((row) => row.id === n.id)!,
      'dismiss',
    );
    reminders.now.set(Date.now() + 62 * 60000);
    TestBed.tick();
    expect(reminders.visible().some((row) => row.id === n.id)).toBe(false);
  });
  it('clears completed sources and keeps notifications in their own workspace/session', async () => {
    await enable();
    const first = store.workspace()!;
    const n = reminders.visible().find((row) => row.source_kind === 'task')!;
    store.tasks.update((rows) =>
      rows.map((row) => (row.id === n.source_id ? { ...row, status: 'done' } : row)),
    );
    TestBed.tick();
    expect(reminders.visible().some((row) => row.id === n.id)).toBe(false);
    const remaining = reminders.visible().length;
    await store.createWorkspace('Other', 'personal');
    TestBed.tick();
    expect(reminders.visible()).toEqual([]);
    await store.switchWorkspace(first);
    TestBed.tick();
    expect(reminders.visible().length).toBe(remaining);
    store.clear();
    TestBed.tick();
    expect(reminders.visible()).toEqual([]);
    expect(store.reminderPreferences()).toEqual(DEFAULT_REMINDERS);
  });
});

describe('Reminder source loading across session boundaries', () => {
  let store: LifeStore, reminders: Reminders;
  let resolveResponse: (value: unknown) => void;
  beforeEach(async () => {
    const pending = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    const query = { select: () => query, eq: () => query, maybeSingle: () => pending };
    TestBed.configureTestingModule({
      providers: [{ provide: Backend, useValue: { requireClient: () => ({ from: () => query }) } }],
    });
    const auth = TestBed.inject(AuthService);
    auth.demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    auth.user.set({ id: 'demo-user' } as User);
    auth.demo.set(false);
    reminders = TestBed.inject(Reminders);
  });
  function fixture() {
    const task = { ...store.tasks()[0], id: 'outside-loaded-window' };
    const notice: Notification = {
      ...task,
      title: 'Upcoming task',
      reminder_id: null,
      read_at: null,
      source_kind: 'task',
      source_id: task.id,
      occurrence_on: task.due_date,
      phase: 'upcoming',
      dismissed_at: null,
      snoozed_until: null,
    };
    return { task, notice };
  }
  it('loads an exact source outside the newest-record window', async () => {
    const { task, notice } = fixture();
    const operation = reminders.resolveSource(notice);
    resolveResponse({ data: task, error: null });
    expect(await operation).toBe(true);
    expect(store.tasks().find((t) => t.id === task.id)).toEqual(task);
  });
  it('drops a private source response after the user leaves that session', async () => {
    const { task, notice } = fixture();
    const operation = reminders.resolveSource(notice);
    store.clear();
    resolveResponse({ data: task, error: null });
    expect(await operation).toBe(false);
    expect(store.tasks()).toEqual([]);
    expect(reminders.error()).toBe('');
  });
});
