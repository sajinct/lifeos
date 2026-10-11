import { Account, Transaction } from '../../core/models/domain';
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
