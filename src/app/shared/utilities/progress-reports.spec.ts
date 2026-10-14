import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { ProgressData, ProgressFilter, progressCsv, progressReport } from './progress-reports';
import { LearningLibrary } from '../../core/services/learning';
describe('Owner-private progress reports and dated activity', () => {
  let store: LifeStore, data: ProgressData, f: ProgressFilter;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    const library = TestBed.inject(LearningLibrary),
      id = crypto.randomUUID();
    await library.save(crypto.randomUUID(), id, {
      kind: 'course',
      title: 'Course',
      provider: '',
      url: '',
      goal: '',
      due_on: '2026-10-31',
      notes: '',
      note_ids: [],
      document_ids: [],
      certificate_ids: [],
    });
    const base = {
      workspace_id: store.workspace()!.id,
      owner_id: store.profile()!.id,
      visibility: 'private' as const,
      created_at: '2026-10-01',
      updated_at: '2026-10-01',
    };
    data = {
      tasks: store.tasks(),
      projects: store.projects(),
      goals: store.goals(),
      learning: store.learningItems(),
      units: [],
      times: [
        {
          ...base,
          id: 'time',
          task_id: null,
          task_title: 'Work',
          project_id: 'p1',
          project_title: 'Project snapshot',
          mode: 'manual',
          status: 'recorded',
          logged_on: '2026-10-14',
          seconds: 5400,
          started_at: null,
          ended_at: null,
          notes: '',
          revision: 1,
        },
      ],
    };
    f = {
      workspace: base.workspace_id,
      user: base.owner_id,
      from: '2026-10-01',
      to: '2026-10-31',
      today: '2026-10-14',
    };
  });
  it('treats current tasks/projects as snapshots independent of selected dates', () => {
    const a = progressReport(data, f),
      b = progressReport(data, { ...f, from: '2020-01-01', to: '2020-01-31' });
    expect(a.snapshot).toEqual(b.snapshot);
    expect(a.snapshot.tasks).toBe(data.tasks.length);
    expect(a.period.seconds).toBe(5400);
    expect(b.period.seconds).toBe(0);
  });
  it('excludes another user’s shared records and other workspaces from every report section', () => {
    const original = progressReport(data, f);
    for (const key of ['tasks', 'projects', 'goals', 'learning', 'units', 'times'] as const) {
      const own = data[key];
      data[key] = [
        ...own,
        ...own.map((r) => ({
          ...r,
          id: 'other-' + r.id,
          owner_id: 'another',
          visibility: 'workspace',
        })),
        ...own.map((r) => ({ ...r, id: 'foreign-' + r.id, workspace_id: 'another' })),
      ] as never;
    }
    expect(progressReport(data, f)).toEqual(original);
  });
  it('excludes running/discarded time and includes both inclusive date endpoints', () => {
    const time = data.times[0];
    data.times = [
      time,
      { ...time, id: 'running', status: 'running' },
      { ...time, id: 'void', status: 'void' },
      { ...time, id: 'start', logged_on: f.from, seconds: 60 },
      { ...time, id: 'end', logged_on: f.to, seconds: 120 },
      { ...time, id: 'outside', logged_on: '2026-11-01' },
    ];
    const r = progressReport(data, f);
    expect(r.period).toMatchObject({ seconds: 5580, entries: 3 });
    expect(r.timeGroups).toHaveLength(1);
    expect(r.timeGroups[0].seconds).toBe(5580);
  });
  it('includes archived completed learning in dated counts but excludes reopened items and archived lessons from current progress', () => {
    const i = data.learning[0],
      base = {
        workspace_id: i.workspace_id,
        owner_id: i.owner_id,
        visibility: 'private' as const,
        created_at: i.created_at,
        updated_at: i.updated_at,
      };
    data.learning = [
      i,
      { ...i, id: 'completed', status: 'completed', completed_on: '2026-10-01', archived: true },
      { ...i, id: 'reopened', status: 'active', completed_on: null },
    ];
    data.units = [
      {
        ...base,
        id: 'done',
        item_id: i.id,
        title: 'Done',
        notes: '',
        position: 1,
        done: true,
        archived: false,
        revision: 1,
      },
      {
        ...base,
        id: 'archived',
        item_id: i.id,
        title: 'Archived',
        notes: '',
        position: 2,
        done: false,
        archived: true,
        revision: 1,
      },
    ];
    const r = progressReport(data, f);
    expect(r.period.completed).toBe(1);
    expect(r.learning).toHaveLength(2);
    expect(r.learning[0].progress).toEqual({ total: 1, done: 1, percent: 100 });
    expect(r.completed[0].archived).toBe(true);
  });
  it('zero-fills months and keeps goal units separate', () => {
    const r = progressReport(data, { ...f, from: '2026-09-01', to: '2026-11-30' });
    expect(r.months.map((m) => m.seconds)).toEqual([0, 5400, 0]);
    expect(r.goals.map((g) => g.unit)).toEqual(data.goals.map((g) => g.unit));
  });
  it('rejects invalid or excessive ranges instead of exporting misleading totals', () => {
    expect(() => progressReport(data, { ...f, from: '2026-02-30' })).toThrow(/valid/);
    expect(() => progressReport(data, { ...f, from: '1900-01-01' })).toThrow(/120/);
    expect(() => progressReport(data, { ...f, from: '2026-11-01' })).toThrow(/valid/);
  });
  it('neutralizes formula-like labels in CSV and includes precise seconds, snapshot and completion sections', () => {
    data.times[0].task_title = '=formula()';
    const text = progressCsv(progressReport(data, f), f);
    expect(text).toContain("'=formula()");
    expect(text).toContain('5400');
    expect(text).toContain('current snapshot');
    expect(text).toContain('monthly learning completions');
  });
});
