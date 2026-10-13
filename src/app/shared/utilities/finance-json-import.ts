import { Account, Transaction } from '../../core/models/domain';
import {
  FinanceImportRow,
  importFingerprint,
  previewFinanceImport,
  transactionMatches,
} from './finance-import';

export const jsonImportMaxBytes = 5 * 1024 * 1024;
export interface JsonSourceAccount {
  source_id: string;
  name: string;
  currency: string;
  opening_balance: string;
  card_source: boolean;
  error: string;
}
export interface JsonSourceTransaction {
  index: number;
  source_id: string;
  account_source: string;
  title: string;
  row: FinanceImportRow | null;
  status: 'ready' | 'invalid' | 'unsupported';
  message: string;
}
export interface FinanceJsonSource {
  accounts: JsonSourceAccount[];
  transactions: JsonSourceTransaction[];
  omitted: string[];
}
export interface JsonAccountPlan {
  source_id: string;
  name: string;
  currency: string;
  opening_balance: string;
  card_source: boolean;
  target_id: string | null;
}
export interface JsonTransactionPlan {
  source_id: string;
  account_source: string;
  row: FinanceImportRow;
}
export interface FinanceJsonPayload {
  accounts: JsonAccountPlan[];
  transactions: JsonTransactionPlan[];
}
export interface FinanceJsonResult {
  accounts_created: number;
  accounts_reused: number;
  imported: number;
  skipped: number;
}
export interface FinanceJsonLink {
  id: string;
  workspace_id: string;
  owner_id: string;
  source_kind: 'account' | 'transaction';
  source_id: string;
  account_id: string;
  transaction_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}
