import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { LoanLibrary } from './loans';
import { Backend } from '../supabase/client';
import { User } from '@supabase/supabase-js';
import { DEFAULT_REMINDERS, LoanInput } from '../models/domain';
import {
  loanSchedule,
  loanTerms,
  loanTotals,
  outstanding,
  suggestedRepayment,
} from '../../shared/utilities/loans';
import { reminderSources, reminderTitle } from '../../shared/utilities/reminders';
describe('Loan contracts, schedules and repayment lifecycle', () => {
  let store: LifeStore, library: LoanLibrary, input: LoanInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(LoanLibrary);
    input = {
      title: 'Education loan',
      counterparty: 'Sample lender',
      direction: 'borrowed',
      currency: 'INR',
      principal: '1200',
      annual_rate: '12',
      installments: 12,
      opened_on: library.today(),
      first_due_on: library.today(),
      notes: '',
      account_id: 'a1',
    };
  });
  it('calculates fixed simple interest in cents and validates dates and small installment totals', () => {
    expect(loanTerms(input, library.today())).toEqual({
      principal: 1200,
      interest: 144,
      total: 1344,
      installment: 112,
    });
    expect(
      loanTerms({ ...input, principal: '1', annual_rate: '6', installments: 1 }, library.today())
        .interest,
    ).toBe(0.01);
    for (const patch of [
      { annual_rate: '100.01' },
      { principal: '1.001' },
      { installments: 0 },
      { first_due_on: '2026-02-30' },
      { principal: '0.01' },
    ])
      expect(() => loanTerms({ ...input, ...patch }, library.today())).toThrow();
  });
  it('records initial principal and partial repayments once without inflating income/expense', async () => {
    const id = crypto.randomUUID();
    await library.create(id, input);
    await library.create(id, input);
    expect(store.loans()).toHaveLength(1);
    expect(store.transactions().filter((t) => t.loan_id === id)).toHaveLength(1);
    expect(suggestedRepayment(store.loans()[0])).toEqual({ principal: 100, interest: 12 });
    const nonce = crypto.randomUUID(),
      row = store.loans()[0],
      v = { principal: '50', interest: '6', date: library.today(), account_id: 'a1', notes: '' };
    await library.repay(nonce, row, v);
    await library.repay(nonce, row, v);
    expect(store.loanRepayments()).toHaveLength(1);
    expect(store.loans()[0].next_due_on).toBe(input.first_due_on);
    expect(
      store
        .transactions()
        .filter((t) => t.loan_repayment_id === nonce)
        .map((t) => t.kind),
    ).toEqual(['transfer_out', 'expense']);
    await library.repay(crypto.randomUUID(), store.loans()[0], v);
    expect(store.loans()[0].next_due_on! > input.first_due_on).toBe(true);
    expect(outstanding(store.loans()[0]).total).toBe(1232);
  });
  it('rejects overpayment and currency mismatch, then settles and clears the due date', async () => {
    await library.create(crypto.randomUUID(), input);
    const row = store.loans()[0],
      v = { principal: '1201', interest: '0', date: library.today(), account_id: 'a1', notes: '' };
    await expect(library.repay(crypto.randomUUID(), row, v)).rejects.toThrow(/exceeds/);
    expect(store.loanRepayments()).toHaveLength(0);
    store.accounts.update((rows) => [...rows, { ...rows[0], id: 'usd', currency: 'USD' }]);
    await expect(
      library.repay(crypto.randomUUID(), row, { ...v, principal: '1', account_id: 'usd' }),
    ).rejects.toThrow(/currency/);
    await library.repay(crypto.randomUUID(), row, { ...v, principal: '1200', interest: '144' });
    expect(store.loans()[0]).toMatchObject({ status: 'paid', next_due_on: null });
  });
  it('keeps currencies separate, supports tracking-only history and anchors monthly dates', async () => {
    await library.create(crypto.randomUUID(), {
      ...input,
      principal: '100',
      annual_rate: '0',
      installments: 3,
      opened_on: '2025-01-01',
      first_due_on: '2025-01-31',
      account_id: '',
    });
    const row = store.loans()[0];
    expect(loanSchedule(row).map((p) => [p.date, p.amount])).toEqual([
      ['2025-01-31', 33.34],
      ['2025-02-28', 33.34],
      ['2025-03-31', 33.32],
    ]);
    await library.repay(crypto.randomUUID(), row, {
      principal: '33.34',
      interest: '0',
      date: library.today(),
      account_id: '',
      notes: '',
    });
    expect(store.loans()[0].next_due_on).toBe('2025-02-28');
    expect(store.transactions().some((t) => t.loan_id === row.id)).toBe(false);
    await library.create(crypto.randomUUID(), {
      ...input,
      currency: 'USD',
      direction: 'lent',
      principal: '10',
      annual_rate: '0',
      account_id: '',
    });
    expect(loanTotals(store.loans())).toEqual([
      { currency: 'INR', borrowed: 66.66, lent: 0 },
      { currency: 'USD', borrowed: 0, lent: 10 },
    ]);
  });
  it('opts into loan reminders and preserves private records across demo workspaces and logout', async () => {
    await library.create(crypto.randomUUID(), input);
    const p = { ...DEFAULT_REMINDERS, loan_reminders: true };
    const sources = reminderSources(p, [], [], [], [], store.loans());
    expect(sources).toHaveLength(1);
    expect(reminderTitle(sources[0], 'upcoming')).toContain('Loan repayment due');
    const w = store.workspace()!;
    await store.createWorkspace('Another', 'personal');
    expect(store.loans()).toHaveLength(0);
    await store.switchWorkspace(w);
    expect(store.loans()).toHaveLength(1);
    store.clear();
    expect(store.loans()).toHaveLength(0);
    expect(store.loanRepayments()).toHaveLength(0);
  });
  it('drops a late real save result after sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    let finish!: (v: { error: null }) => void;
    const rpc = vi.fn(
      () =>
        new Promise<{ error: null }>((r) => {
          finish = r;
        }),
    );
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc,
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.create(crypto.randomUUID(), input);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.loans()).toHaveLength(0);
  });
});
