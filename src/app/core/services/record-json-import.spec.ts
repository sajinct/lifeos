import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { RecordJsonImporter } from './record-json-import';
import { parseRecordJson } from '../../shared/utilities/record-json-import';
describe('Tasks and Notes JSON validation and retry boundaries', () => {
  let store: LifeStore, importer: RecordJsonImporter;
  const file = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({
      projects: [{ id: 'source-project', title: 'Portable project' }],
      tasks: [
        {
          id: 'source-task',
          title: 'Imported task',
          status: 'in_progress',
          priority: 'high',
          due_date: '2027-01-01',
          project_id: 'source-project',
          owner_id: 'untrusted',
          visibility: 'workspace',
          assignee_id: 'untrusted',
          series_id: 'untrusted',
          list_id: 'untrusted',
        },
      ],
      notes: [
        {
          id: 'source-note',
          title: 'Imported note',
          body: '  Preserve this note\n<script>literal content</script>  ',
          project_id: 'source-project',
        },
      ],
      ...patch,
    });
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    importer = TestBed.inject(RecordJsonImporter);
  });
  async function request(text = file(), target: string | null = store.projects()[0].id) {
    const p = await importer.preview(text);
    p.mapping['source-project'] = target ?? 'none';
    return importer.prepare(p.source, p.mapping, p.links, new Set([0, 1]));
  }
  it('accepts LifeOS exports and reports omitted structures without importing ownership or sharing', () => {
    const source = parseRecordJson(file({ taskLists: [{ id: 'list' }] }));
    expect(source.rows[0].warnings).toHaveLength(2);
    expect(source.omitted).toEqual(['taskLists']);
    expect(source.rows[0].row).not.toHaveProperty('owner_id');
    expect(source.rows[0].row).not.toHaveProperty('assignee_id');
    expect(source.rows[1].row?.body).toContain('  Preserve');
  });
  it('rejects malformed shapes, oversized files, duplicate IDs and ambiguous project metadata', () => {
    for (const text of [
      '{',
      '[]',
      '{"tasks":{},"notes":[]}',
      '{"tasks":[],"notes":[]}',
      'x'.repeat(5 * 1024 * 1024 + 1),
      file({ tasks: [{ id: 'same' }, { id: 'same' }] }),
    ])
      expect(() => parseRecordJson(text)).toThrow();
    expect(
      parseRecordJson(file({ projects: [{ id: 'source-project' }, { id: 'source-project' }] }))
        .rows[0].error,
    ).toContain('Duplicate referenced project');
  });
  it('validates future due dates, statuses, field types and note content without trimming the body', () => {
    expect(parseRecordJson(file()).rows[0].row?.due_date).toBe('2027-01-01');
    for (const patch of [
      { status: 'cancelled' },
      { priority: 'urgent' },
      { due_date: '2024-02-30' },
      { due_date: '2101-01-01' },
      { title: '' },
      { project_id: 23 },
    ])
      expect(
        parseRecordJson(
          file({
            tasks: [
              {
                id: 'bad',
                title: 'Bad task',
                status: 'todo',
                priority: 'low',
                due_date: null,
                ...patch,
              },
            ],
          }),
        ).rows[0].row,
      ).toBeNull();
    for (const body of [23, 'x'.repeat(100001), 'bad\0text'])
      expect(
        parseRecordJson(file({ tasks: [], notes: [{ id: 'bad-note', title: 'Bad', body }] }))
          .rows[0].row,
      ).toBeNull();
  });
  it('requires explicit project mapping or unlinking and rejects another user’s private project', async () => {
    const p = await importer.preview(file());
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('unmapped');
    p.mapping['source-project'] = 'none';
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('ready');
    store.projects.update((list) =>
      list.map((p) => ({ ...p, owner_id: 'other', visibility: 'private' })),
    );
    p.mapping['source-project'] = store.projects()[0].id;
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('invalid');
  });
  it('creates only private standalone tasks and preserves literal note content on stable retries', async () => {
    const r = await request(),
      before = store.tasks().length;
    expect(await importer.save(r)).toEqual({ tasks_imported: 1, notes_imported: 1, skipped: 0 });
    expect(await importer.save(r)).toEqual({ tasks_imported: 1, notes_imported: 1, skipped: 0 });
    expect(store.tasks().length).toBe(before + 1);
    expect(store.tasks().at(-1)).toMatchObject({
      owner_id: 'demo-user',
      visibility: 'private',
      assignee_id: null,
      list_id: null,
      series_id: null,
      revision: 1,
      status: 'in_progress',
      priority: 'high',
    });
    expect(store.notes().at(-1)?.body).toBe(
      '  Preserve this note\n<script>literal content</script>  ',
    );
    await expect(importer.save({ ...r, payload: { ...r.payload, rows: [] } })).rejects.toThrow(
      /request reused/,
    );
  });
  it('keeps saved destinations and flags changed source IDs without overwriting local edits', async () => {
    await importer.save(await request());
    const imported = store.tasks().at(-1)!;
    store.tasks.update((list) =>
      list.map((t) => (t.id === imported.id ? { ...t, status: 'done' } : t)),
    );
    const note = store.notes().at(-1)!;
    await store.deleteNote(note);
    const p = await importer.preview(file());
    expect(p.mapping['source-project']).toBe(store.projects()[0].id);
    expect(importer.review(p.source, p.mapping, p.links).map((r) => r.state)).toEqual([
      'duplicate',
      'duplicate',
    ]);
    p.source.rows[0].row!.title = 'Changed';
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('invalid');
    expect(store.tasks().at(-1)?.status).toBe('done');
  });
  it('rolls back preceding demo rows and project bindings when a later row fails', async () => {
    const r = await request();
    r.payload.rows[1].body = 'x'.repeat(100001);
    const tasks = store.tasks(),
      notes = store.notes();
    await expect(importer.save(r)).rejects.toThrow(/Note content/);
    expect(store.tasks()).toEqual(tasks);
    expect(store.notes()).toEqual(notes);
    expect((await importer.preview(file())).links).toEqual([]);
  });
  it('treats identical private rows as duplicates and shared rows as private-copy candidates', async () => {
    const p = await importer.preview(
      file({
        projects: [],
        tasks: [],
        notes: [
          { id: 'one', title: 'Same', body: 'Body' },
          { id: 'two', title: 'Same', body: 'Body' },
        ],
      }),
    );
    expect(importer.review(p.source, p.mapping, p.links).map((r) => r.state)).toEqual([
      'ready',
      'duplicate',
    ]);
    const existing = store.notes()[0];
    store.notes.update((list) => list.map((n) => ({ ...n, visibility: 'workspace' })));
    const copy = await importer.preview(
      file({ projects: [], tasks: [], notes: [{ ...existing }] }),
    );
    expect(importer.review(copy.source, copy.mapping, copy.links)[0].state).toBe('ready');
  });
  it('retains demo source bindings across workspace switches and clears them on session reset', async () => {
    const original = store.workspace()!;
    await importer.save(await request());
    await store.createWorkspace('Other', 'personal');
    await store.switchWorkspace(original);
    expect((await importer.preview(file())).links.length).toBeGreaterThan(0);
    await store.initialize();
    expect((await importer.preview(file())).links).toEqual([]);
  });
  it('ignores late cloud responses after sign-out and supports retry after failed refresh', async () => {
    const r = await request(),
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    const rpc = vi.fn().mockResolvedValue({
      data: { tasks_imported: 1, notes_imported: 1, skipped: 0 },
      error: null,
    });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    const reload = vi
      .spyOn(store, 'switchWorkspace')
      .mockImplementationOnce(async () => {
        store.members.set([]);
        store.error.set('Offline');
      })
      .mockImplementationOnce(async () => {
        store.error.set('');
      });
    await expect(importer.save(r)).rejects.toThrow(/refresh failed/);
    expect((await importer.save(r)).tasks_imported).toBe(1);
    expect(rpc.mock.calls[0][1].entry).toBe(rpc.mock.calls[1][1].entry);
    let finish!: (v: unknown) => void;
    rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = importer.save(r);
    store.clear();
    finish({ data: { tasks_imported: 1, notes_imported: 1, skipped: 0 }, error: null });
    await pending;
    expect(reload).toHaveBeenCalledTimes(2);
    expect(store.notes()).toEqual([]);
  });
  it('loads older notes beyond the first page while retaining newest-first display order', async () => {
    const auth = TestBed.inject(AuthService),
      workspace = store.workspace()!,
      base = store.notes()[0];
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    const notes = Array.from({ length: 501 }, (_, i) => ({
      ...base,
      id: `note-${i}`,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: i === 500 ? '2025-01-01T00:00:00Z' : '2024-01-01T00:00:00Z',
    }));
    const ranges: number[] = [];
    function builder(table: string) {
      const result = { data: table === 'notes' ? notes.slice(0, 500) : [], error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => Promise.resolve(result),
        range: (from: number, to: number) => {
          if (table === 'notes') ranges.push(from);
          return Promise.resolve({
            data: table === 'notes' ? notes.slice(from, to + 1) : [],
            error: null,
          });
        },
        then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    }
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      from: (table: string) => builder(table),
      rpc: () => builder('members'),
    } as never);
    await store.switchWorkspace(workspace);
    expect(store.error()).toBe('');
    expect(store.notes()).toHaveLength(501);
    expect(store.notes()[0].id).toBe('note-500');
    expect(ranges).toEqual([0, 500]);
  });
});
