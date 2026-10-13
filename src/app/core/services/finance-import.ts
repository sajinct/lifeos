import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  FinanceImportRow,
  previewFinanceImport,
  transactionMatches,
} from '../../shared/utilities/finance-import';
import { Transaction } from '../models/domain';
import { subscriptionToday } from '../../shared/utilities/subscriptions';

export interface FinanceImportRequest {
  id: string;
  workspace: string;
  user: string;
  session: number;
  account: string;
  rows: FinanceImportRow[];
}
@Injectable({ providedIn: 'root' })
export class FinanceImporter {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private demoBatches = new Map<string, { payload: string; imported: number; skipped: number }>();
  private stamp = '';
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  current(r: Pick<FinanceImportRequest, 'workspace' | 'user' | 'session'>) {
    return (
      r.workspace === this.store.workspace()?.id &&
      r.user === this.store.profile()?.id &&
      r.session === this.store.fileSession() &&
      (this.store.auth.demo() || r.user === this.store.auth.user()?.id)
    );
  }
  private account(id: string) {
    const s = this.store;
    if (!s.writable() || (!s.auth.demo() && s.profile()?.id !== s.auth.user()?.id))
      throw new Error('Workspace write access required.');
    const a = s
      .accounts()
      .find(
        (a) =>
          a.id === id && a.workspace_id === s.workspace()?.id && a.owner_id === s.profile()?.id,
      );
    if (!a) throw new Error('Choose your own account.');
    if (s.creditCards().some((c) => c.account_id === id && c.archived))
      throw new Error('Restore the archived card before importing.');
    return a;
  }
  preview(text: string, account: string) {
    return previewFinanceImport(
      text,
      this.account(account),
      this.store.transactions(),
      this.today(),
    );
  }
  prepare(account: string, rows: FinanceImportRow[]): FinanceImportRequest {
    const a = this.account(account);
    if (!rows.length || rows.length > 500) throw new Error('Choose 1 to 500 valid rows.');
    return {
      id: crypto.randomUUID(),
      workspace: a.workspace_id,
      user: a.owner_id,
      session: this.store.fileSession(),
      account,
      rows: rows.map((r) => ({ ...r })),
    };
  }
  async save(request: FinanceImportRequest) {
    if (!this.current(request)) throw new Error('Workspace changed; preview the file again.');
    const a = this.account(request.account);
    // Revalidate even programmatically prepared rows; the server independently enforces every boundary.
    const keys = ['date', 'title', 'kind', 'amount', 'currency', 'category', 'reference'] as const;
    const literalCsv = [
      keys.join(','),
      ...request.rows.map((r) =>
        keys.map((k) => `"${String(r[k] ?? '').replaceAll('"', '""')}"`).join(','),
      ),
    ].join('\r\n');
    const validated = previewFinanceImport(literalCsv, a, [], this.today());
    if (validated.some((r) => r.status === 'invalid'))
      throw new Error('Invalid import rows; preview again.');
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend.requireClient().rpc('import_finance_csv', {
        entry: request.id,
        w: request.workspace,
        account: request.account,
        rows: request.rows.map((r) => ({ ...r })),
      });
      if (error) throw error;
      if (!data) throw new Error('Import result unavailable; retry this batch.');
      if (this.current(request)) {
        await this.store.switchWorkspace(this.store.workspace()!);
        if (this.current(request) && this.store.error())
          throw new Error('Import saved, but refresh failed. Retry this batch safely.');
      }
      return data;
    }
    const stamp = `${request.session}:${request.workspace}:${request.user}`;
    if (this.stamp !== stamp) {
      this.demoBatches.clear();
      this.stamp = stamp;
    }
    const payload = JSON.stringify([request.account, request.rows]);
    const old = this.demoBatches.get(request.id);
    if (old) {
      if (old.payload !== payload) throw new Error('Import request reused.');
      return { imported: old.imported, skipped: old.skipped };
    }
    const ledger = this.store
      .transactions()
      .filter(
        (t) =>
          t.account_id === a.id && t.owner_id === a.owner_id && t.workspace_id === a.workspace_id,
      );
    const inserted: Transaction[] = [],
      now = new Date().toISOString();
    let skipped = 0;
    for (const r of request.rows) {
      const ref = r.reference ? ledger.find((t) => t.import_reference === r.reference) : undefined;
      if (ref && !transactionMatches(ref, r))
        throw new Error('Reference already identifies a different transaction.');
      if (ref || ledger.some((t) => transactionMatches(t, r))) {
        skipped++;
        continue;
      }
      const tx = {
        id: crypto.randomUUID(),
        workspace_id: a.workspace_id,
        owner_id: a.owner_id,
        visibility: 'private' as const,
        created_at: now,
        updated_at: now,
        account_id: a.id,
        title: r.title,
        amount: Number(r.amount),
        kind: r.kind,
        category: r.category,
        booked_on: r.date,
        transfer_id: null,
        project_id: null,
        import_batch_id: request.id,
        import_reference: r.reference || null,
      };
      ledger.push(tx);
      inserted.push(tx);
    }
    this.store.transactions.update((list) => [...list, ...inserted]);
    const result = { imported: inserted.length, skipped };
    this.demoBatches.set(request.id, { payload, ...result });
    return result;
  }
}
