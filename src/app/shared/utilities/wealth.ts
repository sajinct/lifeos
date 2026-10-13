import {
  Account,
  Asset,
  HoldingInput,
  InvestmentEntry,
  InvestmentHolding,
  InvestmentInput,
  Loan,
  Transaction,
  WealthAssetValue,
  WealthExclusion,
  WealthSourceKind,
  WealthTotals,
} from '../../core/models/domain';
import { accountBalance, cents } from './finance';
import { cardMoney } from './cards';
import { validLoanDate } from './loans';
export function validateHolding(v: HoldingInput, today: string) {
  const cost = cardMoney(v.opening_cost),
    value = cardMoney(v.opening_value);
  if (
    !v.title.trim() ||
    v.title.trim().length > 200 ||
    !['stock', 'fund', 'bond', 'deposit', 'crypto', 'other'].includes(v.kind) ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !validLoanDate(v.opened_on) ||
    v.opened_on < '1900-01-01' ||
    v.opened_on > today ||
    v.notes.length > 2000
  )
    throw new Error('Check holding name, type, currency, opening date and notes.');
  return { cost, value };
}
export function investmentChange(h: InvestmentHolding, v: InvestmentInput, today: string) {
  const amount = cardMoney(v.amount),
    basis = cardMoney(v.basis_removed);
  if (
    !['contribution', 'withdrawal', 'valuation'].includes(v.kind) ||
    !validLoanDate(v.occurred_on) ||
    v.occurred_on < h.last_entry_on ||
    v.occurred_on > today ||
    v.notes.length > 2000
  )
    throw new Error('Check entry type, chronological date and notes.');
  let cost = cents(h.current_cost),
    value = cents(h.current_value);
  if (v.kind === 'contribution') {
    if (amount <= 0 || basis !== 0)
      throw new Error('Contribution must be positive with no removed basis.');
    cost += cents(amount);
    value += cents(amount);
  } else if (v.kind === 'withdrawal') {
    if (cents(amount) > value || cents(basis) > cost || (!amount && !basis))
      throw new Error('Withdrawal exceeds value or cost basis.');
    cost -= cents(basis);
    value -= cents(amount);
  } else {
    if (basis !== 0 || v.account_id)
      throw new Error('Valuation cannot post to a bank account or remove basis.');
    value = cents(amount);
  }
  if (cost >= 1e14 || value >= 1e14) throw new Error('Holding value or cost is too large.');
  return { amount, basis, cost: cost / 100, value: value / 100 };
}
export function investmentPerformance(h: InvestmentHolding, entries: InvestmentEntry[]) {
  const active = entries.filter(
    (e) =>
      e.holding_id === h.id &&
      e.owner_id === h.owner_id &&
      e.workspace_id === h.workspace_id &&
      !e.voided,
  );
  const contributions = active
      .filter((e) => e.kind === 'contribution')
      .reduce((n, e) => n + cents(e.amount), 0),
    withdrawals = active
      .filter((e) => e.kind === 'withdrawal')
      .reduce((n, e) => n + cents(e.amount), 0),
    realized = active
      .filter((e) => e.kind === 'withdrawal')
      .reduce((n, e) => n + cents(e.amount) - cents(e.basis_removed), 0);
  const unrealized = cents(h.current_value) - cents(h.current_cost);
  return {
    contributions: contributions / 100,
    withdrawals: withdrawals / 100,
    realized: realized / 100,
    unrealized: unrealized / 100,
    gain: (realized + unrealized) / 100,
  };
}
export interface WealthSource {
  id: string;
  kind: WealthSourceKind;
  title: string;
  currency: string;
  value: number;
  component:
    'account' | 'investments' | 'physical_assets' | 'lent_principal' | 'borrowed_principal';
  date: string;
  estimated: boolean;
  included: boolean;
}
export function wealthSources(
  accounts: Account[],
  transactions: Transaction[],
  holdings: InvestmentHolding[],
  assets: Asset[],
  loans: Loan[],
  exclusions: WealthExclusion[],
  values: WealthAssetValue[],
  workspace: string,
  user: string,
  today: string,
): WealthSource[] {
  const own = (r: { workspace_id: string; owner_id: string }) =>
    !!workspace && !!user && r.workspace_id === workspace && r.owner_id === user;
  const included = (kind: WealthSourceKind, id: string) =>
    !exclusions.some((e) => own(e) && e.source_kind === kind && e.source_id === id && e.excluded);
  const ledger = transactions.filter((t) => own(t) && t.booked_on <= today);
  return [
    ...accounts.filter(own).map((a) => ({
      id: a.id,
      kind: 'account' as const,
      title: a.name,
      currency: a.currency,
      value: accountBalance(a, ledger),
      component: 'account' as const,
      date: today,
      estimated: false,
      included: included('account', a.id),
    })),
    ...holdings.filter(own).map((h) => ({
      id: h.id,
      kind: 'holding' as const,
      title: h.title,
      currency: h.currency,
      value: Number(h.current_value),
      component: 'investments' as const,
      date: h.last_entry_on,
      estimated: true,
      included: included('holding', h.id),
    })),
    ...assets
      .filter(
        (a) => own(a) && a.status === 'active' && (!a.purchased_on || a.purchased_on <= today),
      )
      .map((a) => {
        const v = values.find((v) => own(v) && v.asset_id === a.id && v.currency === a.currency);
        return {
          id: a.id,
          kind: 'asset' as const,
          title: a.name,
          currency: a.currency,
          value: Number(v?.amount ?? a.purchase_price ?? 0),
          component: 'physical_assets' as const,
          date: v?.valued_on ?? a.purchased_on ?? '',
          estimated: true,
          included: included('asset', a.id),
        };
      }),
    ...loans.filter(own).map((l) => ({
      id: l.id,
      kind: 'loan' as const,
      title: l.title,
      currency: l.currency,
      value:
        (Math.max(0, cents(l.principal) - cents(l.principal_paid)) / 100) *
        (l.direction === 'borrowed' ? -1 : 1),
      component:
        l.direction === 'borrowed' ? ('borrowed_principal' as const) : ('lent_principal' as const),
      date: today,
      estimated: false,
      included: included('loan', l.id),
    })),
  ];
}
export function wealthTotals(sources: WealthSource[]): WealthTotals[] {
  const groups = new Map<string, WealthTotals>();
  for (const s of sources.filter((s) => s.included)) {
    const g = groups.get(s.currency) ?? {
      currency: s.currency,
      account_assets: 0,
      account_debt: 0,
      investments: 0,
      physical_assets: 0,
      lent_principal: 0,
      borrowed_principal: 0,
      assets_total: 0,
      liabilities_total: 0,
      net: 0,
    };
    const n = cents(s.value);
    if (s.component === 'account') {
      g.account_assets += Math.max(0, n);
      g.account_debt += Math.max(0, -n);
    } else g[s.component] += Math.abs(n);
    groups.set(s.currency, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((g) => {
      g.assets_total = g.account_assets + g.investments + g.physical_assets + g.lent_principal;
      g.liabilities_total = g.account_debt + g.borrowed_principal;
      g.net = g.assets_total - g.liabilities_total;
      for (const key of [
        'account_assets',
        'account_debt',
        'investments',
        'physical_assets',
        'lent_principal',
        'borrowed_principal',
        'assets_total',
        'liabilities_total',
        'net',
      ] as const) {
        if (!Number.isSafeInteger(g[key]))
          throw new Error('Wealth totals exceed the supported precision.');
        g[key] /= 100;
      }
      return g;
    });
}
