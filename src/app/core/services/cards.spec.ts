import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { CardLibrary } from './cards';
import { Backend } from '../supabase/client';
import { CardInput, CreditCard } from '../models/domain';
import {
  billingDates,
  cardMoney,
  statementBalance,
  validateStatement,
} from '../../shared/utilities/cards';
import { accountBalance } from '../../shared/utilities/finance';
import { reminderSources } from '../../shared/utilities/reminders';
describe('Card billing and transfer payments', () => {
  let store: LifeStore, library: CardLibrary, card: CreditCard;
  const input: CardInput = {
    title: 'Everyday card',
    last_four: '1234',
    currency: 'INR',
    opening_debt: '1000',
    credit_limit: '5000',
    closing_day: 31,
    due_day: 15,
    notes: '',
    reminders_enabled: true,
  };
  const stmt = {
    cycle_end: '2024-01-31',
    due_on: '2024-02-15',
    amount: '1000',
    minimum_due: '100',
    notes: '',
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(CardLibrary);
    await library.saveCard('card', input);
    card = store.creditCards()[0];
    await library.saveStatement('statement', card, stmt);
  });
  const payment = (amount = '250') => ({ source: 'a1', amount, date: '2024-02-01', notes: '' });
  it('clamps month-end billing dates without drifting and always suggests a due date after closing', () => {
    expect(billingDates('2024-03-01', 31, 15)).toEqual({
      cycle_end: '2024-02-29',
      due_on: '2024-03-15',
    });
    expect(billingDates('2025-03-01', 31, 31)).toEqual({
      cycle_end: '2025-02-28',
      due_on: '2025-03-31',
    });
    expect(billingDates('2024-03-31', 31, 31)).toEqual({
      cycle_end: '2024-03-31',
      due_on: '2024-04-30',
    });
  });
  it('rejects invalid monetary precision, nonfinite values and statement dates', () => {
    for (const v of ['NaN', '1.001', '-1', '1000000000000']) expect(() => cardMoney(v)).toThrow();
    for (const patch of [
      { minimum_due: '1001' },
      { cycle_end: '2024-02-30' },
      { due_on: '2024-01-31' },
    ])
      expect(() => validateStatement({ ...stmt, ...patch }, '2026-10-13')).toThrow();
  });
  it('keeps creation retries stable and guards stale card/statement edits', async () => {
    await library.saveCard('card', { ...input, title: 'Ignored' });
    expect(store.creditCards()).toHaveLength(1);
    expect(store.accounts().filter((a) => a.id === card.account_id)).toHaveLength(1);
    await library.saveCard('card', { ...input, title: 'Changed' }, card);
    await expect(library.saveCard('card', input, card)).rejects.toThrow(/changed/);
    const s = store.cardStatements()[0];
    await library.saveStatement(s.id, card, { ...stmt, minimum_due: '50' }, s);
    await expect(library.saveStatement(s.id, card, stmt, s)).rejects.toThrow(/changed/);
  });
  it('records paired transfers once, reduces minimum and remaining, and leaves expense totals unchanged', async () => {
    const s = store.cardStatements()[0],
      before = store.transactions().filter((t) => t.kind === 'expense').length;
    await library.pay('payment', s, payment());
    await library.pay('payment', s, payment());
    expect(
      store
        .transactions()
        .filter((t) => t.transfer_id === 'payment')
        .map((t) => t.kind)
        .sort(),
    ).toEqual(['transfer_in', 'transfer_out']);
    expect(store.transactions().filter((t) => t.kind === 'expense')).toHaveLength(before);
    expect(statementBalance(s, store.cardPayments())).toEqual({
      paid: 250,
      remaining: 750,
      minimum: 0,
    });
    expect(
      accountBalance(
        store.accounts().find((a) => a.id === card.account_id)!,
        store.transactions(),
      ),
    ).toBe(-750);
    await expect(library.pay('payment', s, payment('251'))).rejects.toThrow(/reused/);
    await expect(library.pay('other', s, payment('751'))).rejects.toThrow(/remaining/);
  });
  it('replaces earlier due snapshots instead of adding carried balances and restores history on cancellation', async () => {
    const s = store.cardStatements()[0];
    await library.pay('payment', s, payment());
    await library.saveStatement('newer', card, {
      ...stmt,
      cycle_end: '2024-02-29',
      due_on: '2024-03-15',
      amount: '750',
    });
    expect(store.cardStatements().filter((s) => s.status === 'open')).toHaveLength(1);
    await expect(library.pay('other', s, payment())).rejects.toThrow(/current/);
    await expect(library.voidPayment('payment')).rejects.toThrow(/newer/);
    await library.act(
      store.cardStatements().find((s) => s.id === 'newer')!,
      'statement',
      'cancel',
    );
    expect(store.cardStatements().find((s) => s.id === 'statement')!.status).toBe('open');
  });
  it('credits a payment recorded against an older statement after the new closing date', async () => {
    await library.pay('late', store.cardStatements()[0], { ...payment('250'), date: '2024-03-01' });
    await library.saveStatement('newer', card, {
      ...stmt,
      cycle_end: '2024-02-29',
      due_on: '2024-03-15',
    });
    expect(
      statementBalance(
        store.cardStatements().find((s) => s.id === 'newer')!,
        store.cardPayments(),
      ),
    ).toEqual({ paid: 250, remaining: 750, minimum: 0 });
    await expect(
      library.pay(
        'too-much',
        store.cardStatements().find((s) => s.id === 'newer')!,
        { ...payment('751'), date: '2024-03-02' },
      ),
    ).rejects.toThrow(/remaining/);
    await expect(store.transfer('a1', card.account_id, '1', 'generic')).rejects.toThrow(
      /Credit cards/,
    );
  });
  it('preserves payment corrections as one reversal and guards statement totals below paid', async () => {
    await library.pay('payment', store.cardStatements()[0], payment());
    await expect(
      library.saveStatement(
        'statement',
        card,
        { ...stmt, amount: '249' },
        store.cardStatements()[0],
      ),
    ).rejects.toThrow(/below/);
    await library.voidPayment('payment');
    await library.voidPayment('payment');
    expect(store.cardPayments()[0].voided).toBe(true);
    expect(
      store.transactions().filter((t) => t.transfer_id === store.cardPayments()[0].reversal_id),
    ).toHaveLength(2);
    expect(
      accountBalance(
        store.accounts().find((a) => a.id === card.account_id)!,
        store.transactions(),
      ),
    ).toBe(-1000);
  });
  it('rejects foreign accounts, card-to-card payments, over-debt and future payments', async () => {
    const s = store.cardStatements()[0];
    await expect(library.pay('x', s, { ...payment(), source: card.account_id })).rejects.toThrow(
      /bank/,
    );
    await expect(library.pay('x', s, { ...payment(), source: 'missing' })).rejects.toThrow(/bank/);
    await expect(library.pay('x', s, { ...payment(), date: '2099-01-01' })).rejects.toThrow(/date/);
    await library.saveStatement('statement', card, { ...stmt, amount: '1100' }, s);
    await expect(library.pay('x', store.cardStatements()[0], payment('1001'))).rejects.toThrow(
      /debt/,
    );
  });
  it('requires both reminder opt-ins and removes paid sources', async () => {
    const sources = () =>
      reminderSources(
        { ...store.reminderPreferences(), bill_reminders: true },
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        new Date(),
        [],
        [],
        [],
        [],
        [],
        store.cardStatements(),
        store.cardPayments(),
        store.creditCards(),
      );
    expect(sources()).toHaveLength(1);
    await library.pay('p', store.cardStatements()[0], payment('1000'));
    expect(sources()).toHaveLength(0);
    await library.voidPayment('p');
    await library.saveCard('card', { ...input, reminders_enabled: false }, store.creditCards()[0]);
    expect(sources()).toHaveLength(0);
  });
  it('blocks archiving uncleared debt and clears cached card records on session reset', async () => {
    await expect(library.act(card, 'card', 'archive')).rejects.toThrow(/Clear/);
    await library.pay('p', store.cardStatements()[0], payment('1000'));
    await library.act(card, 'card', 'archive');
    await expect(library.pay('other', store.cardStatements()[0], payment('1'))).rejects.toThrow(
      /current/,
    );
    store.clear();
    expect(store.creditCards()).toEqual([]);
    expect(store.cardStatements()).toEqual([]);
    expect(store.cardPayments()).toEqual([]);
  });
  it('does not reload a previous workspace after a delayed cloud response', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    let resolve!: (v: unknown) => void;
    const rpc = vi.fn(() => new Promise((r) => (resolve = r)));
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.saveCard('new', input);
    store.fileSession.update((n) => n + 1);
    resolve({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
  });
});
