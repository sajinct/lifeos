import { Loan, LoanInput } from '../../core/models/domain';
import { cents, recurrenceDate } from './finance';
export function validLoanDate(s: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s + 'T00:00:00Z')) &&
    new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s
  );
}
export function loanTerms(v: LoanInput, today: string) {
  if (
    !v.title.trim() ||
    v.title.trim().length > 200 ||
    !v.counterparty.trim() ||
    v.counterparty.trim().length > 200 ||
    v.notes.length > 2000 ||
    !['borrowed', 'lent'].includes(v.direction) ||
    !/^[A-Z]{3}$/.test(v.currency)
  )
    throw new Error('Enter a loan name, counterparty and valid currency.');
  if (
    !/^\d{1,12}(\.\d{1,2})?$/.test(v.principal) ||
    Number(v.principal) <= 0 ||
    !/^\d{1,3}(\.\d{1,2})?$/.test(v.annual_rate) ||
    Number(v.annual_rate) > 100 ||
    !Number.isInteger(v.installments) ||
    v.installments < 1 ||
    v.installments > 600
  )
    throw new Error('Check principal, annual rate (0–100%) and monthly installments (1–600).');
  if (
    !validLoanDate(v.opened_on) ||
    !validLoanDate(v.first_due_on) ||
    v.opened_on > today ||
    v.first_due_on < v.opened_on ||
    v.opened_on < '1900-01-01' ||
    v.first_due_on > '2100-12-31'
  )
    throw new Error('Loan must start today or earlier; first due date must follow its start.');
  const principal = cents(v.principal),
    interest = Number(
      (BigInt(principal) * BigInt(cents(v.annual_rate)) * BigInt(v.installments) + 60000n) /
        120000n,
    ),
    total = principal + interest,
    installment = Math.ceil(total / v.installments);
  if (total > 99999999999999 || installment * (v.installments - 1) >= total)
    throw new Error('Loan total is too large or there are too many installments for this amount.');
  return {
    principal: principal / 100,
    interest: interest / 100,
    installment: installment / 100,
    total: total / 100,
  };
}
export function outstanding(l: Loan) {
  return {
    principal: (cents(l.principal) - cents(l.principal_paid)) / 100,
    interest: (cents(l.interest_total) - cents(l.interest_paid)) / 100,
    total:
      (cents(l.principal) +
        cents(l.interest_total) -
        cents(l.principal_paid) -
        cents(l.interest_paid)) /
      100,
  };
}
export function loanSchedule(l: Loan) {
  const total = cents(l.principal) + cents(l.interest_total),
    paid = cents(l.principal_paid) + cents(l.interest_paid),
    step = cents(l.installment_amount);
  return Array.from({ length: l.installments }, (_, i) => {
    const end = Math.min(total, step * (i + 1)),
      start = step * i;
    return {
      number: i + 1,
      date: recurrenceDate(l.first_due_on, 'monthly', i),
      amount: (end - start) / 100,
      remaining: Math.max(0, end - Math.max(start, paid)) / 100,
    };
  });
}
export function loanTotals(rows: Loan[]) {
  const map = new Map<string, { currency: string; borrowed: number; lent: number }>();
  for (const l of rows) {
    const group = map.get(l.currency) ?? { currency: l.currency, borrowed: 0, lent: 0 };
    group[l.direction] += cents(outstanding(l).total);
    map.set(l.currency, group);
  }
  return [...map.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((g) => ({ ...g, borrowed: g.borrowed / 100, lent: g.lent / 100 }));
}

export function suggestedRepayment(l: Loan) {
  const balance = outstanding(l),
    amount = cents(loanSchedule(l).find((p) => p.remaining > 0)?.remaining ?? 0);
  const interest = Math.min(
    cents(balance.interest),
    Math.ceil(cents(l.interest_total) / l.installments),
    amount,
  );
  const principal = Math.min(cents(balance.principal), amount - interest);
  return { principal: principal / 100, interest: (amount - principal) / 100 };
}
