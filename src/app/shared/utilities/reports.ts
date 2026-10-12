import { Account, Budget, Subscription, Transaction } from '../../core/models/domain';
import { cents, csv } from './finance';
export interface ReportFilter {
  workspace: string;
  user: string;
  from: string;
  to: string;
  currency: string;
}
export function reportPeriod(from: string, to: string) {
  const valid = (s: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + 'T00:00:00Z')) &&
    new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to) || from > to || from < '1900-01-01' || to > '2100-12-31')
    throw new Error('Choose valid start and end dates between 1900 and 2100.');
  const start = Date.parse(from + 'T00:00:00Z'),
    end = Date.parse(to + 'T00:00:00Z'),
    months: string[] = [];
  let y = Number(from.slice(0, 4)),
    m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, '0')}` <= to.slice(0, 7)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
    if (months.length > 120)
      throw new Error('Choose a report period of up to 120 calendar months.');
  }
  const days = (end - start) / 86400000 + 1,
    date = (n: number) => new Date(n).toISOString().slice(0, 10);
  return {
    months,
    previousFrom: date(start - days * 86400000),
    previousTo: date(start - 86400000),
  };
}
export function financeReports(
  entries: Transaction[],
  accounts: Account[],
  budgets: Budget[],
  subscriptions: Subscription[],
  f: ReportFilter,
) {
  const period = reportPeriod(f.from, f.to);
  const own = (r: { workspace_id: string; owner_id: string }) =>
    !!f.workspace && !!f.user && r.workspace_id === f.workspace && r.owner_id === f.user;
  const accountMap = new Map(accounts.filter(own).map((a) => [a.id, a]));
  const visible = entries.filter((t) => own(t) && accountMap.has(t.account_id));
  const selected = visible.filter(
    (t) =>
      t.booked_on >= f.from &&
      t.booked_on <= f.to &&
      (f.currency === 'all' || accountMap.get(t.account_id)!.currency === f.currency),
  );
  const prior = visible.filter(
    (t) => t.booked_on >= period.previousFrom && t.booked_on <= period.previousTo,
  );
  const ownBudgets = budgets.filter(
    (b) =>
      own(b) &&
      b.month.slice(0, 7) >= f.from.slice(0, 7) &&
      b.month.slice(0, 7) <= f.to.slice(0, 7),
  );
  const currencies = [
    ...new Set(
      [...accountMap.values()].map((a) => a.currency).concat(ownBudgets.map((b) => b.currency)),
    ),
  ]
    .filter((c) => f.currency === 'all' || c === f.currency)
    .sort();
  const subscriptionMap = new Map(subscriptions.filter(own).map((s) => [s.id, s.title]));
  const amount = (rows: Transaction[]) => rows.reduce((sum, t) => sum + cents(t.amount), 0) / 100;
  const rows = currencies.map((currency) => {
    const tx = selected.filter((t) => accountMap.get(t.account_id)!.currency === currency),
      previous = prior.filter((t) => accountMap.get(t.account_id)!.currency === currency);
    const summarize = (list: Transaction[]) => {
      const income = amount(list.filter((t) => t.kind === 'income')),
        expenses = amount(list.filter((t) => t.kind === 'expense')),
        principalIn = amount(list.filter((t) => t.kind === 'transfer_in' && !!t.loan_id)),
        principalOut = amount(list.filter((t) => t.kind === 'transfer_out' && !!t.loan_id));
      return {
        income,
        expenses,
        savings: (cents(income) - cents(expenses)) / 100,
        principalIn,
        principalOut,
        cashIn: (cents(income) + cents(principalIn)) / 100,
        cashOut: (cents(expenses) + cents(principalOut)) / 100,
        cashNet: (cents(income) + cents(principalIn) - cents(expenses) - cents(principalOut)) / 100,
      };
    };
    const summary = summarize(tx),
      monthly = period.months.map((month) => ({
        month,
        ...summarize(tx.filter((t) => t.booked_on.startsWith(month))),
      }));
    const expense = tx.filter((t) => t.kind === 'expense'),
      oldExpense = previous.filter((t) => t.kind === 'expense');
    const categories = [...new Set([...expense, ...oldExpense].map((t) => t.category))]
      .map((category) => {
        const spent = amount(expense.filter((t) => t.category === category)),
          priorSpent = amount(oldExpense.filter((t) => t.category === category));
        return {
          category,
          spent,
          previous: priorSpent,
          change: (cents(spent) - cents(priorSpent)) / 100,
          percent: priorSpent ? Math.round(((spent - priorSpent) / priorSpent) * 100) : null,
          share: summary.expenses ? (spent / summary.expenses) * 100 : 0,
        };
      })
      .sort((a, b) => b.spent - a.spent || a.category.localeCompare(b.category));
    const comparisons = ownBudgets
      .filter((b) => b.currency === currency)
      .map((b) => {
        const spent = amount(
            expense.filter(
              (t) => t.category === b.category && t.booked_on.startsWith(b.month.slice(0, 7)),
            ),
          ),
          limit = Number(b.amount);
        return {
          id: b.id,
          month: b.month.slice(0, 7),
          category: b.category,
          limit,
          spent,
          remaining: (cents(limit) - cents(spent)) / 100,
          percent: limit ? (spent / limit) * 100 : 0,
        };
      })
      .sort((a, b) => a.month.localeCompare(b.month) || a.category.localeCompare(b.category));
    const subscriptionExpenses = expense.filter((t) => !!t.subscription_id),
      subscriptionBreakdown = [...new Set(subscriptionExpenses.map((t) => t.subscription_id!))]
        .map((id) => ({
          id,
          title: subscriptionMap.get(id) ?? 'Recorded subscription',
          spent: amount(subscriptionExpenses.filter((t) => t.subscription_id === id)),
        }))
        .sort((a, b) => b.spent - a.spent || a.title.localeCompare(b.title));
    return {
      currency,
      ...summary,
      monthly,
      categories,
      budgets: comparisons,
      subscriptionBreakdown,
      subscriptionExpenses: amount(subscriptionExpenses),
      loanInterestPaid: amount(tx.filter((t) => !!t.loan_id && t.kind === 'expense')),
      loanInterestReceived: amount(tx.filter((t) => !!t.loan_id && t.kind === 'income')),
      count: tx.length,
    };
  });
  return {
    rows,
    transactions: selected.sort(
      (a, b) => a.booked_on.localeCompare(b.booked_on) || a.id.localeCompare(b.id),
    ),
    accounts: accountMap,
    period,
  };
}
export type FinanceReport = ReturnType<typeof financeReports>;
export function reportCsv(report: FinanceReport, f: ReportFilter) {
  const records: Record<string, unknown>[] = [];
  const add = (
    section: string,
    currency: string,
    date: string,
    name: string,
    value: number,
    detail = '',
  ) =>
    records.push({
      section,
      currency,
      date,
      name,
      amount: value,
      detail,
      period_start: f.from,
      period_end: f.to,
    });
  for (const r of report.rows) {
    for (const [key, value] of Object.entries({
      income: r.income,
      expenses: r.expenses,
      net_savings: r.savings,
      loan_principal_in: r.principalIn,
      loan_principal_out: r.principalOut,
      cash_in: r.cashIn,
      cash_out: r.cashOut,
      net_cash_flow: r.cashNet,
      subscription_expenses: r.subscriptionExpenses,
      loan_interest_paid: r.loanInterestPaid,
      loan_interest_received: r.loanInterestReceived,
    }))
      add('summary', r.currency, '', key, value);
    for (const m of r.monthly)
      for (const key of [
        'income',
        'expenses',
        'savings',
        'principalIn',
        'principalOut',
        'cashIn',
        'cashOut',
        'cashNet',
      ] as const)
        add('monthly', r.currency, m.month, key, m[key]);
    for (const c of r.categories) {
      add('category', r.currency, '', c.category, c.spent, 'selected period');
      add(
        'category_previous',
        r.currency,
        '',
        c.category,
        c.previous,
        report.period.previousFrom + ' through ' + report.period.previousTo,
      );
    }
    for (const b of r.budgets) {
      add('budget_limit', r.currency, b.month, b.category, b.limit, 'full monthly limit');
      add('budget_actual', r.currency, b.month, b.category, b.spent, 'selected dates only');
    }
    for (const s of r.subscriptionBreakdown)
      add('subscription', r.currency, '', s.title, s.spent, s.id);
  }
  for (const t of report.transactions)
    add(
      'transaction',
      report.accounts.get(t.account_id)!.currency,
      t.booked_on,
      t.title,
      Number(t.amount),
      [
        t.kind,
        t.category,
        report.accounts.get(t.account_id)!.name,
        t.id,
        t.loan_id ?? '',
        t.subscription_id ?? '',
      ].join(' · '),
    );
  return csv(records);
}
