import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { TaskLibrary } from './tasks';
describe('Task organization and safe repeat generation', () => {
  let store: LifeStore, library: TaskLibrary;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(TaskLibrary);
  });
  async function organize() {
    const id = crypto.randomUUID();
    await library.saveList(id, 'Work');
    const t = store.tasks()[0];
    store.tasks.update((rows) =>
      rows.map((r) => (r.id === t.id ? { ...r, due_date: '2026-01-31' } : r)),
    );
    await library.configure(store.tasks()[0], id, 'monthly');
    return store.tasks()[0];
  }
  it('replays list requests and rejects stale metadata edits', async () => {
    const id = crypto.randomUUID();
    await library.saveList(id, 'Work');
    const old = store.taskLists()[0];
    await library.saveList(id, 'Ignored', true);
    expect(store.taskLists()[0].name).toBe('Work');
    await library.saveList(id, 'Focus', false, old);
    await expect(library.saveList(id, 'Stale', false, old)).rejects.toThrow(/changed/);
  });
  it('copies all steps unchecked exactly once and preserves the original month anchor', async () => {
    const t = await organize();
    const id = crypto.randomUUID();
    await library.saveItem(id, t, 'Review', true);
    await store.setTaskStatus(t, 'done');
    await store.setTaskStatus(t, 'done');
    let rows = store.tasks().filter((r) => r.series_id === t.series_id);
    expect(rows).toHaveLength(2);
    const next = rows.find((r) => r.occurrence_index === 1)!;
    expect(next.due_date).toBe('2026-02-28');
    expect(store.taskChecklist().find((i) => i.task_id === next.id)?.done).toBe(false);
    await store.setTaskStatus(next, 'done');
    rows = store.tasks().filter((r) => r.series_id === t.series_id);
    expect(rows.find((r) => r.occurrence_index === 2)?.due_date).toBe('2026-03-31');
  });
  it('rejects stale reversals and keeps an existing successor after reopening', async () => {
    const t = await organize();
    await store.setTaskStatus(t, 'done');
    await expect(store.setTaskStatus(t, 'todo')).rejects.toThrow(/changed/);
    const done = store.tasks().find((r) => r.id === t.id)!;
    await store.setTaskStatus(done, 'todo');
    await store.setTaskStatus(
      store.tasks().find((r) => r.id === t.id)!,
      'done',
    );
    expect(store.tasks().filter((r) => r.series_id === t.series_id)).toHaveLength(2);
  });
  it('pauses, completes and resumes with one missing successor', async () => {
    const t = await organize();
    const series = store.taskSeries()[0];
    await library.setRepeat(series, false);
    await store.setTaskStatus(t, 'done');
    expect(store.tasks().filter((r) => r.series_id === series.id)).toHaveLength(1);
    const paused = store.taskSeries()[0];
    await library.setRepeat(paused, true);
    await library.setRepeat(paused, true);
    expect(store.tasks().filter((r) => r.series_id === series.id)).toHaveLength(2);
    await expect(library.setRepeat(series, false)).rejects.toThrow(/changed/);
  });
  it('validates private bindings, date, list archives and fixed series configuration', async () => {
    const t = await organize();
    await expect(library.configure(t, '', 'daily')).rejects.toThrow(/one-off/);
    await expect(library.configure({ ...t, visibility: 'workspace' }, '', '')).rejects.toThrow(
      /private/,
    );
    await expect(
      library.configure({ ...store.tasks()[1], due_date: '2026-02-30' }, '', 'weekly'),
    ).rejects.toThrow(/valid due date/);
    const list = store.taskLists()[0];
    await library.saveList(list.id, list.name, true, list);
    await expect(library.configure(store.tasks()[1], list.id, '')).rejects.toThrow(/active list/);
  });
  it('edits checklist titles, safely replays creates and removes only current revisions', async () => {
    const t = store.tasks()[0],
      id = crypto.randomUUID();
    await library.saveItem(id, t, 'Draft');
    const item = store.taskChecklist()[0];
    await library.saveItem(id, t, 'Ignored', true);
    expect(store.taskChecklist()[0].title).toBe('Draft');
    await library.saveItem(id, t, 'Review', true, item);
    await expect(library.removeItem(item)).rejects.toThrow(/changed/);
    await expect(library.saveItem(id, t, 'Review', false, item)).rejects.toThrow(/changed/);
    await library.removeItem(store.taskChecklist()[0]);
    await library.removeItem(item);
    expect(store.taskChecklist()).toHaveLength(0);
  });
  it('keeps completion independent and freezes checklist edits until reopen', async () => {
    const t = store.tasks()[0];
    await library.saveItem(crypto.randomUUID(), t, 'Step', true);
    expect(store.tasks()[0].status).toBe('todo');
    await store.setTaskStatus(t, 'done');
    await expect(library.saveItem(crypto.randomUUID(), store.tasks()[0], 'Late')).rejects.toThrow(
      /Reopen/,
    );
  });
  it('isolates workspace caches and clears tasks and organization on sign-out', async () => {
    const t = await organize();
    await library.saveItem(crypto.randomUUID(), t, 'Step');
    const personal = store.workspace()!;
    await store.createWorkspace('Other', 'professional');
    expect(store.tasks()).toHaveLength(0);
    expect(store.taskLists()).toHaveLength(0);
    expect(store.taskChecklist()).toHaveLength(0);
    await store.switchWorkspace(personal);
    expect(store.taskLists()).toHaveLength(1);
    expect(store.taskSeries()).toHaveLength(1);
    expect(store.taskChecklist()).toHaveLength(1);
    store.clear();
    expect(store.tasks()).toHaveLength(0);
    expect(store.taskSeries()).toHaveLength(0);
  });
  it('does not republish a late cloud completion after sign-out', async () => {
    const t = store.tasks()[0],
      auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'demo-user' } as User);
    auth.demo.set(false);
    let resolve!: (v: { error: null }) => void;
    const pending = new Promise<{ error: null }>((r) => (resolve = r));
    const backend = TestBed.inject(Backend);
    vi.spyOn(backend, 'requireClient').mockReturnValue({
      rpc: () => pending,
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const completion = store.setTaskStatus(t, 'done');
    store.clear();
    auth.user.set(null);
    resolve({ error: null });
    await completion;
    expect(reload).not.toHaveBeenCalled();
    expect(store.tasks()).toHaveLength(0);
  });
  it('stops daily repeats at the supported end date', async () => {
    const t = store.tasks()[0];
    store.tasks.update((rows) =>
      rows.map((r) => (r.id === t.id ? { ...r, due_date: '2100-12-31' } : r)),
    );
    await library.configure(store.tasks()[0], '', 'daily');
    await store.setTaskStatus(store.tasks()[0], 'done');
    expect(store.taskSeries()[0].active).toBe(false);
    expect(store.tasks().filter((r) => r.series_id)).toHaveLength(1);
  });
});
