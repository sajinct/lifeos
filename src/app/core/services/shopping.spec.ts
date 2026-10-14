import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { ShoppingLibrary } from './shopping';
import { ShoppingItemInput, ShoppingListInput } from '../models/domain';
import {
  shoppingCsv,
  shoppingProgress,
  validateShoppingItem,
  validateShoppingList,
} from '../../shared/utilities/shopping';
describe('Shopping lists and retry-safe collaboration', () => {
  let store: LifeStore, library: ShoppingLibrary;
  const input: ShoppingListInput = {
    title: ' Weekly groceries ',
    kind: 'grocery',
    notes: ' <script>literal</script> ',
    visibility: 'private',
  };
  const item: ShoppingItemInput = {
    name: ' Milk ',
    category: 'Dairy',
    quantity: '1.5',
    unit: 'litres',
    notes: 'Cold',
    checked: false,
    archived: false,
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(ShoppingLibrary);
  });
  async function create(v = input) {
    const id = crypto.randomUUID();
    await library.save(crypto.randomUUID(), id, v);
    return id;
  }
  function list(id: string) {
    return store.shoppingLists().find((l) => l.id === id)!;
  }
  it('validates positive decimal quantities and preserves literal notes', () => {
    expect(validateShoppingList(input).notes).toBe(input.notes);
    expect(validateShoppingItem(item).quantity).toBe(1.5);
    for (const quantity of [
      '0',
      '-1',
      '1e3',
      '1,000',
      '01',
      '0.0001',
      '1000001',
      'NaN',
      'Infinity',
    ])
      expect(() => validateShoppingItem({ ...item, quantity })).toThrow(/positive quantity/);
    expect(validateShoppingItem({ ...item, quantity: '0.001' }).quantity).toBe(0.001);
  });
  it('creates private lists, checks items and restores archived history', async () => {
    const id = await create(),
      entry = crypto.randomUUID();
    await library.item(crypto.randomUUID(), entry, list(id), item);
    const before = store.shoppingItems()[0];
    await library.item(crypto.randomUUID(), entry, list(id), { ...item, checked: true }, before);
    const checked = store.shoppingItems()[0];
    expect(checked.checked_by).toBe(store.profile()?.id);
    await library.item(
      crypto.randomUUID(),
      entry,
      list(id),
      { ...item, checked: true, archived: true },
      checked,
    );
    expect(library.progress(list(id))).toMatchObject({ total: 0, percent: 0 });
    await library.item(
      crypto.randomUUID(),
      entry,
      list(id),
      { ...item, checked: true },
      store.shoppingItems()[0],
    );
    expect(store.shoppingItems()[0].checked_at).toBe(checked.checked_at);
    await library.archive(crypto.randomUUID(), list(id), true);
    await expect(
      library.item(crypto.randomUUID(), crypto.randomUUID(), list(id), item),
    ).rejects.toThrow(/Restore/);
    await library.archive(crypto.randomUUID(), list(id), false);
    expect(library.progress(list(id)).percent).toBe(100);
  });
  it('keeps request payloads stable, rejects stale parent drafts and replays without undo', async () => {
    const id = await create(),
      request = crypto.randomUUID(),
      entry = crypto.randomUUID(),
      parent = list(id);
    await library.item(request, entry, parent, item);
    await library.item(request, entry, parent, item);
    expect(store.shoppingItems()).toHaveLength(1);
    await library.item(
      crypto.randomUUID(),
      entry,
      list(id),
      { ...item, checked: true },
      store.shoppingItems()[0],
    );
    await library.item(request, entry, parent, item);
    expect(store.shoppingItems()[0].checked).toBe(true);
    await expect(
      library.item(request, entry, parent, { ...item, name: 'Changed' }),
    ).rejects.toThrow(/another change/);
    await expect(
      library.item(crypto.randomUUID(), crypto.randomUUID(), parent, item),
    ).rejects.toThrow(/list changed/);
  });
  it('keeps private child items hidden when list ownership differs', async () => {
    const id = await create();
    await library.item(crypto.randomUUID(), crypto.randomUUID(), list(id), item);
    store.shoppingLists.update((rows) => rows.map((l) => ({ ...l, owner_id: 'someone-else' })));
    expect(library.lists()).toHaveLength(0);
    expect(library.items(list(id))).toHaveLength(0);
  });
  it('isolates demo workspace caches and clears records on logout', async () => {
    const id = await create(),
      first = store.workspace()!;
    await library.item(crypto.randomUUID(), crypto.randomUUID(), list(id), item);
    await store.createWorkspace('Another shopping workspace', 'personal');
    expect(store.shoppingLists()).toHaveLength(0);
    await store.switchWorkspace(first);
    expect(store.shoppingItems()).toHaveLength(1);
    store.clear();
    expect(store.shoppingItems()).toHaveLength(0);
    expect(store.shoppingLists()).toHaveLength(0);
  });
  it('protects CSV formulas and excludes unrelated children and archived progress', async () => {
    const id = await create({ ...input, title: '=SUM(A1)' });
    await library.item(crypto.randomUUID(), crypto.randomUUID(), list(id), {
      ...item,
      name: '+danger',
    });
    const child = store.shoppingItems()[0];
    expect(shoppingCsv([list(id)], [child, { ...child, list_id: 'other' }])).toContain("'+danger");
    expect(shoppingCsv([list(id)], [child])).toContain("'=SUM(A1)");
    expect(shoppingProgress([{ ...child, archived: true }])).toMatchObject({
      total: 0,
      remaining: 0,
      percent: 0,
    });
  });
  it('reissues exact RPCs after a failed refresh and trusts server permission rechecks', async () => {
    const id = await create(),
      old = list(id),
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as NonNullable<ReturnType<typeof auth.user>>);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc,
    } as unknown as ReturnType<Backend['requireClient']>);
    vi.spyOn(store, 'switchWorkspace').mockImplementation(async () => {
      store.members.set([]);
      store.shoppingLists.set([]);
      store.error.set('Refresh unavailable');
    });
    const request = crypto.randomUUID();
    await expect(library.save(request, id, { ...input, title: 'New title' }, old)).rejects.toThrow(
      /refresh failed/,
    );
    store.error.set('');
    await expect(library.save(request, id, { ...input, title: 'New title' }, old)).rejects.toThrow(
      /refresh failed/,
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('denies viewer writes before calling the backend', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    const user = store.profile()!.id;
    auth.user.set({ id: user } as NonNullable<ReturnType<typeof auth.user>>);
    store.members.set([{ workspace_id: store.workspace()!.id, user_id: user, role: 'viewer' }]);
    await expect(library.save(crypto.randomUUID(), crypto.randomUUID(), input)).rejects.toThrow(
      /write access/,
    );
  });
});
