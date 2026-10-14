import { HouseholdBudget, HouseholdSpending, HouseholdBudgetInput } from '../../core/models/domain';
import { cents, csv } from './finance';
export function validateHouseholdBudget(input: HouseholdBudgetInput) {
  const v = {
    ...input,
    category: input.category.trim(),
    currency: input.currency.trim().toUpperCase(),
    amount: input.amount.trim(),
  };
  if (
    !v.category ||
    v.category.length > 100 ||
    v.category.includes('\0') ||
    v.notes.length > 2000 ||
    v.notes.includes('\0') ||
    (!/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(v.month) &&
      !/^(?:2100)-(?:0[1-9]|1[0-2])$/.test(v.month)) ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !['private', 'workspace'].includes(v.visibility) ||
    !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(v.amount) ||
    Number(v.amount) <= 0 ||
    Number(v.amount) > 1000000000
  )
    throw new Error(
      'Enter a category, valid month/currency and a positive budget limit with at most two decimals.',
    );
  return { ...v, amount: Number(v.amount) };
}
export function householdBudgetBalance(budget: HouseholdBudget, spending: HouseholdSpending[]) {
  const spent = spending
      .filter(
        (s) => s.budget_id === budget.id && s.workspace_id === budget.workspace_id && !s.withdrawn,
      )
      .reduce((total, s) => total + cents(s.amount), 0),
    limit = cents(budget.amount);
  return {
    spent: spent / 100,
    remaining: Math.max(0, limit - spent) / 100,
    overspent: Math.max(0, spent - limit) / 100,
    percent: Math.round((spent / limit) * 100),
  };
}
export function householdBudgetTotals(budgets: HouseholdBudget[], spending: HouseholdSpending[]) {
  const totals = new Map<
    string,
    { currency: string; limit: number; spent: number; remaining: number; overspent: number }
  >();
  for (const b of budgets.filter((b) => !b.archived)) {
    const s = householdBudgetBalance(b, spending),
      t = totals.get(b.currency) ?? {
        currency: b.currency,
        limit: 0,
        spent: 0,
        remaining: 0,
        overspent: 0,
      };
    t.limit += cents(b.amount);
    t.spent += cents(s.spent);
    t.remaining += cents(s.remaining);
    t.overspent += cents(s.overspent);
    totals.set(b.currency, t);
  }
  return [...totals.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((t) => ({
      currency: t.currency,
      limit: t.limit / 100,
      spent: t.spent / 100,
      remaining: t.remaining / 100,
      overspent: t.overspent / 100,
    }));
}
export function householdBudgetsCsv(budgets: HouseholdBudget[], spending: HouseholdSpending[]) {
  return csv(
    budgets.map((b) => {
      const s = householdBudgetBalance(b, spending);
      return {
        category: b.category,
        month: b.month.slice(0, 7),
        currency: b.currency,
        sharing: b.visibility,
        limit: b.amount,
        spent: s.spent,
        remaining: s.remaining,
        overspent: s.overspent,
        archived: b.archived,
        notes: b.notes,
      };
    }),
  );
}
export function householdSpendingCsv(budget: HouseholdBudget, spending: HouseholdSpending[]) {
  return csv(
    spending
      .filter((s) => s.budget_id === budget.id && s.workspace_id === budget.workspace_id)
      .map((s) => ({
        category: budget.category,
        month: budget.month.slice(0, 7),
        currency: budget.currency,
        amount: s.amount,
        booked_on: s.booked_on,
        notes: s.notes,
        withdrawn: s.withdrawn,
      })),
  );
}
