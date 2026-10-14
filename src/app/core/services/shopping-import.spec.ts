import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { ShoppingImporter } from './shopping-import';
import {
  parseShoppingImport,
  shoppingImportTemplate,
} from '../../shared/utilities/shopping-import';
describe('Shopping import validation, identities and private snapshots', () => {
  let store: LifeStore, importer: ShoppingImporter;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    importer = TestBed.inject(ShoppingImporter);
  });
  async function prepared(value = shoppingImportTemplate()) {
    const p = await importer.preview(value);
    return importer.prepare(p.source, p.review, new Set(p.source.rows.map((r) => r.index)));
  }
  it('normalizes quantities and sorts items, ignoring source permissions and check attribution', () => {
    const root = JSON.parse(shoppingImportTemplate());
    root.shoppingItems[0].position = 2;
    root.shoppingItems.push({ ...root.shoppingItems[0], position: 1, name: 'First' });
    root.shoppingLists[0].visibility = 'workspace';
    root.shoppingLists[0].owner_id = 'another';
    root.shoppingItems[0].checked_by = 'another';
    root.transactions = [{ title: 'Private expense' }];
    const p = parseShoppingImport(JSON.stringify(root));
    expect(p.rows[0].row?.items.map((i) => i.position)).toEqual([1, 2]);
    expect(p.rows[0].row?.items[0].quantity).toBe(1.25);
    expect(p.omitted).toEqual(['transactions']);
    expect(p.rows[0].row).not.toHaveProperty('visibility');
    expect(p.rows[0].row?.items[0]).not.toHaveProperty('checked_by');
  });
  it('marks every duplicate source ID invalid and rejects orphan children', () => {
    const root = JSON.parse(shoppingImportTemplate());
    root.shoppingLists.push({ ...root.shoppingLists[0] });
    expect(
      parseShoppingImport(JSON.stringify(root)).rows.every(
        (r) => r.row === null && r.error.includes('unique'),
      ),
    ).toBe(true);
    root.shoppingItems[0].list_id = 'missing';
    expect(() => parseShoppingImport(JSON.stringify(root))).toThrow(/refer/);
  });
  it('rejects bad positions, precision, booleans, types and oversized files before writing', () => {
    for (const changes of [
      { position: 501 },
      { position: '1' },
      { quantity: '0' },
      { quantity: true },
      { quantity: '1.0001' },
      { quantity: '1000001' },
      { checked: 'false' },
      { archived: 2 },
      { name: '\0bad' },
    ]) {
      const root = JSON.parse(shoppingImportTemplate());
      Object.assign(root.shoppingItems[0], changes);
      expect(parseShoppingImport(JSON.stringify(root)).rows[0].row).toBeNull();
    }
    expect(() => parseShoppingImport(' '.repeat(5 * 1024 * 1024 + 1))).toThrow(/5 MiB/);
    const root = JSON.parse(shoppingImportTemplate());
    root.shoppingLists = Array(101).fill(root.shoppingLists[0]);
    expect(() => parseShoppingImport(JSON.stringify(root))).toThrow(/1–100/);
    root.shoppingLists = [root.shoppingLists[0]];
    root.shoppingItems = Array(501).fill(root.shoppingItems[0]);
    expect(() => parseShoppingImport(JSON.stringify(root))).toThrow(/500/);
    expect(store.shoppingLists()).toEqual([]);
  });
  it('imports only selected lists with new IDs, private sharing and current check attribution', async () => {
    const root = JSON.parse(shoppingImportTemplate());
    root.shoppingLists[0].archived = true;
    root.shoppingLists.push({ ...root.shoppingLists[0], id: 'leave-out', title: 'Leave out' });
    root.shoppingItems[0].checked = true;
    root.shoppingItems[0].archived = true;
    const p = await importer.preview(JSON.stringify(root));
    const r = importer.prepare(p.source, p.review, new Set([0]));
    expect(await importer.save(r)).toEqual({ lists_imported: 1, items_imported: 1, skipped: 0 });
    const l = store.shoppingLists()[0];
    expect(l).toMatchObject({
      visibility: 'private',
      owner_id: 'demo-user',
      archived: true,
      revision: 1,
    });
    expect(l.id).not.toBe('example-groceries');
    expect(store.shoppingItems()[0]).toMatchObject({
      list_id: l.id,
      checked: true,
      checked_by: 'demo-user',
      archived: true,
      quantity: 1.25,
      revision: 1,
    });
    expect(store.shoppingItems()[0].checked_at).not.toBeNull();
    expect(store.shoppingLists()).toHaveLength(1);
  });
  it('retains exact batch identity and reuploads do not undo later edits or checked states', async () => {
    const request = await prepared();
    const first = await importer.save(request);
    store.shoppingLists.update((rows) =>
      rows.map((l) => ({ ...l, title: 'Edited locally', archived: true })),
    );
    store.shoppingItems.update((rows) =>
      rows.map((i) => ({
        ...i,
        checked: true,
        checked_by: 'demo-user',
        checked_at: new Date().toISOString(),
      })),
    );
    expect(await importer.save(request)).toEqual(first);
    const p = await importer.preview(shoppingImportTemplate());
    expect(p.review[0].state).toBe('duplicate');
    expect(store.shoppingLists()[0].title).toBe('Edited locally');
    expect(store.shoppingItems()[0].checked).toBe(true);
    const changed = structuredClone(request);
    changed.payload[0].title = 'Changed batch';
    await expect(importer.save(changed)).rejects.toThrow(/reused/);
  });
  it('rejects source conflicts atomically and preserves tombstones after destination removal', async () => {
    await importer.save(await prepared());
    const root = JSON.parse(shoppingImportTemplate());
    root.shoppingItems[0].quantity = '2';
    expect((await importer.preview(JSON.stringify(root))).review[0].state).toBe('invalid');
    const newRoot = JSON.parse(shoppingImportTemplate());
    newRoot.shoppingLists[0].id = 'fresh';
    newRoot.shoppingItems[0].list_id = 'fresh';
    const fresh = await prepared(JSON.stringify(newRoot));
    fresh.payload.push({ ...fresh.payload[0], source_id: 'example-groceries', title: 'Changed' });
    await expect(importer.save(fresh)).rejects.toThrow(/contents changed/);
    expect(store.shoppingLists()).toHaveLength(1);
    store.shoppingLists.set([]);
    store.shoppingItems.set([]);
    expect((await importer.preview(shoppingImportTemplate())).review[0].state).toBe('duplicate');
  });
  it('rejects existing owned IDs, resets on logout and isolates workspace bindings', async () => {
    const r = await prepared();
    await importer.save(r);
    const original = store.workspace()!;
    const root = JSON.parse(shoppingImportTemplate());
    const id = store.shoppingLists()[0].id;
    root.shoppingLists[0].id = id;
    root.shoppingItems[0].list_id = id;
    expect((await importer.preview(JSON.stringify(root))).review[0].state).toBe('invalid');
    await store.createWorkspace('Other', 'personal');
    await expect(importer.save(r)).rejects.toThrow(/Workspace changed/);
    expect((await importer.preview(shoppingImportTemplate())).review[0].state).toBe('ready');
    await store.switchWorkspace(original);
    expect((await importer.preview(shoppingImportTemplate())).review[0].state).toBe('duplicate');
    store.clear();
    await store.initialize();
    expect((await importer.preview(shoppingImportTemplate())).review[0].state).toBe('ready');
  });
  it('checks current role even on a cached successful batch', async () => {
    const r = await prepared();
    await importer.save(r);
    store.auth.demo.set(false);
    store.auth.user.set({ id: 'demo-user' } as User);
    store.members.set([
      { workspace_id: store.workspace()!.id, user_id: 'demo-user', role: 'viewer' },
    ]);
    store.auth.demo.set(true);
    // Demo normally always permits editing; simulate the role gate directly.
    vi.spyOn(store, 'writable').mockReturnValue(false);
    await expect(importer.save(r)).rejects.toThrow(/write access/);
  });
});
describe('Hosted Shopping import context and frozen retries', () => {
  const rpc = vi.fn();
  let store: LifeStore, importer: ShoppingImporter;
  beforeEach(() => {
    vi.resetAllMocks();
    TestBed.configureTestingModule({
      providers: [{ provide: Backend, useValue: { client: null, requireClient: () => ({ rpc }) } }],
    });
    TestBed.inject(AuthService).user.set({ id: 'owner' } as User);
    store = TestBed.inject(LifeStore);
    store.profile.set({ id: 'owner', display_name: 'Owner', currency: 'INR', timezone: 'UTC' });
    store.workspace.set({ id: 'w', owner_id: 'owner', name: 'Workspace', kind: 'family' });
    store.members.set([{ workspace_id: 'w', user_id: 'owner', role: 'owner' }]);
    importer = TestBed.inject(ShoppingImporter);
  });
  it('discards a preview response arriving after the workspace changes', async () => {
    let resolve!: (v: unknown) => void;
    rpc.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const p = importer.preview(shoppingImportTemplate());
    store.workspace.set({ id: 'other', owner_id: 'owner', name: 'Other', kind: 'personal' });
    resolve({ data: [], error: null });
    await expect(p).rejects.toThrow(/Workspace changed/);
  });
  it('retains the exact server batch after a successful import and failed refresh', async () => {
    rpc.mockResolvedValueOnce({
      data: [{ source_id: 'example-groceries', state: 'ready', message: 'Ready' }],
      error: null,
    });
    const p = await importer.preview(shoppingImportTemplate());
    const request = importer.prepare(p.source, p.review, new Set([0]));
    rpc.mockResolvedValue({
      data: { lists_imported: 1, items_imported: 1, skipped: 0 },
      error: null,
    });
    vi.spyOn(store, 'switchWorkspace').mockImplementation(async () => {
      store.error.set('Refresh failed');
    });
    await expect(importer.save(request)).rejects.toThrow(/Retry this batch safely/);
    const call = rpc.mock.calls.at(-1);
    await expect(importer.save(request)).rejects.toThrow(/Retry this batch safely/);
    expect(rpc.mock.calls.at(-1)).toEqual(call);
  });
});
