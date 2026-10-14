import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { LearningLibrary } from './learning';
import { FileLibrary } from './file-library';
import { LearningInput, LearningUnit } from '../models/domain';
import { learningCsv, validateLearning } from '../../shared/utilities/learning';
describe('Learning progress, private sources and retry safety', () => {
  let store: LifeStore, library: LearningLibrary;
  const input: LearningInput = {
    kind: 'course',
    title: ' SQL foundations ',
    provider: ' Open learning ',
    url: 'https://example.com/@sql',
    goal: 'Learn data modeling',
    due_on: '2026-12-31',
    notes: '  <script>literal</script>  ',
    note_ids: [],
    document_ids: [],
    certificate_ids: [],
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(LearningLibrary);
  });
  function row(id: string) {
    return store.learningItems().find((i) => i.id === id)!;
  }
  function lesson(id: string) {
    return store.learningUnits().find((u) => u.id === id)!;
  }
  async function create(v = input) {
    const id = crypto.randomUUID();
    await library.save(crypto.randomUUID(), id, v);
    return id;
  }
  async function add(item: string, done = false) {
    const id = crypto.randomUUID();
    await library.unit(crypto.randomUUID(), id, row(item), 'First lesson', 'Lesson notes', done);
    return id;
  }
  async function change(
    item: string,
    id: string,
    done: boolean,
    archived = false,
    old: LearningUnit = lesson(id),
  ) {
    await library.unit(
      crypto.randomUUID(),
      id,
      row(item),
      old.title,
      old.notes,
      done,
      archived,
      old,
    );
  }
  it('validates URL credentials, deadlines and bounds while preserving literal notes', () => {
    expect(validateLearning(input)).toMatchObject({
      title: 'SQL foundations',
      provider: 'Open learning',
      notes: input.notes,
    });
    for (const url of [
      'javascript:alert(1)',
      'https://user:password@example.com',
      'not a URL',
      'https://example.com/space here',
    ])
      expect(() => validateLearning({ ...input, url })).toThrow(/HTTP/);
    for (const changes of [
      { due_on: '2026-02-30' },
      { due_on: '2101-01-01' },
      { goal: 'x'.repeat(1001) },
      { title: ' ' },
      { notes: 'x'.repeat(4001) },
    ])
      expect(() => validateLearning({ ...input, ...changes })).toThrow(/valid learning/);
    expect(() =>
      validateLearning({ ...input, document_ids: ['same'], certificate_ids: ['same'] }),
    ).toThrow(/one purpose/);
  });
  it('creates once and rejects changed retry payloads or conflicting edits', async () => {
    const id = crypto.randomUUID(),
      request = crypto.randomUUID();
    await library.save(request, id, input);
    await library.save(request, id, input);
    expect(store.learningItems()).toHaveLength(1);
    expect(row(id).revision).toBe(1);
    await expect(library.save(request, id, { ...input, title: 'Changed' })).rejects.toThrow(
      /another change/,
    );
    const old = row(id);
    await library.save(crypto.randomUUID(), id, { ...input, title: 'Updated' }, old);
    await expect(library.save(crypto.randomUUID(), id, input, old)).rejects.toThrow(/changed/);
  });
  it('uses parent revisions for lesson creation and exact retries', async () => {
    const item = await create(),
      old = row(item),
      id = crypto.randomUUID(),
      request = crypto.randomUUID();
    await library.unit(request, id, old, 'First', '', false);
    await library.unit(request, id, old, 'First', '', false);
    expect(store.learningUnits()).toHaveLength(1);
    expect(row(item).revision).toBe(2);
    await expect(
      library.unit(crypto.randomUUID(), crypto.randomUUID(), old, 'Other', '', false),
    ).rejects.toThrow(/changed/);
    await expect(library.save(crypto.randomUUID(), item, input, old)).rejects.toThrow(/changed/);
  });
  it('completes on the last lesson, reopens unfinished additions and excludes archived lessons', async () => {
    const item = await create(),
      id = await add(item);
    expect(library.progress(row(item))).toEqual({ total: 1, done: 0, percent: 0 });
    await change(item, id, true);
    expect(row(item).status).toBe('completed');
    expect(library.progress(row(item)).percent).toBe(100);
    const second = await add(item);
    expect(row(item)).toMatchObject({ status: 'active', completed_on: null });
    expect(library.progress(row(item)).percent).toBe(50);
    await change(item, second, false, true);
    expect(row(item).status).toBe('completed');
    await change(item, second, false, false);
    expect(row(item).status).toBe('active');
    await expect(library.state(crypto.randomUUID(), row(item), 'completed')).rejects.toThrow(
      /remaining lessons/,
    );
  });
  it('preserves progress on pause/archive, supports safe restore and rejects stale reversals', async () => {
    const item = await create(),
      id = await add(item),
      old = row(item),
      request = crypto.randomUUID();
    await library.state(request, old, 'paused');
    await library.state(request, old, 'paused');
    expect(row(item).revision).toBe(old.revision + 1);
    await expect(add(item)).rejects.toThrow(/resume/);
    await library.state(crypto.randomUUID(), row(item), 'active');
    await library.state(crypto.randomUUID(), row(item), 'active', true);
    await expect(library.save(crypto.randomUUID(), item, input, row(item))).rejects.toThrow(
      /Restore/,
    );
    await expect(library.state(crypto.randomUUID(), old, 'active', false)).rejects.toThrow(
      /changed/,
    );
    await library.state(crypto.randomUUID(), row(item), 'active', false);
    expect(lesson(id).notes).toBe('Lesson notes');
  });
  it('supports manual completion of untracked resources and keeps zero-lesson progress meaningful', async () => {
    const item = await create({ ...input, kind: 'resource' });
    expect(library.progress(row(item)).percent).toBe(0);
    await library.state(crypto.randomUUID(), row(item), 'completed');
    expect(library.progress(row(item)).percent).toBe(100);
    await library.state(crypto.randomUUID(), row(item), 'active');
    expect(row(item).completed_on).toBeNull();
    expect(library.progress(row(item)).percent).toBe(0);
  });
  it('links owned note and certificate versions and keeps source data when unlinked', async () => {
    const files = TestBed.inject(FileLibrary),
      file = await files.upload(
        new File(['hello'], 'certificate.txt', { type: 'text/plain' }),
        'personal-documents',
        { category: 'Learning', expires_on: '', project_id: '', transaction_id: '' },
      ),
      note = store.notes()[0];
    const item = await create({ ...input, note_ids: [note.id], certificate_ids: [file] });
    expect(library.linkedNotes(row(item))[0].id).toBe(note.id);
    expect(library.linkedFiles(row(item))[0].purpose).toBe('certificate');
    expect(store.learningDocuments()[0].visibility).toBe('private');
    await library.save(crypto.randomUUID(), item, { ...input, document_ids: [file] }, row(item));
    expect(library.linkedFiles(row(item))[0].purpose).toBe('reference');
    await library.save(crypto.randomUUID(), item, input, row(item));
    expect(library.linkedFiles(row(item))).toEqual([]);
    expect((await files.download(store.attachments()[0])).size).toBe(5);
    expect(store.notes().some((n) => n.id === note.id)).toBe(true);
    store.notes.set([{ ...note, owner_id: 'other', visibility: 'workspace' }]);
    await expect(create({ ...input, note_ids: [note.id] })).rejects.toThrow(/notes you own/);
    await expect(create({ ...input, certificate_ids: ['unknown'] })).rejects.toThrow(
      /own completed/,
    );
  });
  it('limits lessons including archives and protects another item’s lesson ID', async () => {
    const item = await create(),
      other = await create(),
      id = await add(item),
      old = lesson(id);
    await expect(
      library.unit(crypto.randomUUID(), id, row(other), old.title, old.notes, false, false, old),
    ).rejects.toThrow(/inaccessible/);
    store.learningUnits.set(
      Array.from({ length: 200 }, (_, i) => ({
        ...old,
        id: crypto.randomUUID(),
        position: i + 1,
        archived: true,
      })),
    );
    await expect(add(item)).rejects.toThrow(/200 lessons/);
  });
  it('isolates workspaces and clears private learning records on logout', async () => {
    const w = store.workspace()!,
      item = await create();
    await add(item);
    await store.createWorkspace('Other learning', 'personal');
    expect(store.learningItems()).toEqual([]);
    await store.switchWorkspace(w);
    expect(row(item)).toBeDefined();
    expect(store.learningUnits()).toHaveLength(1);
    store.clear();
    expect(store.learningItems()).toEqual([]);
    expect(store.learningUnits()).toEqual([]);
    expect(store.learningNotes()).toEqual([]);
    expect(store.learningDocuments()).toEqual([]);
  });
  it('blocks viewers and filters other owners even when cached rows are supplied', async () => {
    const item = await create(),
      old = row(item);
    store.learningItems.set([{ ...old, owner_id: 'other' }]);
    expect(library.items()).toEqual([]);
    await expect(library.state(crypto.randomUUID(), old, 'paused')).rejects.toThrow(/inaccessible/);
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    store.members.set([
      { workspace_id: store.workspace()!.id, user_id: store.profile()!.id, role: 'viewer' },
    ]);
    await expect(create()).rejects.toThrow(/write access/);
  });
  it('replays a cloud lesson safely after refresh clears records/membership', async () => {
    const item = await create(),
      old = row(item),
      request = crypto.randomUUID(),
      id = crypto.randomUUID(),
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    vi.spyOn(store, 'switchWorkspace')
      .mockImplementationOnce(async () => {
        store.members.set([]);
        store.learningItems.set([]);
        store.error.set('Offline');
      })
      .mockImplementationOnce(async () => {
        store.error.set('');
      });
    await expect(library.unit(request, id, old, 'Cloud lesson', '', false)).rejects.toThrow(
      /refresh failed/,
    );
    await library.unit(request, id, old, 'Cloud lesson', '', false);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('ignores late cloud responses after workspace changes', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    let complete!: (v: { error: null }) => void;
    const rpc = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          complete = resolve;
        }),
    );
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    const reload = vi.spyOn(store, 'switchWorkspace'),
      pending = library.save(crypto.randomUUID(), crypto.randomUUID(), input);
    store.workspace.set({ ...store.workspace()!, id: 'new-workspace' });
    complete({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.learningItems()).toEqual([]);
  });
  it('escapes CSV formulas and exports progress rather than file bytes', async () => {
    const item = await create({ ...input, title: '=FORMULA()' });
    await add(item);
    const output = learningCsv([row(item)], store.learningUnits());
    expect(output).toContain("'=FORMULA()");
    expect(output).toContain('lessons_done');
    expect(output).toContain('progress_percent');
  });
});
