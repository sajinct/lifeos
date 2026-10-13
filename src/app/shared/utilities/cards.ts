import { CardInput, CardStatement, CardPayment, StatementInput } from '../../core/models/domain';
import { cents } from './finance';
import { validLoanDate } from './loans';
export function cardMoney(s: string) {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s) || Number(s) >= 1e12)
    throw new Error('Enter an amount below one trillion with up to two decimals.');
  return Number(s);
}
export function validateCard(v: CardInput) {
  if (
    !v.title.trim() ||
    v.title.trim().length > 200 ||
    (v.last_four && !/^\d{4}$/.test(v.last_four)) ||
    !/^[A-Z]{3}$/.test(v.currency) ||
    !Number.isInteger(v.closing_day) ||
    v.closing_day < 1 ||
    v.closing_day > 31 ||
    !Number.isInteger(v.due_day) ||
    v.due_day < 1 ||
    v.due_day > 31 ||
    v.notes.length > 2000
  )
    throw new Error('Check card name, last four digits, currency and billing days.');
  return { limit: cardMoney(v.credit_limit), debt: cardMoney(v.opening_debt) };
}
export function validateStatement(v: StatementInput, today: string) {
  const amount = cardMoney(v.amount),
    minimum = cardMoney(v.minimum_due);
  if (
    !validLoanDate(v.cycle_end) ||
    !validLoanDate(v.due_on) ||
    v.cycle_end < '1900-01-01' ||
    v.cycle_end > today ||
    v.due_on <= v.cycle_end ||
    v.due_on > '2100-12-31' ||
    minimum > amount ||
    v.notes.length > 2000
  )
    throw new Error('Check statement dates, total and minimum due.');
  return { amount, minimum };
}
export function statementBalance(s: CardStatement, payments: CardPayment[]) {
  const paid = payments
    .filter(
      (p) =>
        (s.status === 'open'
          ? p.card_id === s.card_id && p.booked_on > s.cycle_end
          : p.statement_id === s.id) &&
        p.workspace_id === s.workspace_id &&
        p.owner_id === s.owner_id &&
        !p.voided,
    )
    .reduce((n, p) => n + cents(p.amount), 0);
  return {
    paid: paid / 100,
    remaining: Math.max(0, cents(s.amount) - paid) / 100,
    minimum: Math.max(0, cents(s.minimum_due) - paid) / 100,
  };
}
function monthDay(year: number, month: number, day: number) {
  const d = new Date(
    Date.UTC(year, month, Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())),
  );
  return d.toISOString().slice(0, 10);
}
export function billingDates(today: string, closingDay: number, dueDay: number) {
  const [y, m] = today.split('-').map(Number);
  let end = monthDay(y, m - 1, closingDay);
  if (end > today) end = monthDay(y, m - 2, closingDay);
  return { cycle_end: end, due_on: suggestedCardDue(end, dueDay) };
}
export function suggestedCardDue(end: string, dueDay: number) {
  const [y, m] = end.split('-').map(Number);
  const same = monthDay(y, m - 1, dueDay);
  return same > end ? same : monthDay(y, m, dueDay);
}
