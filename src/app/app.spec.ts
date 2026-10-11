import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from './core/auth/auth';
import { LifeStore } from './core/services/life-store';
import { parseMoney, accountBalance, csv } from './shared/utilities/finance';

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
});
