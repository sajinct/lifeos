import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { Attachment, FileDetails } from '../models/domain';
import { LifeStore } from './life-store';
import { FileLibrary } from './file-library';
import { MAX_FILE_BYTES, validateFile } from '../../shared/utilities/files';
const details: FileDetails = {
  category: 'Work',
  expires_on: '',
  project_id: '',
  transaction_id: '',
};
const document = () => new File(['hello'], 'sample.txt', { type: 'text/plain' });

describe('Private file library in demo mode', () => {
  let store: LifeStore, library: FileLibrary;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(FileLibrary);
  });
  it('validates bucket-specific formats, size and deceptive extensions', () => {
    expect(
      validateFile({ name: 'photo.JPEG', size: 1, type: 'image/jpeg' }, 'financial-receipts')
        .extension,
    ).toBe('jpg');
    expect(validateFile({ name: 'plain.txt', size: 1, type: '' }, 'personal-documents').mime).toBe(
      'text/plain',
    );
    for (const file of [
      { name: 'empty.txt', size: 0, type: 'text/plain' },
      { name: 'big.pdf', size: MAX_FILE_BYTES + 1, type: 'application/pdf' },
      { name: 'bad.svg', size: 1, type: 'image/svg+xml' },
      { name: 'bad.pdf', size: 1, type: 'text/html' },
    ])
      expect(() => validateFile(file, 'personal-documents')).toThrow();
    expect(() => validateFile(document(), 'financial-receipts')).toThrow(/Receipts/);
  });
  it('retains downloadable old versions and supports archive/restore across workspace switching', async () => {
    const original = store.workspace()!;
    await library.upload(document(), 'personal-documents', details);
    const first = store.attachments()[0];
    expect(first.status).toBe('ready');
    expect((await library.download(first)).size).toBe(5);
    await library.upload(document(), 'personal-documents', details, first);
    const second = store.attachments().find((a) => a.previous_version_id === first.id)!;
    expect(second.version_number).toBe(2);
    expect(store.attachments().find((a) => a.id === first.id)?.status).toBe('archived');
    await library.archive(second);
    await library.archive({ ...second, status: 'archived' }, true);
    await store.createWorkspace('Other', 'personal');
    expect(store.attachments()).toEqual([]);
    await store.switchWorkspace(original);
    expect(store.attachments().length).toBe(2);
    expect((await library.download(first)).type).toBe('application/octet-stream');
    await expect(library.discard(second)).rejects.toThrow(/archived/);
  });
  it('does not retain file bytes after a new demo session', async () => {
    await library.upload(document(), 'personal-documents', details);
    const row = store.attachments()[0];
    store.clear();
    await store.initialize();
    await expect(library.download(row)).rejects.toThrow(/no longer available/);
  });
});

describe('Storage request recovery and session isolation', () => {
  let store: LifeStore, library: FileLibrary;
  let reserved: Attachment;
  let stored: boolean;
  const objectUpload = vi.fn();
  const objectRemove = vi.fn();
  const objectDownload = vi.fn();
  const rpc = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    stored = false;
    objectUpload.mockImplementation(async () => {
      stored = true;
      return { error: null };
    });
    objectRemove.mockResolvedValue({ error: null });
    rpc.mockImplementation(async (name: string) =>
      name === 'complete_attachment' && !stored
        ? {
            error: {
              message: 'Uploaded file not found or metadata does not match; retry the upload',
              code: 'P0001',
            },
          }
        : { error: null },
    );
    const client = {
      from: () => ({
        insert: (row: Attachment) => {
          reserved = row;
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
        },
      }),
      storage: {
        from: () => ({ upload: objectUpload, remove: objectRemove, download: objectDownload }),
      },
      rpc,
    };
    TestBed.configureTestingModule({
      providers: [{ provide: Backend, useValue: { client: null, requireClient: () => client } }],
    });
    const auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'owner' } as User);
    store = TestBed.inject(LifeStore);
    store.workspace.set({ id: 'workspace', owner_id: 'owner', name: 'Personal', kind: 'personal' });
    store.members.set([{ workspace_id: 'workspace', user_id: 'owner', role: 'owner' }]);
    library = TestBed.inject(FileLibrary);
  });
  it('retains interrupted uploads and can finish an already-stored object without overwriting it', async () => {
    objectUpload.mockResolvedValueOnce({ error: new Error('Offline') });
    await expect(library.upload(document(), 'personal-documents', details)).rejects.toThrow(
      /Unfinished/,
    );
    expect(store.attachments()[0].status).toBe('uploading');
    stored = true;
    await library.retryUpload(reserved, document());
    expect(store.attachments()[0].status).toBe('ready');
    expect(objectUpload).toHaveBeenCalledTimes(1);
    expect(objectUpload.mock.calls[0][2].upsert).toBe(false);
    expect(rpc).toHaveBeenCalledWith('complete_attachment', { upload: reserved.id });
  });
  it('recovers a rejected Storage retry only when the database confirms an owned file exists', async () => {
    stored = true;
    objectUpload.mockResolvedValueOnce({
      error: { statusCode: '403', message: 'Reinsert denied' },
    });
    await library.upload(document(), 'personal-documents', details);
    expect(store.attachments()[0].status).toBe('ready');
    expect(rpc).toHaveBeenCalledWith('complete_attachment', { upload: reserved.id });
  });
  it('keeps failed cleanup retryable instead of deleting metadata prematurely', async () => {
    objectUpload.mockResolvedValueOnce({ error: new Error('Offline') });
    await expect(library.upload(document(), 'personal-documents', details)).rejects.toThrow();
    objectRemove.mockResolvedValueOnce({ error: new Error('Offline') });
    await expect(library.discard(reserved)).rejects.toThrow(/Retry cleanup/);
    expect(store.attachments()[0].status).toBe('cancelled');
    expect(rpc.mock.calls.some((call) => call[0] === 'remove_cancelled_attachment')).toBe(false);
    await library.discard(store.attachments()[0]);
    expect(store.attachments()).toEqual([]);
  });
  it('does not deliver a pending download after changing workspace or signing out', async () => {
    await library.upload(document(), 'personal-documents', details);
    let finish!: (value: { data: Blob; error: null }) => void;
    objectDownload.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const download = library.download(store.attachments()[0]);
    store.clear();
    finish({ data: new Blob(['hello']), error: null });
    await expect(download).rejects.toThrow(/workspace/);
  });
});
