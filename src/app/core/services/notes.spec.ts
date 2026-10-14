import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { NotesLibrary } from './notes';
import { FileLibrary } from './file-library';
import { NoteInput } from '../models/domain';
import { matchesNoteSearch, noteTags, validateNote } from '../../shared/utilities/notes';
import { RecordJsonImporter } from './record-json-import';
describe('Notes editing, journals, files and archive safety', () => {
  let store: LifeStore, library: NotesLibrary;
  const input: NoteInput = {
    title: 'Daily reflection',
    body: '  Literal <script>content</script>\nKeep this spacing.  ',
    project: '',
    tags: ['Ideas', ' work  notes ', 'ideas'],
    journal_on: '',
    visibility: 'private',
    documents: [],
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(NotesLibrary);
  });
  function row(id: string) {
    return store.notes().find((n) => n.id === id)!;
  }
  async function create(v = input) {
    const id = crypto.randomUUID();
    await library.save(crypto.randomUUID(), id, v);
    return id;
  }
  it('normalizes bounded tags, searches content and validates journals', () => {
    expect(noteTags(' Ideas, work   notes, ideas ')).toEqual(['ideas', 'work notes']);
    expect(() => noteTags('a,,b')).toThrow(/tags/);
    expect(() => noteTags('a'.repeat(31))).toThrow(/tags/);
    expect(() => validateNote({ ...input, body: 'x'.repeat(100001) })).toThrow(/valid note/);
    expect(() => validateNote({ ...input, journal_on: '2026-02-30' })).toThrow(/valid note/);
    expect(() =>
      validateNote({ ...input, journal_on: '2026-10-14', visibility: 'workspace' }),
    ).toThrow(/private/);
    expect(
      matchesNoteSearch(
        { ...store.notes()[0], title: 'Idea', body: 'Project reflection', tags: ['family'] },
        'FAMILY reflection',
      ),
    ).toBe(true);
  });
  it('creates exactly once, preserves literal content and rejects changed retry payloads', async () => {
    const id = crypto.randomUUID(),
      request = crypto.randomUUID();
    await library.save(request, id, input);
    await library.save(request, id, input);
    expect(store.notes().filter((n) => n.id === id)).toHaveLength(1);
    expect(row(id).body).toBe(input.body);
    expect(row(id).tags).toEqual(['ideas', 'work notes']);
    await expect(library.save(request, id, { ...input, title: 'Changed' })).rejects.toThrow(
      /another change/,
    );
  });
  it('edits legacy notes at revision one and rejects conflicting edits', async () => {
    const previous = store.notes()[0];
    await library.save(crypto.randomUUID(), previous.id, { ...input, title: 'Updated' }, previous);
    expect(row(previous.id).revision).toBe(2);
    await expect(
      library.save(crypto.randomUUID(), previous.id, { ...input, title: 'Stale' }, previous),
    ).rejects.toThrow(/changed/);
  });
  it('keeps one private journal per date, including archived entries', async () => {
    const journal = { ...input, journal_on: '2026-10-14' },
      id = await create(journal);
    await library.archive(crypto.randomUUID(), row(id), true);
    await expect(create(journal)).rejects.toThrow(/already exists/);
    expect(row(id).archived).toBe(true);
    await library.archive(crypto.randomUUID(), row(id), false);
    expect(row(id).journal_on).toBe('2026-10-14');
  });
  it('archives and restores exactly once without losing content or allowing stale reversals', async () => {
    const id = await create(),
      old = row(id),
      request = crypto.randomUUID();
    await library.archive(request, old, true);
    await library.archive(request, old, true);
    expect(row(id).revision).toBe(2);
    expect(row(id).body).toBe(input.body);
    await expect(library.archive(crypto.randomUUID(), old, false)).rejects.toThrow(/changed/);
    await expect(library.save(crypto.randomUUID(), id, input, row(id))).rejects.toThrow(/Restore/);
    await library.archive(crypto.randomUUID(), row(id), false);
    expect(row(id).archived).toBe(false);
  });
  it('uploads and links an owned private file version, retaining it after archive and unlink', async () => {
    const files = TestBed.inject(FileLibrary),
      fileId = await files.upload(
        new File(['hello'], 'journal.txt', { type: 'text/plain' }),
        'personal-documents',
        { category: 'Notes', expires_on: '', project_id: '', transaction_id: '' },
      );
    const id = await create({ ...input, documents: [fileId], visibility: 'workspace' });
    expect(library.links(row(id))).toHaveLength(1);
    expect(store.noteDocuments()[0].visibility).toBe('private');
    await library.archive(crypto.randomUUID(), row(id), true);
    expect((await files.download(library.links(row(id))[0])).size).toBe(5);
    await library.archive(crypto.randomUUID(), row(id), false);
    await library.save(crypto.randomUUID(), id, input, row(id));
    expect(library.links(row(id))).toEqual([]);
    expect(store.attachments()[0].id).toBe(fileId);
    await expect(create({ ...input, documents: ['inaccessible'] })).rejects.toThrow(
      /own completed/,
    );
  });
  it('does not allow a shared-note editor to change creator-only metadata', async () => {
    const old = store.notes()[0],
      shared = { ...old, owner_id: 'another-member', visibility: 'workspace' as const };
    store.notes.set([shared]);
    await expect(
      library.save(
        crypto.randomUUID(),
        shared.id,
        { ...input, visibility: 'private', documents: null },
        shared,
      ),
    ).rejects.toThrow(/Only the note creator/);
    await library.save(
      crypto.randomUUID(),
      shared.id,
      { ...input, visibility: 'workspace', documents: null },
      shared,
    );
    expect(row(shared.id).owner_id).toBe('another-member');
  });
  it('retains archives on unchanged JSON reuploads and never uses structured notes as plain duplicates', async () => {
    const importer = TestBed.inject(RecordJsonImporter),
      text = JSON.stringify({ notes: [{ id: 'portable-note', title: 'Portable', body: 'Body' }] });
    const p = await importer.preview(text),
      request = importer.prepare(p.source, p.mapping, p.links, new Set([0]));
    await importer.save(request);
    const note = store.notes().find((n) => n.title === 'Portable')!;
    await library.archive(crypto.randomUUID(), note, true);
    await importer.save(request);
    expect(row(note.id).archived).toBe(true);
    const p2 = await importer.preview(
      JSON.stringify({ notes: [{ id: note.id, title: note.title, body: note.body }] }),
    );
    expect(importer.review(p2.source, p2.mapping, p2.links)[0].state).toBe('invalid');
  });
  it('isolates demo notes and links across workspaces and blocks viewers in account mode', async () => {
    const w = store.workspace()!,
      id = await create();
    await store.createWorkspace('Other notes', 'personal');
    expect(row(id)).toBeUndefined();
    await store.switchWorkspace(w);
    expect(row(id)).toBeDefined();
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    store.members.set([{ workspace_id: w.id, user_id: store.profile()!.id, role: 'viewer' }]);
    await expect(create()).rejects.toThrow(/write access/);
  });
  it('replays the same cloud edit after a failed refresh clears cached membership and records', async () => {
    const auth = TestBed.inject(AuthService),
      previous = store.notes()[0],
      request = crypto.randomUUID();
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    vi.spyOn(store, 'switchWorkspace')
      .mockImplementationOnce(async () => {
        store.members.set([]);
        store.notes.set([]);
        store.error.set('Offline');
      })
      .mockImplementationOnce(async () => {
        store.error.set('');
      });
    await expect(library.save(request, previous.id, input, previous)).rejects.toThrow(
      /refresh failed/,
    );
    await library.save(request, previous.id, input, previous);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
  it('ignores late cloud writes after a workspace change', async () => {
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
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.save(crypto.randomUUID(), crypto.randomUUID(), input);
    store.workspace.set({ ...store.workspace()!, id: 'new-workspace' });
    store.notes.set([]);
    complete({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.notes()).toEqual([]);
  });
});