export interface JsonReviewRow extends Omit<JsonSourceTransaction, 'status'> {
  status: 'ready' | 'invalid' | 'unsupported' | 'duplicate' | 'unmapped';
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function identity(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 200 || v.includes('\0'))
    throw new Error('Every account and transaction needs a unique source ID of 1–200 characters.');
  return v.trim();
}
function money(v: unknown, signed = false): string {
  if (typeof v !== 'number' && typeof v !== 'string')
    throw new Error('Enter a decimal opening balance.');
  const s = String(v);
  if (
    !(signed ? /^-?\d{1,12}(\.\d{1,2})?$/ : /^\d{1,12}(\.\d{1,2})?$/).test(s) ||
    !Number.isFinite(Number(s)) ||
    Math.abs(Number(s)) >= 1e12
  )
    throw new Error('Opening balance must be below one trillion with at most two decimals.');
  return Number(s).toFixed(2);
}
export function literalFinanceCsv(rows: FinanceImportRow[]): string {
  const keys = ['date', 'title', 'kind', 'amount', 'currency', 'category', 'reference'] as const;
  return [
    keys.join(','),
    ...rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replaceAll('"', '""')}"`).join(',')),
  ].join('\r\n');
}
export function parseFinanceJson(text: string, today: string): FinanceJsonSource {
  if (new TextEncoder().encode(text).length > jsonImportMaxBytes)
    throw new Error('Choose a UTF-8 JSON file no larger than 5 MiB.');
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (!object(root) || !Array.isArray(root['accounts']) || !Array.isArray(root['transactions']))
    throw new Error('Use a LifeOS export with accounts and transactions arrays.');
  if (!root['accounts'].length || root['accounts'].length > 50 || root['transactions'].length > 500)
    throw new Error('Include 1–50 accounts and at most 500 transactions.');
  if (root['creditCards'] !== undefined && !Array.isArray(root['creditCards']))
    throw new Error('The creditCards section must be an array.');
  const cardAccounts = new Set(
    (root['creditCards'] as unknown[] | undefined)?.filter(object).map((c) => c['account_id']),
  );
  const ids = new Set<string>();
  const accounts = root['accounts'].map((v): JsonSourceAccount => {
    if (!object(v)) throw new Error('Each account must be an object.');
    const id = identity(v['id']);
    if (ids.has(id))
      throw new Error('Duplicate account source IDs; correct the export before importing.');
    ids.add(id);
    const a = {
      source_id: id,
      name: typeof v['name'] === 'string' ? v['name'].trim() : '',
      currency: typeof v['currency'] === 'string' ? v['currency'] : '',
      opening_balance: '',
      card_source: cardAccounts.has(id),
      error: '',
    };
    try {
      if (!a.name || a.name.length > 100 || a.name.includes('\0') || !/^[A-Z]{3}$/.test(a.currency))
        throw new Error('Check account name (1–100 characters) and three-letter currency.');
      a.opening_balance = money(v['opening_balance'], true);
    } catch (e) {
      a.error = (e as Error).message;
    }
    return a;
  });
  const txIds = new Set<string>();
  const transactions = root['transactions'].map((v, index): JsonSourceTransaction => {
    if (!object(v)) throw new Error('Each transaction must be an object.');
    const id = identity(v['id']);
    if (txIds.has(id))
      throw new Error('Duplicate transaction source IDs; correct the export before importing.');
    txIds.add(id);
    const source = typeof v['account_id'] === 'string' ? v['account_id'].trim() : '';
    const base = {
      index,
      source_id: id,
      account_source: source,
      title: typeof v['title'] === 'string' ? v['title'] : '',
      row: null,
      status: 'invalid' as const,
      message: '',
    };
    if (
      !['income', 'expense'].includes(String(v['kind'])) ||
      [
        'transfer_id',
        'loan_id',
        'loan_repayment_id',
        'project_id',
        'subscription_id',
        'bill_id',
        'recurring_id',
      ].some((key) => v[key] !== undefined && v[key] !== null && v[key] !== '')
    )
      return {
        ...base,
        status: 'unsupported',
        message:
          'Transfer or linked module entry; use its dedicated flow. These links are not restored.',
      };
    const a = accounts.find((a) => a.source_id === source);
    if (!a || a.error) return { ...base, message: 'The source account is missing or invalid.' };
    if (v['currency'] !== undefined && v['currency'] !== a.currency)
      return { ...base, message: 'Transaction currency differs from its source account.' };
    const keys = ['booked_on', 'title', 'kind', 'category'];
    if (
      keys.some((k) => typeof v[k] !== 'string') ||
      !['number', 'string'].includes(typeof v['amount']) ||
      (v['import_reference'] != null && typeof v['import_reference'] !== 'string')
    )
      return { ...base, message: 'Check transaction field types.' };
    const row = {
      date: v['booked_on'],
      title: v['title'],
      kind: v['kind'],
      amount: String(v['amount']),
      currency: a.currency,
      category: v['category'],
      reference: v['import_reference'] ?? '',
    } as FinanceImportRow;
    const checked = previewFinanceImport(
      literalFinanceCsv([row]),
      { id: source, owner_id: '', workspace_id: '', currency: a.currency } as Account,
      [],
      today,
    )[0];
    return {
      ...base,
      title: checked.values['title'],
      row: checked.row,
      status: checked.status === 'invalid' ? 'invalid' : 'ready',
      message: checked.messages.join(' '),
    };
  });
  const omitted = Object.entries(root)
    .filter(
      ([key, value]) =>
        !['accounts', 'transactions', 'workspace'].includes(key) &&
        ((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value != null)),
    )
    .map(([key]) => key);
  return { accounts, transactions, omitted };
}
export function reviewFinanceJson(
  source: FinanceJsonSource,
  mapping: Record<string, string>,
  accounts: Account[],
  ledger: Transaction[],
  links: FinanceJsonLink[],
  workspace: string,
  user: string,
): JsonReviewRow[] {
  const fingerprints = new Set<string>(),
    references = new Map<string, string>();
  return source.transactions.map((t): JsonReviewRow => {
    if (!t.row || t.status !== 'ready') return t;
    const target = mapping[t.account_source],
      a = source.accounts.find((a) => a.source_id === t.account_source)!;
    if (!target || target === 'skip')
      return { ...t, status: 'unmapped', message: 'Choose a destination for the source account.' };
    const existing =
      target === 'new'
        ? null
        : accounts.find(
            (a) => a.id === target && a.workspace_id === workspace && a.owner_id === user,
          );
    if (target !== 'new' && (!existing || existing.currency !== a.currency))
      return { ...t, status: 'invalid', message: 'Choose your own same-currency account.' };
    const bound = links.find((l) => l.source_kind === 'account' && l.source_id === a.source_id);
    if (bound && bound.account_id !== target)
      return {
        ...t,
        status: 'invalid',
        message: 'This source account already has a saved destination.',
      };
    const old = links.find((l) => l.source_kind === 'transaction' && l.source_id === t.source_id);
    if (old) {
      const same =
        old.details['account_source'] === t.account_source &&
        object(old.details['row']) &&
        Object.keys(t.row).every(
          (k) =>
            (old.details['row'] as Record<string, unknown>)[k] ===
            t.row![k as keyof FinanceImportRow],
        );
      return {
        ...t,
        status: same ? 'duplicate' : 'invalid',
        message: same
          ? 'Previously imported source ID; skipped.'
          : 'Source ID contents changed; correct separately.',
      };
    }
    const ownedLedger = ledger.filter(
      (l) => l.workspace_id === workspace && l.owner_id === user && l.account_id === target,
    );
    const idMatch = ownedLedger.find((l) => l.id === t.source_id);
    const refMatch = t.row.reference
      ? ownedLedger.find((l) => l.import_reference === t.row!.reference)
      : null;
    if (
      (idMatch && !transactionMatches(idMatch, t.row)) ||
      (refMatch && !transactionMatches(refMatch, t.row))
    )
      return {
        ...t,
        status: 'invalid',
        message: 'Source ID or reference already identifies different contents.',
      };
    const key = `${target === 'new' ? a.source_id : target}:${importFingerprint(t.row)}`;
    const ref = `${target === 'new' ? a.source_id : target}:${t.row.reference}`;
    if (t.row.reference && references.has(ref) && references.get(ref) !== key)
      return {
        ...t,
        status: 'invalid',
        message: 'This reference identifies different rows in the file.',
      };
    const duplicate =
      !!idMatch ||
      !!refMatch ||
      fingerprints.has(key) ||
      ownedLedger.some((l) => transactionMatches(l, t.row!));
    fingerprints.add(key);
    if (t.row.reference) references.set(ref, key);
    return {
      ...t,
      status: duplicate ? 'duplicate' : 'ready',
      message: duplicate ? 'Matching transaction; skipped.' : '',
    };
  });
}
