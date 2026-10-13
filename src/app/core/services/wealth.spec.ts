import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { WealthLibrary } from './wealth';
import { Asset, HoldingInput } from '../models/domain';
import {
  investmentChange,
  investmentPerformance,
  validateHolding,
  wealthTotals,
} from '../../shared/utilities/wealth';
import { csv } from '../../shared/utilities/finance';
describe('Private investment bookkeeping and net worth', () => {
  let store: LifeStore, library: WealthLibrary;
  const input: HoldingInput = {
    title: 'Index fund',
    kind: 'fund',
    currency: 'INR',
    opened_on: '2024-01-01',
    opening_cost: '80',
    opening_value: '100',
    notes: '',
  };
  const current = () => store.investmentHoldings()[0];
  const change = (
    kind: 'contribution' | 'withdrawal' | 'valuation',
    amount: string,
    basis = '0',
    account = '',
  ) => ({
    kind,
    amount,
    basis_removed: basis,
    occurred_on: '2024-02-01',
    account_id: account,
    notes: '',
  });
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(WealthLibrary);
    await library.saveHolding('holding', input);
  });
  it('validates dates, monetary precision and cost/value bounds', () => {
    for (const patch of [
      { opening_cost: 'NaN' },
      { opening_value: '1.001' },
      { opened_on: '2099-01-01' },
    ])
      expect(() => validateHolding({ ...input, ...patch }, library.today())).toThrow();
    expect(() =>
      investmentChange(current(), change('withdrawal', '101', '1'), library.today()),
    ).toThrow(/exceeds/);
    expect(() =>
      investmentChange(current(), change('withdrawal', '1', '81'), library.today()),
    ).toThrow(/exceeds/);
    expect(() =>
      investmentChange(current(), change('valuation', '1', '0', 'a1'), library.today()),
    ).toThrow(/Valuation/);
  });
  it('protects opening balances, creation retries and stale edits', async () => {
    const old = current();
    await library.saveHolding('holding', { ...input, title: 'Ignored' });
    expect(current().title).toBe('Index fund');
    await expect(
      library.saveHolding('holding', { ...input, opening_cost: '81' }, old),
    ).rejects.toThrow(/Opening/);
    await library.saveHolding('holding', { ...input, title: 'Updated' }, old);
    await expect(library.saveHolding('holding', input, old)).rejects.toThrow(/changed/);
  });
  it('records funding as a transfer without changing net worth or expense totals', async () => {
    const before = wealthTotals(library.sources())[0].net,
      expenses = store.transactions().filter((t) => t.kind === 'expense').length,
      old = current();
    await library.append('fund', old, change('contribution', '50', '0', 'a1'));
    await library.append('fund', old, change('contribution', '50', '0', 'a1'));
    expect(wealthTotals(library.sources())[0].net).toBe(before);
    expect(store.transactions().filter((t) => t.kind === 'expense')).toHaveLength(expenses);
    expect(store.transactions().filter((t) => t.transfer_id === 'fund')).toHaveLength(1);
    await expect(
      library.append('fund', current(), change('contribution', '51', '0', 'a1')),
    ).rejects.toThrow(/reused/);
  });
  it('separates realized and unrealized gains after a withdrawal and preserves wealth across cash movement', async () => {
    await library.append('fund', current(), change('contribution', '50', '0', 'a1'));
    await library.append('mark', current(), change('valuation', '200'));
    const before = wealthTotals(library.sources())[0].net;
    await library.append('sell', current(), change('withdrawal', '60', '20', 'a1'));
    expect(current()).toMatchObject({ current_cost: 110, current_value: 140 });
    expect(investmentPerformance(current(), store.investmentEntries())).toEqual({
      contributions: 50,
      withdrawals: 60,
      realized: 40,
      unrealized: 30,
      gain: 70,
    });
    expect(wealthTotals(library.sources())[0].net).toBe(before);
  });
  it('undoes latest entries once and keeps funded reversals in the ledger', async () => {
    await library.append('fund', current(), change('contribution', '50', '0', 'a1'));
    const fund = store.investmentEntries()[0];
    await library.append('mark', current(), change('valuation', '200'));
    await expect(library.undo(fund, current())).rejects.toThrow(/newer/);
    await library.undo(store.investmentEntries()[0], current());
    const old = current();
    await library.undo(fund, old);
    await library.undo(fund, old);
    expect(current()).toMatchObject({ current_cost: 80, current_value: 100 });
    expect(
      store
        .transactions()
        .filter(
          (t) =>
            t.transfer_id === store.investmentEntries().find((e) => e.id === 'fund')!.reversal_id,
        ),
    ).toHaveLength(1);
  });
  it('rejects backwards dates, unavailable accounts and card funding', async () => {
    await library.append('fund', current(), change('contribution', '50'));
    await expect(
      library.append('past', current(), { ...change('valuation', '1'), occurred_on: '2024-01-01' }),
    ).rejects.toThrow(/chronological/);
    await expect(
      library.append('missing', current(), change('contribution', '1', '0', 'missing')),
    ).rejects.toThrow(/own/);
  });
  it('counts signed card accounts once, excludes future transactions and separates currencies', () => {
    const a = store.accounts()[0];
    store.accounts.set([
      { ...a, id: 'bank', opening_balance: 1000 },
      { ...a, id: 'card', opening_balance: -100 },
      { ...a, id: 'usd', currency: 'USD', opening_balance: 10 },
    ]);
    store.transactions.set([
      {
        ...store.transactions()[0],
        account_id: 'bank',
        kind: 'income',
        amount: 999,
        booked_on: '2099-01-01',
      },
    ]);
    const totals = wealthTotals(library.sources());
    expect(totals[0]).toMatchObject({
      currency: 'INR',
      account_assets: 1000,
      account_debt: 100,
      investments: 100,
      net: 1000,
    });
    expect(totals[1]).toMatchObject({ currency: 'USD', net: 10 });
  });
  it('freezes snapshots and excludes duplicate representations without touching the ledger', async () => {
    await library.snapshot('snapshot', 'Baseline');
    const old = store.wealthSnapshots()[0].totals[0].net;
    await library.exclude('exclude', 'holding', current().id, true);
    expect(wealthTotals(library.sources())[0].net).toBe(old - 100);
    expect(store.wealthSnapshots()[0].totals[0].net).toBe(old);
    await library.snapshot('snapshot', 'Ignored');
    expect(store.wealthSnapshots()).toHaveLength(1);
    expect(store.wealthSnapshots()[0].label).toBe('Baseline');
    await library.exclude('exclude', 'holding', current().id, false);
    expect(wealthTotals(library.sources())[0].net).toBe(old);
  });
  it('supports full loss disposal and cleared archive/restore while keeping histories', async () => {
    await expect(library.archive(current(), true)).rejects.toThrow(/Clear/);
    await library.append('loss', current(), change('valuation', '0'));
    await library.append('dispose', current(), change('withdrawal', '0', '80'));
    expect(investmentPerformance(current(), store.investmentEntries()).realized).toBe(-80);
    await library.archive(current(), true);
    await expect(library.append('fund', current(), change('contribution', '1'))).rejects.toThrow(
      /restore/,
    );
    await library.archive(current(), false);
    expect(store.investmentEntries()).toHaveLength(2);
  });
  it('uses a private manual asset value, keeps snapshots frozen and ignores mismatched currencies', async () => {
    const a: Asset = {
      ...store.accounts()[0],
      id: 'asset',
      name: 'Laptop',
      category: 'Electronics',
      manufacturer: '',
      model: '',
      serial_number: '',
      location: '',
      purchased_on: '2024-01-01',
      purchase_price: 300,
      currency: 'INR',
      warranty_until: null,
      notes: '',
      status: 'active',
      revision: 1,
    };
    store.assets.set([a]);
    const net = wealthTotals(library.sources())[0].net;
    await library.snapshot('baseline', 'Before valuation');
    await library.assetValue('value', a, '350', '2024-03-01', 'Manual');
    expect(wealthTotals(library.sources())[0].net).toBe(net + 50);
    expect(store.wealthSnapshots()[0].totals[0].net).toBe(net);
    const old = store.wealthAssetValues()[0];
    await library.assetValue('value', a, '360', '2024-04-01', 'Manual', old);
    await expect(library.assetValue('value', a, '370', '2024-04-01', '', old)).rejects.toThrow(
      /changed/,
    );
    store.assets.set([{ ...a, currency: 'USD' }]);
    expect(library.sources().find((s) => s.id === 'asset')).toMatchObject({
      currency: 'USD',
      value: 300,
    });
  });
  it('clears cached wealth on sign-out and escapes spreadsheet formulas', () => {
    expect(csv([{ title: '=SUM(A1)', notes: '+example' }])).toContain("'=SUM(A1)");
    store.clear();
    expect(store.investmentHoldings()).toEqual([]);
    expect(store.investmentEntries()).toEqual([]);
    expect(store.wealthSnapshots()).toEqual([]);
    expect(store.wealthExclusions()).toEqual([]);
    expect(store.wealthAssetValues()).toEqual([]);
  });
  it('ignores a late cloud completion after workspace/session reset', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    let resolve!: (v: unknown) => void;
    const rpc = vi.fn(() => new Promise((r) => (resolve = r)));
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.saveHolding('new', input);
    store.fileSession.update((n) => n + 1);
    resolve({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
  });
});
