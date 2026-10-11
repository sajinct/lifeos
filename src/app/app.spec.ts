import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from './core/auth/auth';
import { LifeStore } from './core/services/life-store';
import {
  parseMoney,
  accountBalance,
  budgetSpent,
  recurrenceDate,
  csv,
  localDate,
} from './shared/utilities/finance';

describe('LifeOS domain behavior', () => {
  let store: LifeStore;
  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
  });
  it('completes and reopens tasks', async () => {
    const task = store.pending()[0];
    const before = store.pending().length;
    await store.toggleTask(task);
    expect(store.pending().length).toBe(before - 1);
    await store.toggleTask(store.tasks().find((t) => t.id === task.id)!);
    expect(store.pending().length).toBe(before);
  });
  it('uses cent arithmetic for account balances', () => {
    const account = store.accounts()[0];
    const entry = store.transactions()[0];
    expect(
      accountBalance({ ...account, opening_balance: 0.3 }, [
        { ...entry, account_id: account.id, kind: 'expense', amount: 0.1 },
        { ...entry, account_id: account.id, kind: 'expense', amount: 0.2 },
      ]),
    ).toBe(0);
  });
  it('validates precision and rejects invalid money', () => {
    expect(parseMoney('25.15')).toBe(25.15);
    for (const input of ['0', '-5', '1.001', 'NaN', '1e8'])
      expect(() => parseMoney(input)).toThrow();
  });
  it('preserves net balance and ignores repeated transfer requests', async () => {
    const before = store.balance();
    await store.transfer('a1', 'a2', '25.15', 'retry-key');
    await store.transfer('a1', 'a2', '25.15', 'retry-key');
    expect(store.balance()).toBe(before);
    expect(store.transactions().filter((t) => t.transfer_id === 'retry-key').length).toBe(2);
  });
  it('does not mix account currencies in summaries', () => {
    const account = store.accounts()[0];
    store.accounts.set([{ ...account, currency: 'USD' }]);
    expect(store.balance()).toBe(0);
    expect(store.income()).toBe(0);
    expect(store.expenses()).toBe(0);
  });
  it('neutralizes spreadsheet formula injection and quotes CSV', () => {
    const output = csv([{ title: '=HYPERLINK("bad")', note: 'a,b' }]);
    expect(output).toContain("'=HYPERLINK");
    expect(output).toContain('"a,b"');
  });
  it('clears all private state on logout', () => {
    store.clear();
    expect(store.profile()).toBeNull();
    expect(store.transactions()).toEqual([]);
    expect(store.notes()).toEqual([]);
    expect(store.workspace()).toBeNull();
    expect(store.budgets()).toEqual([]);
    expect(store.bills()).toEqual([]);
    expect(store.recurring()).toEqual([]);
  });
  it('starts new workspaces without demo records', async () => {
    await store.createWorkspace('Our family', 'family');
    expect(store.workspace()?.name).toBe('Our family');
    expect(store.tasks()).toEqual([]);
    expect(store.balance()).toBe(0);
  });
  it('preserves demo edits and workspace choices across switching', async () => {
    const original = store.workspace()!;
    const task = store.pending()[0];
    await store.toggleTask(task);
    await store.createWorkspace('Family', 'family');
    await store.switchWorkspace(original);
    expect(store.tasks().find((t) => t.id === task.id)?.status).toBe('done');
    expect(store.workspaces().length).toBe(2);
  });
  it('records bill payments once and restores them across workspace switching', async () => {
    const original = store.workspace()!;
    const bill = store.bills()[0];
    const before = store.balance();
    await store.settleBill(bill);
    await store.settleBill(bill);
    expect(store.balance()).toBe(before - bill.amount);
    expect(store.transactions().filter((t) => t.bill_id === bill.id).length).toBe(1);
    await store.createWorkspace('Empty', 'personal');
    expect(store.bills()).toEqual([]);
    await store.switchWorkspace(original);
    expect(store.bills()[0].status).toBe('paid');
  });
  it('does not count transfers, other currencies or other months against budgets', () => {
    const b = store.budgets()[0];
    const entry = store.transactions()[0];
    const account = store.accounts()[0];
    const expense = {
      ...entry,
      owner_id: b.owner_id,
      workspace_id: b.workspace_id,
      account_id: account.id,
      category: b.category,
      kind: 'expense' as const,
      booked_on: b.month,
      amount: 0.1,
    };
    expect(
      budgetSpent(
        b,
        [
          expense,
          { ...expense, amount: 0.2 },
          { ...expense, kind: 'transfer_out' },
          { ...expense, booked_on: '2000-01-01' },
        ],
        [account],
      ),
    ).toBe(0.3);
    expect(budgetSpent({ ...b, currency: 'USD' }, [expense], [account])).toBe(0);
  });
  it('anchors recurring dates at month end and across leap years', () => {
    expect(recurrenceDate('2024-01-31', 'monthly', 1)).toBe('2024-02-29');
    expect(recurrenceDate('2024-01-31', 'monthly', 2)).toBe('2024-03-31');
    expect(recurrenceDate('2024-02-29', 'yearly', 4)).toBe('2028-02-29');
  });
  it('posts recurring demo entries once and respects pause', async () => {
    const r = store.recurring()[0];
    expect(await store.postRecurring(r)).toBe(1);
    expect(await store.postRecurring(r)).toBe(0);
    expect(store.transactions().filter((t) => t.recurring_id === r.id).length).toBe(1);
    expect(store.recurring()[0].next_on > localDate()).toBe(true);
    await store.setRecurringActive(store.recurring()[0]);
    expect(await store.postRecurring(store.recurring()[0])).toBe(0);
  });
});
