import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { HouseholdBudgetsLibrary } from './household-budgets';
import { HouseholdBudgetInput } from '../models/domain';
import {
  householdBudgetTotals,
  householdBudgetsCsv,
  validateHouseholdBudget,
} from '../../shared/utilities/household-budgets';
describe('Household monthly budgets, snapshots and private source links', () => {
  let store: LifeStore, library: HouseholdBudgetsLibrary;
  const input: HouseholdBudgetInput = {
    category: 'Groceries',
    month: '2026-01',
    currency: 'INR',
    amount: '100',
    notes: '<script>literal</script>',
    visibility: 'private',
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(HouseholdBudgetsLibrary);
  });
  async function create(v = input) {
    const id = crypto.randomUUID();
    await library.save(crypto.randomUUID(), id, v);
    return id;
  }
  function b(id: string) {
    return store.householdBudgets().find((b) => b.id === id)!;
  }
  function expense(amount = 80, currency = 'INR') {
    const account = store.accounts()[0];
    store.accounts.update((rows) =>
      rows.map((a) => (a.id === account.id ? { ...a, currency } : a)),
    );
    const tx = {
      ...store.transactions()[0],
      id: crypto.randomUUID(),
      owner_id: store.profile()!.id,
      workspace_id: store.workspace()!.id,
      account_id: account.id,
      title: 'Private merchant',
      kind: 'expense' as const,
      amount,
      booked_on: '2026-01-15',
    };
    store.transactions.update((rows) => [tx, ...rows]);
    return tx;
  }
  async function link(id: string, amount = 80) {
    const tx = expense(amount, b(id).currency),
      sid = crypto.randomUUID();
    await library.publish(crypto.randomUUID(), sid, b(id), tx.id, 'Explicit shared note');
    return { tx, sid };
  }
  it('validates monthly periods and bounded amounts without accepting exponent or fractional precision', () => {
    expect(validateHouseholdBudget({ ...input, currency: ' inr ' }).currency).toBe('INR');
    for (const month of ['1899-12', '2101-01', '2026-13', '2026-01-01'])
      expect(() => validateHouseholdBudget({ ...input, month })).toThrow();
    for (const amount of ['0', '-1', '1e3', '0.001', '1000000001'])
      expect(() => validateHouseholdBudget({ ...input, amount })).toThrow();
  });
  it('computes remaining and overages from included snapshots with currency boundaries', async () => {
    const id = await create();
    await link(id, 80.25);
    await link(id, 30.25);
    expect(library.balance(b(id))).toMatchObject({
      spent: 110.5,
      remaining: 0,
      overspent: 10.5,
      percent: 111,
    });
    const usd = await create({ ...input, currency: 'USD', amount: '20' });
    await link(usd, 12);
    const totals = householdBudgetTotals(library.budgets(), store.householdSpending());
    expect(totals).toMatchObject([
      { currency: 'INR', overspent: 10.5 },
      { currency: 'USD', remaining: 8 },
    ]);
  });
  it('does not change snapshots when Finance changes until the contributor refreshes them', async () => {
    const id = await create(),
      { tx, sid } = await link(id);
    store.transactions.update((rows) =>
      rows.map((t) => (t.id === tx.id ? { ...t, amount: 90 } : t)),
    );
    expect(library.balance(b(id)).spent).toBe(80);
    const old = store.householdSpending().find((s) => s.id === sid)!;
    expect(library.sourceStatus(old, b(id))).toContain('Changed in Finance');
    await library.publish(crypto.randomUUID(), sid, b(id), tx.id, old.notes, old);
    expect(library.balance(b(id)).spent).toBe(90);
    expect(store.transactions().find((t) => t.id === tx.id)?.amount).toBe(90);
  });
  it('withdraws without mutating Finance, blocks duplicates and restores with fresh source amounts', async () => {
    const id = await create(),
      { tx, sid } = await link(id),
      before = structuredClone(store.transactions());
    await expect(
      library.publish(crypto.randomUUID(), crypto.randomUUID(), b(id), tx.id, ''),
    ).rejects.toThrow(/not already included/);
    await library.withdraw(crypto.randomUUID(), store.householdSpending()[0]);
    expect(library.balance(b(id)).spent).toBe(0);
    expect(store.transactions()).toEqual(before);
    await library.publish(crypto.randomUUID(), sid, b(id), tx.id, '', store.householdSpending()[0]);
    expect(library.balance(b(id)).spent).toBe(80);
  });
  it('retains own history and permits withdrawal after the budget is no longer shared', async () => {
    const id = await create(),
      { sid } = await link(id);
    store.householdBudgets.update((rows) =>
      rows.map((b) => ({ ...b, owner_id: 'another-user', visibility: 'private' })),
    );
    expect(library.budgets()).toHaveLength(0);
    expect(library.ownSpending()).toHaveLength(1);
    await library.withdraw(crypto.randomUUID(), library.ownSpending()[0]);
    expect(store.householdSpending().find((s) => s.id === sid)?.withdrawn).toBe(true);
    expect(library.link(library.ownSpending()[0])?.active).toBe(false);
  });
  it('blocks changing budget identity after withdrawn history and protects stale revisions and exact retries', async () => {
    const id = await create(),
      tx = expense(),
      sid = crypto.randomUUID(),
      request = crypto.randomUUID(),
      parent = b(id);
    await library.publish(request, sid, parent, tx.id, '');
    await library.publish(request, sid, parent, tx.id, '');
    expect(store.householdSpending()).toHaveLength(1);
    await expect(library.publish(request, sid, parent, tx.id, 'Changed')).rejects.toThrow(
      /another change/,
    );
    await expect(
      library.publish(crypto.randomUUID(), crypto.randomUUID(), parent, tx.id, ''),
    ).rejects.toThrow(/budget changed/);
    await library.withdraw(crypto.randomUUID(), store.householdSpending()[0]);
    await expect(
      library.save(crypto.randomUUID(), id, { ...input, category: 'Changed' }, b(id)),
    ).rejects.toThrow(/cannot change/);
  });
  it('isolates demo caches, clears snapshots on logout and protects CSV formulas', async () => {
    const id = await create({ ...input, category: '=SUM(A1)' });
    await link(id);
    expect(householdBudgetsCsv([b(id)], store.householdSpending())).toContain("'=SUM(A1)");
    const first = store.workspace()!;
    await store.createWorkspace('Another household budget', 'family');
    expect(store.householdBudgets()).toHaveLength(0);
    await store.switchWorkspace(first);
    expect(store.householdSpending()).toHaveLength(1);
    store.clear();
    expect(store.householdSpendingLinks()).toHaveLength(0);
  });
  it('keeps exact RPC retries after saved changes fail to refresh the cache', async () => {
    const id = await create(),
      old = b(id),
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as NonNullable<ReturnType<typeof auth.user>>);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc,
    } as unknown as ReturnType<Backend['requireClient']>);
    vi.spyOn(store, 'switchWorkspace').mockImplementation(async () => {
      store.members.set([]);
      store.householdBudgets.set([]);
      store.error.set('Refresh failed');
    });
    const request = crypto.randomUUID();
    await expect(library.save(request, id, { ...input, amount: '120' }, old)).rejects.toThrow(
      /refresh failed/,
    );
    await expect(library.save(request, id, { ...input, amount: '120' }, old)).rejects.toThrow(
      /refresh failed/,
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
});
