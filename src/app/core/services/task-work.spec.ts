import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { TaskWork } from './task-work';
import { TaskTime } from '../models/domain';
import {
  duration,
  manualSeconds,
  timerSeconds,
  timeCsv,
  timeSummary,
} from '../../shared/utilities/task-time';
describe('Personal time and shared-task assignments', () => {
  let store: LifeStore, work: TaskWork;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    work = TestBed.inject(TaskWork);
  });
  it('assigns shared tasks without giving edit access and checks current memberships', async () => {
    const t = store.tasks()[0];
    await expect(work.assign(t, 'demo-user')).rejects.toThrow(/shared task/);
    store.tasks.update((rows) =>
      rows.map((r) => (r.id === t.id ? { ...r, visibility: 'workspace' } : r)),
    );
    const shared = store.tasks()[0];
    await work.assign(shared, 'demo-user');
    expect(store.tasks()[0].assignee_id).toBe('demo-user');
    await work.assign(shared, 'demo-user');
    await expect(work.assign(shared, 'missing')).rejects.toThrow(/current workspace member/);
    await expect(work.assign(shared, '')).rejects.toThrow(/changed/);
    await work.assign(store.tasks()[0], '');
    expect(store.tasks()[0].assignee_id).toBeNull();
  });
  it('validates whole minutes, real dates, future dates and notes', async () => {
    for (const value of ['0', '-1', '1.5', '1441', 'NaN', '1e2'])
      expect(() => manualSeconds(value)).toThrow();
    expect(manualSeconds('1440')).toBe(86400);
    await expect(work.manual('bad', store.tasks()[0], '2026-02-30', '30', '')).rejects.toThrow(
      /date/,
    );
    await expect(work.manual('future', store.tasks()[0], '2100-12-31', '30', '')).rejects.toThrow(
      /date/,
    );
    await expect(work.start('notes', store.tasks()[0], 'x'.repeat(2001))).rejects.toThrow(/2000/);
  });
  it('replays manual creation, rejects stale edits and preserves title/project snapshots', async () => {
    const t = store.tasks()[0];
    await work.manual('manual', t, work.today(), '30', 'Review');
    const old = store.taskTimes()[0];
    await work.manual('manual', t, work.today(), '90', 'Ignored');
    expect(store.taskTimes()[0].seconds).toBe(1800);
    store.tasks.update((rows) =>
      rows.map((r) => (r.id === t.id ? { ...r, title: 'Changed title' } : r)),
    );
    await work.manual('manual', store.tasks()[0], work.today(), '45', 'Revised', old);
    expect(store.taskTimes()[0].task_title).toBe(t.title);
    await expect(work.manual('manual', t, work.today(), '60', 'Stale', old)).rejects.toThrow(
      /changed/,
    );
  });
  it('permits one timer per workspace and never restarts a replayed stopped request', async () => {
    const t = store.tasks()[0];
    await work.start('timer', t, 'Focus');
    await work.start('timer', t, 'Ignored');
    await expect(work.start('other', t, '')).rejects.toThrow(/running timer/);
    const timer = store.taskTimes()[0];
    await work.action(timer, 'stop');
    await work.action(timer, 'stop');
    expect(store.taskTimes()[0].revision).toBe(2);
    expect(store.taskTimes()[0].seconds).toBeGreaterThan(0);
    await work.start('timer', t, 'Ignored');
    expect(store.taskTimes()[0].status).toBe('recorded');
  });
  it('keeps clocks accurate after reload-like state changes and caps elapsed time at 24 hours', async () => {
    await work.start('timer', store.tasks()[0], '');
    const timer = { ...store.taskTimes()[0], started_at: '2026-10-11T10:00:00Z' };
    expect(timerSeconds(timer, Date.parse('2026-10-11T10:01:30Z'))).toBe(90);
    expect(timerSeconds(timer, Date.parse('2026-10-13T10:00:00Z'))).toBe(86400);
    expect(duration(3661)).toBe('01:01:01');
    expect(duration(86400)).toBe('24:00:00');
    timer.started_at = new Date(Date.now() - 2 * 86400000).toISOString();
    store.taskTimes.set([timer]);
    await work.action(timer, 'stop');
    expect(store.taskTimes()[0].seconds).toBe(86400);
  });
  it('discards and restores sessions while protecting newer actions', async () => {
    await work.manual('manual', store.tasks()[0], work.today(), '30', '');
    const entry = store.taskTimes()[0];
    await work.action(entry, 'void');
    await work.action(entry, 'void');
    await expect(work.action(entry, 'restore')).rejects.toThrow(/changed/);
    await work.action(store.taskTimes()[0], 'restore');
    expect(store.taskTimes()[0].status).toBe('recorded');
    expect(store.taskTimes()[0].seconds).toBe(1800);
  });
  it('summarizes only recorded sessions by task/project and escapes CSV formulas', async () => {
    await work.manual('one', store.tasks()[0], work.today(), '30', '=formula');
    await work.manual('two', store.tasks()[0], work.today(), '45', 'Notes');
    await work.manual('void', store.tasks()[1], work.today(), '60', '');
    await work.action(
      store.taskTimes().find((e) => e.id === 'void')!,
      'void',
    );
    await work.start('running', store.tasks()[0], '');
    const rows = store.taskTimes();
    expect(timeSummary(rows, 'task')[0]).toMatchObject({ seconds: 4500, sessions: 2 });
    expect(timeSummary(rows, 'project')[0].seconds).toBe(4500);
    expect(timeCsv(rows)).toContain("'=formula");
    expect(timeCsv(rows)).toContain('01:00:00');
  });
  it('keeps personal time in workspace caches and clears it on sign-out', async () => {
    await work.manual('manual', store.tasks()[0], work.today(), '30', '');
    const original = store.workspace()!;
    await store.createWorkspace('Other work', 'professional');
    expect(store.taskTimes()).toHaveLength(0);
    expect(store.taskMembers()).toHaveLength(1);
    await store.switchWorkspace(original);
    expect(store.taskTimes()).toHaveLength(1);
    store.clear();
    expect(store.taskTimes()).toHaveLength(0);
    expect(store.taskMembers()).toHaveLength(0);
  });
  it('does not republish a late timer start after sign-out', async () => {
    const t = store.tasks()[0],
      auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'demo-user' } as User);
    auth.demo.set(false);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = work.start('request', t, '');
    store.clear();
    auth.user.set(null);
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.taskTimes()).toHaveLength(0);
  });
  it('lets a manual snapshot remain editable after its task is unavailable', async () => {
    const task = store.tasks()[0];
    await work.manual('manual', task, work.today(), '30', '');
    store.tasks.set([]);
    const entry = store.taskTimes()[0];
    await work.manual(entry.id, null, work.today(), '40', 'History', entry);
    expect(store.taskTimes()[0].task_title).toBe(task.title);
    expect(store.taskTimes()[0].seconds).toBe(2400);
  });
  it('enforces ownership for time actions even within a shared workspace', async () => {
    const other = { workspace_id: 'demo', owner_id: 'someone-else' } as TaskTime;
    await expect(work.action(other, 'void')).rejects.toThrow(/inaccessible/);
  });
});
