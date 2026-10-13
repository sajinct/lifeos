import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  Asset,
  HoldingInput,
  InvestmentEntry,
  InvestmentHolding,
  InvestmentInput,
  Transaction,
  WealthAssetValue,
  WealthSourceKind,
} from '../models/domain';
import {
  investmentChange,
  validateHolding,
  wealthSources,
  wealthTotals,
} from '../../shared/utilities/wealth';
import { cardMoney } from '../../shared/utilities/cards';
import { validLoanDate } from '../../shared/utilities/loans';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class WealthLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  private context() {
    const w = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !w ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { w, user, session };
  }
  private current(c: ReturnType<WealthLibrary['context']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private async reload(c: ReturnType<WealthLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(id: string, c: ReturnType<WealthLibrary['context']>) {
    const time = new Date().toISOString();
    return {
      id,
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: time,
      updated_at: time,
    };
  }
  private holding(id: string, c: ReturnType<WealthLibrary['context']>) {
    const h = this.store
      .investmentHoldings()
      .find((h) => h.id === id && h.workspace_id === c.w && h.owner_id === c.user);
    if (!h) throw new Error('Holding is inaccessible.');
    return h;
  }
  sources() {
    const s = this.store;
    return wealthSources(
      s.accounts(),
      s.transactions(),
      s.investmentHoldings(),
      s.assets(),
      s.loans(),
      s.wealthExclusions(),
      s.wealthAssetValues(),
      s.workspace()?.id ?? '',
      s.profile()?.id ?? '',
      this.today(),
    );
  }
  async saveHolding(id: string, v: HoldingInput, old?: InvestmentHolding) {
    const c = this.context(),
      n = validateHolding(v, this.today());
    if (old) {
      const h = this.holding(id, c);
      if (h.revision !== old.revision || h.archived)
        throw new Error('Holding changed; restore or refresh.');
      if (
        h.currency !== v.currency ||
        h.opened_on !== v.opened_on ||
        h.opening_cost !== n.cost ||
        h.opening_value !== n.value
      )
        throw new Error('Opening balances, date and currency cannot change.');
    }
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_investment_holding', {
        entry: id,
        w: c.w,
        expected_revision: old?.revision ?? null,
        details: { ...v, title: v.title.trim(), opening_cost: n.cost, opening_value: n.value },
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const h = this.store.investmentHoldings().find((h) => h.id === id);
    if (h && !old) {
      this.holding(id, c);
      return;
    }
    const row: InvestmentHolding = old
      ? {
          ...old,
          title: v.title.trim(),
          kind: v.kind,
          notes: v.notes,
          revision: old.revision + 1,
          updated_at: new Date().toISOString(),
        }
      : {
          ...this.base(id, c),
          ...v,
          title: v.title.trim(),
          opening_cost: n.cost,
          opening_value: n.value,
          current_cost: n.cost,
          current_value: n.value,
          last_entry_on: v.opened_on,
          next_sequence: 1,
          archived: false,
          revision: 1,
        };
    this.store.investmentHoldings.update((rows) => [row, ...rows.filter((h) => h.id !== id)]);
  }
  async append(id: string, old: InvestmentHolding, v: InvestmentInput) {
    const c = this.context(),
      h = this.holding(old.id, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('append_investment_entry', {
        entry: id,
        w: c.w,
        parent: h.id,
        expected_revision: old.revision,
        entry_kind: v.kind,
        entry_amount: cardMoney(v.amount),
        removed_basis: cardMoney(v.basis_removed),
        entry_date: v.occurred_on,
        bank_account: v.account_id || null,
        entry_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const existing = this.store.investmentEntries().find((e) => e.id === id);
    if (existing) {
      if (
        existing.workspace_id !== c.w ||
        existing.owner_id !== c.user ||
        existing.holding_id !== h.id ||
        existing.kind !== v.kind ||
        existing.amount !== cardMoney(v.amount) ||
        existing.basis_removed !== cardMoney(v.basis_removed) ||
        existing.occurred_on !== v.occurred_on ||
        existing.account_id !== (v.account_id || null) ||
        existing.notes !== v.notes
      )
        throw new Error('Investment request reused.');
      return;
    }
    if (h.archived || h.revision !== old.revision)
      throw new Error('Holding changed; restore or refresh.');
    const n = investmentChange(h, v, this.today());
    if (v.account_id) {
      const a = this.store
        .accounts()
        .find((a) => a.id === v.account_id && a.owner_id === c.user && a.workspace_id === c.w);
      if (
        !a ||
        a.currency !== h.currency ||
        this.store.creditCards().some((card) => card.account_id === a.id) ||
        n.amount === 0
      )
        throw new Error('Choose your own non-card bank account in the holding currency.');
      if (this.store.transactions().some((t) => t.transfer_id === id))
        throw new Error('Transfer request reused.');
    }
    const tx = v.account_id ? crypto.randomUUID() : null;
    const row: InvestmentEntry = {
      ...this.base(id, c),
      holding_id: h.id,
      sequence: h.next_sequence,
      kind: v.kind,
      amount: n.amount,
      basis_removed: n.basis,
      occurred_on: v.occurred_on,
      account_id: v.account_id || null,
      transaction_id: tx,
      reversal_id: null,
      voided: false,
      before_cost: h.current_cost,
      before_value: h.current_value,
      notes: v.notes,
    };
    if (tx)
      this.post(
        tx,
        id,
        c,
        v.account_id,
        n.amount,
        v.kind === 'contribution' ? 'transfer_out' : 'transfer_in',
        v.occurred_on,
        h.title + ' · investment ' + v.kind,
      );
    this.store.investmentEntries.update((rows) => [row, ...rows]);
    this.store.investmentHoldings.update((rows) =>
      rows.map((r) =>
        r.id === h.id
          ? {
              ...r,
              current_cost: n.cost,
              current_value: n.value,
              last_entry_on: v.occurred_on,
              next_sequence: r.next_sequence + 1,
              revision: r.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : r,
      ),
    );
  }
  private post(
    id: string,
    transferId: string,
    c: ReturnType<WealthLibrary['context']>,
    account: string,
    amount: number,
    kind: Transaction['kind'],
    date: string,
    title: string,
  ) {
    const t: Transaction = {
      ...this.base(id, c),
      account_id: account,
      title,
      amount,
      kind,
      category: 'Investment transfer',
      booked_on: date,
      transfer_id: transferId,
      project_id: null,
    };
    this.store.transactions.update((rows) => [t, ...rows]);
  }
  async undo(entry: InvestmentEntry, old: InvestmentHolding) {
    const c = this.context(),
      h = this.holding(old.id, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('undo_investment_entry', { entry: entry.id, expected_revision: old.revision });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const e = this.store
      .investmentEntries()
      .find(
        (e) =>
          e.id === entry.id &&
          e.holding_id === h.id &&
          e.workspace_id === c.w &&
          e.owner_id === c.user,
      );
    if (!e) throw new Error('Entry is inaccessible.');
    if (e.voided) return;
    if (h.archived || h.revision !== old.revision)
      throw new Error('Holding changed; restore or refresh.');
    if (
      this.store
        .investmentEntries()
        .some((r) => r.holding_id === h.id && !r.voided && r.sequence > e.sequence)
    )
      throw new Error('Undo newer entries before correcting an older one.');
    const reversal = e.transaction_id ? crypto.randomUUID() : null;
    if (reversal) {
      const t = this.store.transactions().find((t) => t.id === e.transaction_id);
      if (!t) throw new Error('Funding transaction is unavailable.');
      this.post(
        crypto.randomUUID(),
        reversal,
        c,
        e.account_id!,
        e.amount,
        t.kind === 'transfer_out' ? 'transfer_in' : 'transfer_out',
        this.today(),
        h.title + ' · investment reversal',
      );
    }
    this.store.investmentEntries.update((rows) =>
      rows.map((r) => (r.id === e.id ? { ...r, voided: true, reversal_id: reversal } : r)),
    );
    const last =
      this.store
        .investmentEntries()
        .filter((r) => r.holding_id === h.id && !r.voided)
        .sort((a, b) => b.sequence - a.sequence)[0]?.occurred_on ?? h.opened_on;
    this.store.investmentHoldings.update((rows) =>
      rows.map((r) =>
        r.id === h.id
          ? {
              ...r,
              current_cost: e.before_cost,
              current_value: e.before_value,
              last_entry_on: last,
              revision: r.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : r,
      ),
    );
  }
  async archive(old: InvestmentHolding, archived: boolean) {
    const c = this.context(),
      h = this.holding(old.id, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('archive_investment_holding', {
        entry: h.id,
        expected_revision: old.revision,
        archived_value: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (h.archived === archived) return;
    if (h.revision !== old.revision) throw new Error('Holding changed; refresh.');
    if (archived && (h.current_cost !== 0 || h.current_value !== 0))
      throw new Error('Clear holding value and cost basis before archiving.');
    this.store.investmentHoldings.update((rows) =>
      rows.map((r) => (r.id === h.id ? { ...r, archived, revision: r.revision + 1 } : r)),
    );
  }
  async exclude(id: string, kind: WealthSourceKind, source: string, excluded: boolean) {
    const c = this.context(),
      old = this.store
        .wealthExclusions()
        .find(
          (e) =>
            e.source_kind === kind &&
            e.source_id === source &&
            e.workspace_id === c.w &&
            e.owner_id === c.user,
        );
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_wealth_exclusion', {
        entry: old?.id ?? id,
        w: c.w,
        expected_revision: old?.revision ?? null,
        source_kind: kind,
        source_id: source,
        excluded_value: excluded,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (!this.sources().some((s) => s.kind === kind && s.id === source))
      throw new Error('Choose your own wealth source.');
    if (old?.excluded === excluded) return;
    this.store.wealthExclusions.update((rows) => [
      {
        ...this.base(old?.id ?? id, c),
        source_kind: kind,
        source_id: source,
        excluded,
        revision: (old?.revision ?? 0) + 1,
      },
      ...rows.filter((e) => e.id !== old?.id),
    ]);
  }
  async assetValue(
    id: string,
    asset: Asset,
    amount: string,
    date: string,
    notes: string,
    old?: WealthAssetValue,
  ) {
    const c = this.context(),
      a = this.store
        .assets()
        .find((a) => a.id === asset.id && a.owner_id === c.user && a.workspace_id === c.w),
      n = cardMoney(amount);
    if (!a || a.status !== 'active') throw new Error('Choose your own active asset.');
    if (
      !validLoanDate(date) ||
      date < (a.purchased_on ?? '1900-01-01') ||
      date > this.today() ||
      notes.length > 2000
    )
      throw new Error('Check asset valuation date and notes.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_wealth_asset_value', {
        entry: id,
        w: c.w,
        expected_revision: old?.revision ?? null,
        asset: a.id,
        value_amount: n,
        value_date: date,
        value_notes: notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const existing = this.store.wealthAssetValues().find((v) => v.id === id);
    if (existing) {
      if (
        existing.asset_id !== a.id ||
        existing.owner_id !== c.user ||
        existing.workspace_id !== c.w
      )
        throw new Error('Asset valuation is inaccessible.');
      if (!old) return;
      if (existing.revision !== old.revision) throw new Error('Asset value changed; refresh.');
    } else if (old) throw new Error('Asset valuation is inaccessible.');
    if (this.store.wealthAssetValues().some((v) => v.asset_id === a.id && v.id !== id))
      throw new Error('Asset value changed; refresh.');
    this.store.wealthAssetValues.update((rows) => [
      {
        ...this.base(id, c),
        asset_id: a.id,
        currency: a.currency,
        amount: n,
        valued_on: date,
        notes,
        revision: (old?.revision ?? 0) + 1,
      },
      ...rows.filter((v) => v.id !== id),
    ]);
  }
  async snapshot(id: string, label: string) {
    const c = this.context();
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('capture_wealth_snapshot', { entry: id, w: c.w, snapshot_label: label });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.wealthSnapshots().find((s) => s.id === id);
    if (old) {
      if (old.workspace_id !== c.w || old.owner_id !== c.user)
        throw new Error('Snapshot is inaccessible.');
      return;
    }
    if (!label.trim() || label.trim().length > 200) throw new Error('Enter a snapshot label.');
    this.store.wealthSnapshots.update((rows) => [
      {
        ...this.base(id, c),
        label: label.trim(),
        captured_on: this.today(),
        totals: wealthTotals(this.sources()),
      },
      ...rows,
    ]);
  }
}
