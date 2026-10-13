import { Account, Transaction } from '../../core/models/domain';
import { validLoanDate } from './loans';

export interface FinanceImportRow {
  date: string;
  title: string;
  kind: 'income' | 'expense';
  amount: string;
  currency: string;
  category: string;
  reference: string;
}
export interface ImportPreviewRow {
  line: number;
  values: Record<string, string>;
  row: FinanceImportRow | null;
  status: 'ready' | 'duplicate' | 'invalid';
  messages: string[];
}
export const importHeaders = [
  'date',
  'title',
  'kind',
  'amount',
  'currency',
  'category',
  'reference',
];
export const importMaxBytes = 1024 * 1024;

/** Strict CSV quoting, including escaped quotes and newlines inside quoted fields. */
export function parseImportCsv(text: string): { line: number; cells: string[] }[] {
  if (new TextEncoder().encode(text).length > importMaxBytes)
    throw new Error('Choose a UTF-8 CSV file smaller than 1 MiB.');
  text = text.replace(/^\uFEFF/, '');
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [],
    cell = '',
    quoted = false,
    closed = false,
    line = 1,
    start = 1;
  const field = () => {
    cells.push(cell);
    cell = '';
    closed = false;
  };
  const record = () => {
    field();
    if (cells.some((c) => c.trim())) rows.push({ line: start, cells });
    cells = [];
    if (rows.length > 501) throw new Error('Import at most 500 transaction rows at a time.');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += c;
        if (c === '\n') line++;
      }
      continue;
    }
    if (c === ',') field();
    else if (c === '\r' || c === '\n') {
      record();
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      start = line;
    } else if (c === '"') {
      if (cell || closed) throw new Error(`Unexpected quote on line ${line}.`);
      quoted = true;
    } else {
      if (closed) throw new Error(`Unexpected text after a closing quote on line ${line}.`);
      cell += c;
    }
  }
  if (quoted) throw new Error(`Unclosed quoted field on line ${start}.`);
  if (cell || cells.length || closed) record();
  if (rows.length < 2) throw new Error('Include a header and at least one transaction row.');
  return rows;
}
export function importFingerprint(r: FinanceImportRow): string {
  return JSON.stringify([r.date, r.title, r.kind, Number(r.amount), r.category]);
}
export function transactionMatches(t: Transaction, r: FinanceImportRow): boolean {
  return (
    t.booked_on === r.date &&
    t.title.trim() === r.title &&
    t.kind === r.kind &&
    Number(t.amount) === Number(r.amount) &&
    t.category.trim() === r.category
  );
}
export function previewFinanceImport(
  text: string,
  account: Account,
  transactions: Transaction[],
  today: string,
): ImportPreviewRow[] {
  const parsed = parseImportCsv(text);
  const headers = parsed[0].cells.map((c) => c.trim().toLowerCase());
  if (
    new Set(headers).size !== headers.length ||
    headers.some((h) => !importHeaders.includes(h)) ||
    importHeaders.slice(0, 6).some((h) => !headers.includes(h))
  )
    throw new Error(
      'Use the template headers: date, title, kind, amount, currency, category; reference is optional.',
    );
  const ledger = transactions.filter(
    (t) =>
      t.account_id === account.id &&
      t.owner_id === account.owner_id &&
      t.workspace_id === account.workspace_id,
  );
  const fingerprints = new Set<string>(),
    references = new Map<string, string>();
  return parsed.slice(1).map(({ line, cells }) => {
    const values = Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]));
    values['reference'] ??= '';
    const errors: string[] = [];
    if (cells.length !== headers.length) errors.push('Column count does not match the header.');
    if (!validLoanDate(values['date']) || values['date'] < '1900-01-01' || values['date'] > today)
      errors.push('Use a real YYYY-MM-DD date from 1900 through today.');
    if (cells.some((c) => c.includes('\0'))) errors.push('Remove null characters from the row.');
    if (!values['title'] || values['title'].length > 200)
      errors.push('Title must contain 1–200 characters.');
    if (!['income', 'expense'].includes(values['kind']))
      errors.push('Kind must be income or expense.');
    if (
      !/^\d{1,12}(\.\d{1,2})?$/.test(values['amount']) ||
      Number(values['amount']) <= 0 ||
      Number(values['amount']) >= 1e12
    )
      errors.push(
        'Use a positive amount below one trillion, with at most two decimals and no separators.',
      );
    if (values['currency'] !== account.currency)
      errors.push(`Currency must match this account: ${account.currency}.`);
    if (!values['category'] || values['category'].length > 100)
      errors.push('Category must contain 1–100 characters.');
    if (values['reference'].length > 200)
      errors.push('Reference must contain at most 200 characters.');
    if (errors.length) return { line, values, row: null, status: 'invalid', messages: errors };
    const row = {
      ...values,
      amount: Number(values['amount']).toFixed(2),
    } as unknown as FinanceImportRow;
    const fingerprint = importFingerprint(row);
    const existingRef = row.reference
      ? ledger.find((t) => t.import_reference === row.reference)
      : undefined;
    const priorRef = row.reference ? references.get(row.reference) : undefined;
    if (
      (existingRef && !transactionMatches(existingRef, row)) ||
      (priorRef && priorRef !== fingerprint)
    )
      return {
        line,
        values,
        row: null,
        status: 'invalid',
        messages: ['This reference already identifies a different transaction.'],
      };
    const duplicate =
      !!existingRef ||
      !!priorRef ||
      fingerprints.has(fingerprint) ||
      ledger.some((t) => transactionMatches(t, row));
    fingerprints.add(fingerprint);
    if (row.reference) references.set(row.reference, fingerprint);
    return {
      line,
      values,
      row,
      status: duplicate ? 'duplicate' : 'ready',
      messages: duplicate ? ['Matching transaction or reference; skipped.'] : [],
    };
  });
}
