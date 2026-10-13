import { Injectable, inject } from '@angular/core';
import { Backend } from '../supabase/client';
import { Account } from '../models/domain';
import { LifeStore } from './life-store';
import {
  FinanceJsonLink,
  FinanceJsonPayload,
  FinanceJsonResult,
  FinanceJsonSource,
  literalFinanceCsv,
  parseFinanceJson,
  reviewFinanceJson,
} from '../../shared/utilities/finance-json-import';
import { previewFinanceImport, transactionMatches } from '../../shared/utilities/finance-import';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
export interface FinanceJsonRequest {
  id: string;
  workspace: string;
  user: string;
  session: number;
  payload: FinanceJsonPayload;
}
@Injectable({ providedIn: 'root' })
export class FinanceJsonImporter {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private demoLinks: FinanceJsonLink[] = [];
  private demoBatches = new Map<string, { payload: string; result: FinanceJsonResult }>();
  private stamp = '';
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  context() {
    const workspace = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !workspace ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { workspace, user, session };
  }
  current(r: ReturnType<FinanceJsonImporter['context']>) {
    return (
      r.workspace === this.store.workspace()?.id &&
      r.user === this.store.profile()?.id &&
      r.session === this.store.fileSession() &&
      (this.store.auth.demo() || r.user === this.store.auth.user()?.id)
    );
  }
  private resetDemo(c: ReturnType<FinanceJsonImporter['context']>) {
    const stamp = `${c.user}:${c.session}`;
    if (this.stamp !== stamp) {
      this.demoLinks = [];
      this.demoBatches.clear();
      this.stamp = stamp;
    }
  }
  async preview(text: string) {
    const c = this.context(),
      source = parseFinanceJson(text, this.today());
    let links: FinanceJsonLink[] = [];
    if (this.store.auth.demo()) {
      this.resetDemo(c);
      links = this.demoLinks.filter((l) => l.workspace_id === c.workspace && l.owner_id === c.user);
    } else {
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await this.backend
          .requireClient()
          .from('finance_json_links')
          .select('*')
          .eq('workspace_id', c.workspace)
          .eq('owner_id', c.user)
          .order('created_at')
          .order('id')
          .range(offset, offset + 499);
        if (error) throw error;
        if (!this.current(c)) throw new Error('Workspace changed; preview again.');
        links.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
    }
    const mapping: Record<string, string> = {};
    for (const a of source.accounts) {
      const saved = links.find((l) => l.source_kind === 'account' && l.source_id === a.source_id);
      const owned = this.store
        .accounts()
        .filter(
          (t) =>
            t.workspace_id === c.workspace &&
            t.owner_id === c.user &&
            t.currency === a.currency &&
            !this.store.creditCards().some((card) => card.account_id === t.id && card.archived) &&
            (!a.card_source || this.store.creditCards().some((card) => card.account_id === t.id)),
        );
      const exact = owned.find((t) => t.id === a.source_id),
        named = owned.filter((t) => t.name === a.name);
      mapping[a.source_id] = a.error
        ? 'skip'
        : (saved?.account_id ?? exact?.id ?? (named.length === 1 ? named[0].id : 'skip'));
    }
    return { source, links, mapping, context: c };
  }
  review(source: FinanceJsonSource, mapping: Record<string, string>, links: FinanceJsonLink[]) {
    const c = this.context();
    return reviewFinanceJson(
      source,
      mapping,
      this.store.accounts(),
      this.store.transactions(),
      links,
      c.workspace,
      c.user,
    );
  }
  prepare(
    source: FinanceJsonSource,
    mapping: Record<string, string>,
    links: FinanceJsonLink[],
    selected: Set<number>,
  ): FinanceJsonRequest {
    const c = this.context(),
      review = this.review(source, mapping, links);
    const accounts = source.accounts
      .filter((a) => !a.error && mapping[a.source_id] && mapping[a.source_id] !== 'skip')
      .map((a) => ({
        source_id: a.source_id,
        name: a.name,
        currency: a.currency,
        opening_balance: a.opening_balance,
        card_source: a.card_source,
        target_id: mapping[a.source_id] === 'new' ? null : mapping[a.source_id],
      }));
    if (!accounts.length) throw new Error('Choose at least one account destination.');
    for (const a of accounts) {
      if (a.card_source && !a.target_id)
        throw new Error('Map exported cards to existing credit cards.');
      const old = links.find((l) => l.source_kind === 'account' && l.source_id === a.source_id);
      if (old && old.account_id !== a.target_id)
        throw new Error('Source account already has a saved destination.');
    }
    const transactions = review
      .filter((r) => selected.has(r.index) && r.status === 'ready')
      .map((r) => ({
        source_id: r.source_id,
        account_source: r.account_source,
        row: { ...r.row! },
      }));
    return { id: crypto.randomUUID(), ...c, payload: { accounts, transactions } };
  }
  async save(request: FinanceJsonRequest): Promise<FinanceJsonResult> {
    if (!this.current(request)) throw new Error('Workspace changed; preview again.');
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend.requireClient().rpc('import_finance_json', {
        entry: request.id,
        w: request.workspace,
        payload: {
          accounts: request.payload.accounts.map((a) => ({ ...a })),
          transactions: request.payload.transactions.map((t) => ({ ...t, row: { ...t.row } })),
        },
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
    this.context();
    this.resetDemo(request);
    const encoded = JSON.stringify([request.workspace, request.user, request.payload]),
      prior = this.demoBatches.get(request.id);
    if (prior) {
      if (prior.payload !== encoded) throw new Error('JSON import request reused.');
      return prior.result;
    }
    const { accounts: plans, transactions: rows } = request.payload;
    if (
      !plans.length ||
      plans.length > 50 ||
      rows.length > 500 ||
      new Set(plans.map((a) => a.source_id)).size !== plans.length ||
      new Set(rows.map((t) => t.source_id)).size !== rows.length
    )
      throw new Error('Check unique source IDs and batch size.');
    const accounts = [...this.store.accounts()],
      ledger = [...this.store.transactions()],
      links = this.demoLinks.filter(
        (l) => l.workspace_id === request.workspace && l.owner_id === request.user,
      ),
      targets = new Map<string, string>();
    const result = { accounts_created: 0, accounts_reused: 0, imported: 0, skipped: 0 },
      now = new Date().toISOString();
    const base = () => ({
      id: crypto.randomUUID(),
      workspace_id: request.workspace,
      owner_id: request.user,
      created_at: now,
      updated_at: now,
      visibility: 'private' as const,
    });
    for (const p of plans) {
      if (
        !p.source_id ||
        p.source_id.length > 200 ||
        !p.name.trim() ||
        p.name.trim().length > 100 ||
        !/^[A-Z]{3}$/.test(p.currency) ||
        !/^-?\d{1,12}(\.\d{1,2})?$/.test(p.opening_balance) ||
        Math.abs(Number(p.opening_balance)) >= 1e12
      )
        throw new Error('Check source account fields.');
      const bound = links.find((l) => l.source_kind === 'account' && l.source_id === p.source_id);
      if (bound && bound.account_id !== p.target_id)
        throw new Error('Source account already has a saved destination.');
      let a: Account | undefined;
      if (p.target_id) {
        a = accounts.find(
          (a) =>
            a.id === p.target_id &&
            a.workspace_id === request.workspace &&
            a.owner_id === request.user &&
            a.currency === p.currency,
        );
        if (!a) throw new Error('Choose your own same-currency account.');
        if (
          this.store.creditCards().some((c) => c.account_id === a!.id && c.archived) ||
          (p.card_source && !this.store.creditCards().some((c) => c.account_id === a!.id))
        )
          throw new Error('Choose an active owned credit card.');
        result.accounts_reused++;
      } else {
        if (p.card_source) throw new Error('Map exported cards to existing credit cards.');
        a = {
          ...base(),
          name: p.name.trim(),
          currency: p.currency,
          opening_balance: Number(p.opening_balance),
        };
        accounts.push(a);
        result.accounts_created++;
      }
      targets.set(p.source_id, a.id);
      if (!bound)
        links.push({
          ...base(),
          source_kind: 'account',
          source_id: p.source_id,
          account_id: a.id,
          transaction_id: null,
          details: { currency: a.currency },
        });
    }
    for (const t of rows) {
      const target = targets.get(t.account_source),
        a = accounts.find((a) => a.id === target);
      if (!a || !t.source_id || t.source_id.length > 200)
        throw new Error('Missing source ID or account mapping.');
      if (
        previewFinanceImport(literalFinanceCsv([t.row]), a, [], this.today())[0].status ===
        'invalid'
      )
        throw new Error('Invalid transaction fields.');
      const details = { account_source: t.account_source, row: t.row },
        old = links.find((l) => l.source_kind === 'transaction' && l.source_id === t.source_id);
      if (old) {
        if (old.account_id !== a.id || JSON.stringify(old.details) !== JSON.stringify(details))
          throw new Error('Transaction source ID contents changed.');
        result.skipped++;
        continue;
      }
      const owned = ledger.filter(
        (l) =>
          l.account_id === a.id &&
          l.workspace_id === request.workspace &&
          l.owner_id === request.user,
      );
      const idMatch = ledger.find(
        (l) =>
          l.id === t.source_id &&
          l.workspace_id === request.workspace &&
          l.owner_id === request.user,
      );
      const ref = t.row.reference
        ? owned.find((l) => l.import_reference === t.row.reference)
        : undefined;
      if (
        (idMatch && (idMatch.account_id !== a.id || !transactionMatches(idMatch, t.row))) ||
        (ref && !transactionMatches(ref, t.row))
      )
        throw new Error('Source ID or reference already identifies different contents.');
      let tx = owned.find((l) => transactionMatches(l, t.row));
      if (tx) result.skipped++;
      else {
        tx = {
          ...base(),
          account_id: a.id,
          title: t.row.title,
          amount: Number(t.row.amount),
          kind: t.row.kind,
          category: t.row.category,
          booked_on: t.row.date,
          transfer_id: null,
          project_id: null,
          import_reference: t.row.reference || null,
        };
        ledger.push(tx);
        result.imported++;
      }
      links.push({
        ...base(),
        source_kind: 'transaction',
        source_id: t.source_id,
        account_id: a.id,
        transaction_id: tx.id,
        details,
      });
    }
    // Publish only after every row succeeds, mirroring the server transaction.
    this.store.accounts.set(accounts);
    this.store.transactions.set(ledger);
    this.demoLinks = [
      ...this.demoLinks.filter(
        (l) => l.workspace_id !== request.workspace || l.owner_id !== request.user,
      ),
      ...links,
    ];
    this.demoBatches.set(request.id, { payload: encoded, result });
    return result;
  }
}
