import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { DocumentSharing } from './document-sharing';
import { FileLibrary } from './file-library';
import { DocumentShare } from '../models/domain';
describe('Document version sharing', () => {
  let store: LifeStore, library: DocumentSharing, files: FileLibrary;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(DocumentSharing);
    files = TestBed.inject(FileLibrary);
    TestBed.tick();
    await library.sample();
    await library.refresh();
  });
  async function share() {
    const id = crypto.randomUUID(),
      req = crypto.randomUUID(),
      source = library.choices()[0].id;
    await library.set(req, id, source, 'demo-reader', null, false);
    return { id, req, source };
  }
  it('shares an exact version and does not inherit sharing when a newer version is uploaded', async () => {
    const { source } = await share();
    const previous = library.choices()[0];
    await files.upload(
      new File(['newer'], 'renewal.txt', { type: 'text/plain' }),
      'personal-documents',
      { category: 'Other', expires_on: '', project_id: '', transaction_id: '' },
      previous,
    );
    expect(library.rows()).toHaveLength(1);
    expect(library.rows()[0].attachment_id).toBe(source);
    expect(library.rows()[0].version_number).toBe(1);
    expect(library.choices()).toHaveLength(2);
    expect((await library.download(library.rows()[0])).size).toBe(previous.size_bytes);
  });
  it('revokes, preserves old successful retry identity and explicitly restores access', async () => {
    const { id, req, source } = await share();
    await library.set(crypto.randomUUID(), id, source, 'demo-reader', 1, true);
    await library.set(req, id, source, 'demo-reader', null, false);
    expect(library.rows()[0].revoked).toBe(true);
    await expect(library.download(library.rows()[0])).rejects.toThrow(/access/);
    await library.set(crypto.randomUUID(), id, source, 'demo-reader', 2, false);
    expect(library.rows()[0].revision).toBe(3);
    await expect(library.set(req, id, source, 'demo-reader', 3, true)).rejects.toThrow(/identity/);
  });
  it('rejects self, unrelated recipients, stale revisions and duplicate bindings', async () => {
    const { id, source } = await share();
    await expect(
      library.set(
        crypto.randomUUID(),
        crypto.randomUUID(),
        source,
        store.profile()!.id,
        null,
        false,
      ),
    ).rejects.toThrow(/another/);
    await expect(
      library.set(crypto.randomUUID(), crypto.randomUUID(), source, 'outsider', null, false),
    ).rejects.toThrow(/current/);
    await expect(
      library.set(crypto.randomUUID(), id, source, 'demo-reader', 99, true),
    ).rejects.toThrow(/changed/);
    await expect(
      library.set(crypto.randomUUID(), crypto.randomUUID(), source, 'demo-reader', null, false),
    ).rejects.toThrow(/already/);
  });
  it('keeps receipts, unfinished files and private project or Finance bindings out of sharing', async () => {
    const file = library.choices()[0];
    store.attachments.update((rows) => [
      ...rows,
      {
        ...file,
        id: 'receipt',
        bucket_id: 'financial-receipts',
        transaction_id: 'private-finance',
      },
      { ...file, id: 'unfinished', status: 'uploading' },
    ]);
    const { source } = await share();
    expect(library.choices().map((a) => a.id)).toEqual([source]);
    expect(library.rows()[0]).not.toHaveProperty('transaction_id');
    expect(library.rows()[0]).not.toHaveProperty('project_id');
    expect(library.rows()[0]).not.toHaveProperty('object_path');
  });
  it('isolates workspace and logout state', async () => {
    await share();
    const original = store.workspace()!;
    await store.createWorkspace('Other', 'personal');
    TestBed.tick();
    await library.refresh();
    expect(library.rows()).toEqual([]);
    await store.switchWorkspace(original);
    TestBed.tick();
    await library.refresh();
    expect(library.rows()).toHaveLength(1);
    store.clear();
    TestBed.tick();
    expect(library.rows()).toEqual([]);
    await store.initialize();
    TestBed.tick();
    await library.refresh();
    expect(library.rows()).toEqual([]);
  });
});
describe('Hosted share catalog pagination and stale responses', () => {
  const rpc = vi.fn(),
    invoke = vi.fn();
  let store: LifeStore, library: DocumentSharing;
  beforeEach(() => {
    vi.resetAllMocks();
    rpc.mockResolvedValue({ data: [], error: null });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: Backend,
          useValue: { client: null, requireClient: () => ({ rpc, functions: { invoke } }) },
        },
      ],
    });
    TestBed.inject(AuthService).user.set({ id: 'owner' } as User);
    store = TestBed.inject(LifeStore);
    store.profile.set({ id: 'owner', display_name: 'Owner', timezone: 'UTC', currency: 'INR' });
    store.workspace.set({ id: 'w', owner_id: 'owner', name: 'Workspace', kind: 'family' });
    store.members.set([{ workspace_id: 'w', user_id: 'owner', role: 'owner' }]);
    library = TestBed.inject(DocumentSharing);
  });
  function row(id: string): DocumentShare {
    return {
      id,
      workspace_id: 'w',
      owner_id: 'owner',
      recipient_id: 'reader',
      attachment_id: 'file',
      revoked: false,
      revision: 1,
      name: 'Private name',
      mime_type: 'text/plain',
      size_bytes: 5,
      version_number: 1,
      sender_name: 'Owner',
      recipient_name: 'Reader',
    };
  }
  it('loads beyond the first 500 grants using the last stable id', async () => {
    const page = Array.from({ length: 500 }, (_, i) => row(String(i).padStart(4, '0')));
    rpc
      .mockResolvedValueOnce({ data: page, error: null })
      .mockResolvedValueOnce({ data: [row('0500')], error: null });
    await library.refresh();
    expect(library.rows()).toHaveLength(501);
    expect(rpc).toHaveBeenLastCalledWith('document_share_catalog', { w: 'w', after_id: '0499' });
  });
  it('discards catalog results arriving after workspace changes', async () => {
    let resolve!: (value: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = library.refresh();
    store.workspace.set({ id: 'other', owner_id: 'owner', name: 'Other', kind: 'personal' });
    resolve({ data: [row('old')], error: null });
    await pending;
    expect(library.rows()).toEqual([]);
  });
  it('discards in-flight download bytes after logout', async () => {
    const shared = row('share');
    library.rows.set([shared]);
    let resolve!: (value: unknown) => void;
    invoke.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = library.download(shared);
    store.clear();
    resolve({ data: new Blob(['hello']), error: null });
    await expect(pending).rejects.toThrow(/Workspace changed/);
    expect(invoke).toHaveBeenCalledWith('document-download', { body: { share_id: 'share' } });
  });
});
