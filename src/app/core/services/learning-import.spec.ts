import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { LearningLibrary } from './learning';
import { LearningImporter } from './learning-import';
import {
  learningImportTemplate,
  parseLearningImport,
} from '../../shared/utilities/learning-import';
describe('Learning import preview, stable identity and context guards', () => {
  it('marks every duplicate source row invalid rather than selecting an arbitrary copy', () => {
    const root = JSON.parse(learningImportTemplate());
    root.learningItems.push({ ...root.learningItems[0] });
    expect(
      parseLearningImport(JSON.stringify(root), '2026-10-14').rows.every(
        (r) => r.row === null && r.error.includes('unique'),
      ),
    ).toBe(true);
  });
  let store: LifeStore, importer: LearningImporter;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    importer = TestBed.inject(LearningImporter);
  });
  async function prepared(text = learningImportTemplate()) {
    const p = await importer.preview(text);
    return importer.prepare(p.source, p.review, new Set(p.source.rows.map((r) => r.index)));
  }
  it('parses workspace exports with sorted lessons and warns about omitted links/modules', () => {
    const root = JSON.parse(learningImportTemplate());
    root.learningUnits[0].position = 2;
    root.learningUnits.push({ ...root.learningUnits[0], position: 1, title: 'Earlier' });
    root.learningDocuments = [{ attachment_id: 'secret-file' }];
    root.tasks = [{}];
    const p = parseLearningImport(JSON.stringify(root), importer.today());
    expect(p.rows[0].row?.units.map((u) => u.position)).toEqual([1, 2]);
    expect(p.omitted).toEqual(['learningDocuments', 'tasks']);
    expect(p.rows[0].row).not.toHaveProperty('learningDocuments');
  });
  it('previews invalid learning dates, progress, lessons and URLs without making writes', async () => {
    const root = JSON.parse(learningImportTemplate());
    root.learningItems[0].status = 'completed';
    root.learningItems[0].completed_on = '2026-01-01';
    expect(parseLearningImport(JSON.stringify(root), importer.today()).rows[0].error).toMatch(
      /unfinished/,
    );
    root.learningUnits[0].done = true;
    root.learningUnits[0].position = 201;
    expect(parseLearningImport(JSON.stringify(root), importer.today()).rows[0].error).toMatch(
      /lesson/,
    );
    root.learningUnits[0].position = 1;
    root.learningItems[0].url = 'https://user:pass@example.com';
    expect(parseLearningImport(JSON.stringify(root), importer.today()).rows[0].error).toMatch(
      /HTTP/,
    );
    await expect(importer.preview('{invalid')).rejects.toThrow(/valid JSON/);
    expect(store.learningItems()).toEqual([]);
  });
  it('rejects orphan lessons, oversized files and excessive record counts', () => {
    const root = JSON.parse(learningImportTemplate());
    root.learningUnits[0].item_id = 'unknown';
    expect(() => parseLearningImport(JSON.stringify(root), importer.today())).toThrow(/refer/);
    expect(() => parseLearningImport(' '.repeat(5 * 1024 * 1024 + 1), importer.today())).toThrow(
      /5 MiB/,
    );
    root.learningItems = Array(201).fill(root.learningItems[0]);
    expect(() => parseLearningImport(JSON.stringify(root), importer.today())).toThrow(/1–200/);
  });
  it('imports selected items and their archived lesson history into fresh private IDs', async () => {
    const root = JSON.parse(learningImportTemplate());
    root.learningItems.push({ ...root.learningItems[0], id: 'unselected', title: 'Leave out' });
    root.learningUnits[0].archived = true;
    const p = await importer.preview(JSON.stringify(root)),
      request = importer.prepare(p.source, p.review, new Set([0]));
    expect(await importer.save(request)).toEqual({
      items_imported: 1,
      lessons_imported: 1,
      skipped: 0,
    });
    expect(store.learningItems()[0]).toMatchObject({
      visibility: 'private',
      owner_id: store.profile()!.id,
      status: 'active',
    });
    expect(store.learningItems()[0].id).not.toBe('example-course');
    expect(store.learningUnits()[0].archived).toBe(true);
  });
  it('replays one batch and preserves subsequent edits on unchanged reuploads', async () => {
    const request = await prepared(),
      result = await importer.save(request);
    expect(await importer.save(request)).toEqual(result);
    const item = store.learningItems()[0],
      library = TestBed.inject(LearningLibrary);
    await library.state(crypto.randomUUID(), item, 'paused', true);
    const after = store.learningItems()[0];
    const p = await importer.preview(learningImportTemplate());
    expect(p.review[0].state).toBe('duplicate');
    expect(() => importer.prepare(p.source, p.review, new Set([0]))).toThrow(/ready/);
    expect(store.learningItems()[0]).toEqual(after);
    await expect(
      importer.save({ ...request, payload: [{ ...request.payload[0], title: 'Changed' }] }),
    ).rejects.toThrow(/request reused/);
  });
  it('rolls back new rows and sources if another selected source conflicts', async () => {
    const request = await prepared();
    await importer.save(request);
    const fresh = { ...request.payload[0], source_id: 'fresh' },
      changed = { ...request.payload[0], title: 'Changed source' };
    await expect(
      importer.save({ ...request, id: crypto.randomUUID(), payload: [fresh, changed] }),
    ).rejects.toThrow(/contents changed/);
    expect(store.learningItems()).toHaveLength(1);
    const root = JSON.parse(learningImportTemplate());
    root.learningItems[0].id = 'fresh';
    root.learningUnits[0].item_id = 'fresh';
    expect((await importer.preview(JSON.stringify(root))).review[0].state).toBe('ready');
  });
  it('keeps source bindings isolated across workspaces and rejects a pending batch after switching', async () => {
    const w = store.workspace()!,
      request = await prepared();
    await importer.save(request);
    await store.createWorkspace('Other import workspace', 'personal');
    await expect(importer.save(request)).rejects.toThrow(/changed/);
    const p = await importer.preview(learningImportTemplate());
    expect(p.review[0].state).toBe('ready');
    await store.switchWorkspace(w);
    expect((await importer.preview(learningImportTemplate())).review[0].state).toBe('duplicate');
  });
  it('retries the identical cloud batch after a failed refresh clears membership', async () => {
    const request = await prepared(),
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    const rpc = vi.fn().mockResolvedValue({
      data: { items_imported: 1, lessons_imported: 1, skipped: 0 },
      error: null,
    });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    vi.spyOn(store, 'switchWorkspace')
      .mockImplementationOnce(async () => {
        store.members.set([]);
        store.error.set('Offline');
      })
      .mockImplementationOnce(async () => {
        store.error.set('');
      });
    await expect(importer.save(request)).rejects.toThrow(/refresh failed/);
    expect((await importer.save(request)).items_imported).toBe(1);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('discards late cloud preview data after sign-out or a workspace change', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    let finish!: (v: unknown) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    } as never);
    const pending = importer.preview(learningImportTemplate());
    store.clear();
    finish({ data: [], error: null });
    await expect(pending).rejects.toThrow(/changed/);
  });
});
