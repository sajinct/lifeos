import { Account, Budget, Frequency, Transaction } from '../../core/models/domain';
export function recurrenceDate(anchor: string, frequency: Frequency, occurrence: number): string {
  const [year, month, day] = anchor.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (frequency === 'daily' || frequency === 'weekly')
    date.setDate(day + occurrence * (frequency === 'weekly' ? 7 : 1));
  else {
    date.setDate(1);
    date.setMonth(month - 1 + occurrence * (frequency === 'yearly' ? 12 : 1));
    const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(Math.min(day, last));
  }
  return localDate(date);
}
export function budgetSpent(budget: Budget, entries: Transaction[], accounts: Account[]): number {
  return (
    entries
      .filter(
        (t) =>
          t.owner_id === budget.owner_id &&
          t.workspace_id === budget.workspace_id &&
          t.kind === 'expense' &&
          t.category === budget.category &&
          t.booked_on.slice(0, 7) === budget.month.slice(0, 7) &&
          accounts.some((a) => a.id === t.account_id && a.currency === budget.currency),
      )
      .reduce((sum, t) => sum + cents(t.amount), 0) / 100
  );
}
export function cents(value: number | string): number {
  return Math.round(Number(value) * 100);
}
export function parseMoney(value: string): number {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value) || Number(value) <= 0)
    throw new Error('Enter a positive amount with at most two decimal places.');
  return Number(value);
}
export function accountBalance(account: Account, entries: Transaction[]): number {
  const total = entries
    .filter((t) => t.account_id === account.id)
    .reduce(
      (sum, t) =>
        sum +
        (t.kind === 'income' || t.kind === 'transfer_in' ? cents(t.amount) : -cents(t.amount)),
      cents(account.opening_balance),
    );
  return total / 100;
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    keys.map(cell).join(','),
    ...rows.map((row) => keys.map((k) => cell(row[k])).join(',')),
  ].join('\r\n');
}
