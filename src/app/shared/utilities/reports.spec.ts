import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { SubscriptionLibrary } from '../../core/services/subscriptions';
import { Account, Budget, Subscription, Transaction } from '../../core/models/domain';
import { financeReports, reportCsv, reportPeriod, ReportFilter } from './reports';
describe('Financial reporting from the owned ledger', () => {
  const base = {
    workspace_id: 'w',
    owner_id: 'u',
    visibility: 'private' as const,
    created_at: '2026-10-01',
    updated_at: '2026-10-01',
  };
  const accounts: Account[] = [
    { ...base, id: 'a', name: 'Everyday', currency: 'INR', opening_balance: 0 },
    { ...base, id: 'usd', name: 'Dollar account', currency: 'USD', opening_balance: 0 },
  ];
  const filter: ReportFilter = {
    workspace: 'w',
    user: 'u',
    from: '2026-10-01',
    to: '2026-10-31',
    currency: 'all',
  };
  const entry = (
    id: string,
    amount: number,
    kind: Transaction['kind'],
    date = '2026-10-12',
    extra: Partial<Transaction> = {},
  ): Transaction => ({
    ...base,
    id,
    title: id,
    amount,
    kind,
    booked_on: date,
    account_id: 'a',
    category: 'Food',
    project_id: null,
    transfer_id: null,
    ...extra,
  });
  const report = (rows: Transaction[], budgets: Budget[] = [], f = filter) =>
    financeReports(rows, accounts, budgets, [], f);
  it('separates income, expenses, external principal cash and internal transfers', () => {
    const r = report([
      entry('income', 1000, 'income'),
      entry('food', 100, 'expense'),
      entry('interest', 10, 'expense', '2026-10-12', { loan_id: 'l' }),
      entry('borrowed', 500, 'transfer_in', '2026-10-12', { loan_id: 'l' }),
      entry('repay', 50, 'transfer_out', '2026-10-12', { loan_id: 'l' }),
      entry('internal out', 300, 'transfer_out'),
      entry('internal in', 300, 'transfer_in'),
    ]).rows[0];
    expect(r).toMatchObject({
      income: 1000,
      expenses: 110,
      savings: 890,
      cashIn: 1500,
      cashOut: 160,
      cashNet: 1340,
      principalIn: 500,
      principalOut: 50,
      loanInterestPaid: 10,
      loanInterestReceived: 0,
    });
  });
  it('keeps currency totals separate and applies the selected currency to exports', () => {
    const r = report([
      entry('INR', 10, 'expense'),
      entry('USD', 20, 'expense', '2026-10-12', { account_id: 'usd' }),
    ]);
    expect(r.rows.map((g) => [g.currency, g.expenses])).toEqual([
      ['INR', 10],
      ['USD', 20],
    ]);
    const f = { ...filter, currency: 'USD' },
      only = report(r.transactions, [], f);
    expect(only.rows).toHaveLength(1);
    expect(only.transactions.map((t) => t.id)).toEqual(['USD']);
    expect(reportCsv(only, f)).not.toContain('Everyday');
  });
  it('uses inclusive booking dates, fills zero months, validates calendar ranges and equal-length comparisons', () => {
    const f = { ...filter, from: '2026-08-15', to: '2026-10-05' },
      r = report(
        [
          entry('first', 0.1, 'expense', f.from),
          entry('last', 0.2, 'expense', f.to),
          entry('excluded', 100, 'income', '2026-10-06'),
        ],
        [],
        f,
      );
    expect(r.rows[0].expenses).toBe(0.3);
    expect(r.rows[0].monthly.map((m) => [m.month, m.expenses])).toEqual([
      ['2026-08', 0.1],
      ['2026-09', 0],
      ['2026-10', 0.2],
    ]);
    expect(reportPeriod('2024-02-01', '2024-02-29')).toMatchObject({
      previousFrom: '2024-01-03',
      previousTo: '2024-01-31',
    });
    for (const [from, to] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-10-12', '2026-10-11'],
      ['', '2026-10-31'],
      ['1900-01-01', '1920-01-01'],
    ])
      expect(() => reportPeriod(from, to)).toThrow();
  });
  it('matches budgets by owner, month and currency without prorating partial months', () => {
    const budgets: Budget[] = [
      { ...base, id: 'b', currency: 'INR', category: 'Food', month: '2026-10-01', amount: 50 },
      { ...base, id: 'usd-b', currency: 'USD', category: 'Food', month: '2026-10-01', amount: 100 },
    ];
    const r = report(
      [
        entry('food', 60, 'expense', '2026-10-12'),
        entry('outside dates', 90, 'expense', '2026-10-01'),
        entry('usd', 2, 'expense', '2026-10-12', { account_id: 'usd' }),
      ],
      budgets,
      { ...filter, from: '2026-10-10', to: '2026-10-20' },
    );
    expect(r.rows[0].budgets[0]).toMatchObject({
      limit: 50,
      spent: 60,
      remaining: -10,
      percent: 120,
    });
    expect(r.rows[1].budgets[0]).toMatchObject({ limit: 100, spent: 2 });
  });
  it('compares categories including newly started and stopped spending', () => {
    const f = { ...filter, from: '2026-10-01', to: '2026-10-03' },
      r = report(
        [
          entry('current', 12, 'expense', '2026-10-02'),
          entry('old', 8, 'expense', '2026-09-30'),
          entry('new', 5, 'expense', '2026-10-03', { category: 'Books' }),
          entry('stopped', 10, 'expense', '2026-09-28', { category: 'Travel' }),
        ],
        [],
        f,
      ).rows[0];
    expect(r.categories.find((c) => c.category === 'Food')).toMatchObject({
      spent: 12,
      previous: 8,
      change: 4,
      percent: 50,
    });
    expect(r.categories.find((c) => c.category === 'Books')?.percent).toBeNull();
    expect(r.categories.find((c) => c.category === 'Travel')).toMatchObject({
      spent: 0,
      previous: 10,
      percent: -100,
    });
  });
  it('counts tagged subscriptions and loan interest as subsets, including cancelled plans', () => {
    const s = {
      ...base,
      id: 's',
      title: 'Cancelled membership',
      status: 'cancelled',
      recurring_id: null,
    } as Subscription;
    const r = financeReports(
      [
        entry('subscription', 10, 'expense', '2026-10-12', { subscription_id: 's' }),
        entry('interest', 4, 'expense', '2026-10-12', { loan_id: 'l' }),
        entry('received interest', 2, 'income', '2026-10-12', { loan_id: 'lent' }),
        entry('untagged schedule', 6, 'expense', '2026-10-12', { recurring_id: 'old' }),
      ],
      accounts,
      [],
      [s],
      filter,
    ).rows[0];
    expect(r).toMatchObject({
      expenses: 20,
      income: 2,
      subscriptionExpenses: 10,
      loanInterestPaid: 4,
      loanInterestReceived: 2,
    });
    expect(r.subscriptionBreakdown).toEqual([{ id: 's', title: s.title, spent: 10 }]);
  });
  it('excludes stale, foreign-owned, cross-workspace and unmatched account records', () => {
    const r = report([
      entry('own', 10, 'expense'),
      entry('other owner', 100, 'expense', '2026-10-12', { owner_id: 'someone' }),
      entry('other workspace', 100, 'expense', '2026-10-12', { workspace_id: 'elsewhere' }),
      entry('unavailable account', 100, 'expense', '2026-10-12', { account_id: 'missing' }),
    ]);
    expect(r.rows[0].expenses).toBe(10);
    expect(report(r.transactions, [], { ...filter, user: '' }).rows).toHaveLength(0);
  });
  it('exports filtered aggregates and transaction identity with safe CSV quoting', () => {
    const r = report([
        entry('safe', 10.25, 'expense', '2026-10-12', {
          title: '=HYPERLINK("bad")',
          category: 'a,b',
        }),
        entry('not exported', 1, 'expense', '2025-01-01'),
      ]),
      output = reportCsv(r, filter);
    expect(output).toContain('net_cash_flow');
    expect(output).toContain('monthly');
    expect(output).toContain("'=HYPERLINK");
    expect(output).toContain('a,b');
    expect(output).toContain('10.25');
    expect(output).toContain('2026-10-01');
    expect(output).not.toContain('not exported');
  });
  it('preserves demo subscription attribution through disconnection and cancellation', async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const library = TestBed.inject(SubscriptionLibrary),
      id = crypto.randomUUID(),
      input = {
        title: 'Sample membership',
        amount: '10',
        currency: 'INR',
        frequency: 'monthly' as const,
        next_on: library.today(),
        status: 'active' as const,
        trial_ends_on: '',
        category: 'Subscriptions',
        provider_url: '',
        notes: '',
        link_mode: 'create' as const,
        account_id: 'a1',
        recurring_id: '',
        automatic: false,
      };
    await library.save(id, input);
    await library.post(store.subscriptions()[0]);
    await library.save(id, { ...input, link_mode: 'track' }, store.subscriptions()[0]);
    await library.cancel(store.subscriptions()[0]);
    expect(store.transactions().find((t) => t.subscription_id === id)?.amount).toBe(10);
    store.clear();
    expect(store.transactions()).toHaveLength(0);
  });
});
