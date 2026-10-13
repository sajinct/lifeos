import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  TravelPlan,
  TravelPlanInput,
  TravelEntry,
  TravelEntryInput,
  TravelBudget,
  TravelExpense,
  TravelRecordKind,
  TravelAction,
} from '../models/domain';
import {
  validateTravelPlan,
  validateTravelEntry,
  travelAmount,
} from '../../shared/utilities/travel';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
type RecordRow = TravelPlan | TravelEntry | TravelBudget | TravelExpense;
@Injectable({ providedIn: 'root' })
export class TravelLibrary {
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
      (!this.store.auth.demo() && this.store.auth.user()?.id !== user)
    )
      throw new Error('Workspace write access required.');
    return { w, user, session };
  }
  private own(
    r: { workspace_id: string; owner_id: string },
    c: ReturnType<TravelLibrary['context']>,
  ) {
    if (r.workspace_id !== c.w || r.owner_id !== c.user)
      throw new Error('Travel record is inaccessible.');
  }
  private current(c: ReturnType<TravelLibrary['context']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || this.store.auth.user()?.id === c.user)
    );
  }
  private async reload(c: ReturnType<TravelLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<TravelLibrary['context']>) {
    const date = new Date().toISOString();
    return {
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: date,
      updated_at: date,
    };
  }
  private previous(
    old: RecordRow | undefined,
    previous: RecordRow | undefined,
    c: ReturnType<TravelLibrary['context']>,
  ) {
    if (old) {
      this.own(old, c);
      if (!previous) return false;
      if (old.archived || old.revision !== previous.revision)
        throw new Error('Travel record changed; restore or refresh.');
    } else if (previous) throw new Error('Travel record is inaccessible.');
    return true;
  }
  private parent(
    plan: TravelPlan,
    c: ReturnType<TravelLibrary['context']>,
    planning = false,
    allowArchived = false,
  ) {
    const p = this.store.travelPlans().find((p) => p.id === plan.id);
    if (!p) throw new Error('Travel plan is inaccessible.');
    this.own(p, c);
    if (p.archived && !allowArchived) throw new Error('Restore the travel plan first.');
    if (planning && ['completed', 'cancelled'].includes(p.status))
      throw new Error('Reopen the plan before changing planning details.');
    return p;
  }
  async savePlan(id: string, input: TravelPlanInput, previous?: TravelPlan) {
    const c = this.context(),
      v = validateTravelPlan(input);
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_travel_plan', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        details: v,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.travelPlans().find((p) => p.id === id);
    if (!this.previous(old, previous, c)) return;
    if (old && old.kind !== v.kind) throw new Error('Plan kind cannot change.');
    if (
      this.store
        .travelEntries()
        .some(
          (r) =>
            r.plan_id === id &&
            ((r.date_on && (r.date_on < v.starts_on || r.date_on > v.ends_on)) ||
              (r.end_on && r.end_on > v.ends_on)),
        )
    )
      throw new Error(
        'Keep plan dates around all saved itinerary and booking dates, including archives.',
      );
    const b = this.base(c);
    this.store.travelPlans.update((rows) => [
      {
        ...b,
        ...v,
        id,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? b.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async saveEntry(id: string, plan: TravelPlan, input: TravelEntryInput, previous?: TravelEntry) {
    const c = this.context(),
      p = this.parent(plan, c, true),
      v = validateTravelEntry(input, p);
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_travel_entry', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        parent: p.id,
        details: v,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.travelEntries().find((r) => r.id === id);
    if (old && (old.plan_id !== p.id || old.kind !== v.kind))
      throw new Error('Planning entry binding is immutable.');
    if (!this.previous(old, previous, c)) return;
    const b = this.base(c);
    this.store.travelEntries.update((rows) => [
      {
        ...b,
        ...v,
        id,
        plan_id: p.id,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? b.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async saveBudget(
    id: string,
    plan: TravelPlan,
    currency: string,
    amount: string,
    previous?: TravelBudget,
  ) {
    const c = this.context(),
      p = this.parent(plan, c),
      value = travelAmount(amount);
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency.');
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_travel_budget', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        parent: p.id,
        budget_currency: currency,
        budget_amount: value,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.travelBudgets().find((r) => r.id === id);
    if (old && (old.plan_id !== p.id || old.currency !== currency))
      throw new Error('Budget binding is immutable.');
    if (!this.previous(old, previous, c)) return;
    if (
      !old &&
      this.store.travelBudgets().some((r) => r.plan_id === p.id && r.currency === currency)
    )
      throw new Error('Budget exists; edit or restore this currency.');
    const b = this.base(c);
    this.store.travelBudgets.update((rows) => [
      {
        ...b,
        id,
        plan_id: p.id,
        currency,
        amount: value,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? b.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async saveExpense(
    id: string,
    plan: TravelPlan,
    expense: string,
    notes: string,
    previous?: TravelExpense,
  ) {
    const c = this.context(),
      p = this.parent(plan, c);
    if (previous) this.own(previous, c);
    if (notes.length > 2000) throw new Error('Notes must be up to 2000 characters.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_travel_expense', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        parent: p.id,
        expense,
        expense_notes: notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.travelExpenses().find((r) => r.id === id);
    if (old && (old.plan_id !== p.id || old.transaction_id !== expense))
      throw new Error('Expense binding is immutable.');
    if (!this.previous(old, previous, c)) return;
    if (
      !this.store
        .transactions()
        .some(
          (t) =>
            t.id === expense &&
            t.owner_id === c.user &&
            t.workspace_id === c.w &&
            t.kind === 'expense',
        )
    )
      throw new Error('Choose your own recorded expense.');
    if (
      !old &&
      this.store
        .travelExpenses()
        .some(
          (r) =>
            r.transaction_id === expense &&
            r.owner_id === c.user &&
            r.workspace_id === c.w &&
            !r.archived,
        )
    )
      throw new Error('Expense already linked; archive its active link first.');
    const b = this.base(c);
    this.store.travelExpenses.update((rows) => [
      {
        ...b,
        id,
        plan_id: p.id,
        transaction_id: expense,
        notes,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? b.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async act(row: RecordRow, kind: TravelRecordKind, action: TravelAction) {
    const c = this.context();
    this.own(row, c);
    if (kind !== 'entry' && ['complete', 'reopen'].includes(action))
      throw new Error('Invalid travel action.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('act_on_travel_record', {
        entry: row.id,
        record_kind: kind,
        expected_revision: row.revision,
        action,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const rows =
        kind === 'plan'
          ? this.store.travelPlans()
          : kind === 'entry'
            ? this.store.travelEntries()
            : kind === 'budget'
              ? this.store.travelBudgets()
              : this.store.travelExpenses(),
      old = rows.find((r) => r.id === row.id);
    if (!old) throw new Error('Travel record is inaccessible.');
    this.own(old, c);
    const p =
      kind === 'plan'
        ? (old as TravelPlan)
        : this.store.travelPlans().find((p) => p.id === ('plan_id' in old ? old.plan_id : ''));
    if (!p) throw new Error('Travel plan is inaccessible.');
    this.parent(p, c, kind === 'entry', kind === 'plan');
    if (
      kind === 'entry' &&
      ['complete', 'reopen'].includes(action) &&
      !['itinerary', 'checklist'].includes((old as TravelEntry).kind)
    )
      throw new Error('Completion applies to itinerary or checklists.');
    const archived = action === 'archive' ? true : action === 'restore' ? false : old.archived,
      status =
        kind === 'entry'
          ? action === 'complete'
            ? 'done'
            : action === 'reopen'
              ? (old as TravelEntry).kind === 'checklist'
                ? 'todo'
                : 'scheduled'
              : (old as TravelEntry).status
          : '';
    if (old.archived === archived && (kind !== 'entry' || (old as TravelEntry).status === status))
      return;
    if (old.revision !== row.revision || (old.archived && ['complete', 'reopen'].includes(action)))
      throw new Error('Travel record changed; restore or refresh.');
    if (
      kind === 'expense' &&
      action === 'restore' &&
      this.store
        .travelExpenses()
        .some(
          (r) =>
            r.id !== old.id &&
            r.transaction_id === (old as TravelExpense).transaction_id &&
            r.owner_id === c.user &&
            r.workspace_id === c.w &&
            !r.archived,
        )
    )
      throw new Error('Expense is active under another link; archive it first.');
    if (kind === 'plan')
      this.store.travelPlans.update((rows) =>
        rows.map((r) => (r.id === old.id ? { ...r, archived, revision: r.revision + 1 } : r)),
      );
    else if (kind === 'entry')
      this.store.travelEntries.update((rows) =>
        rows.map((r) =>
          r.id === old.id ? { ...r, archived, status, revision: r.revision + 1 } : r,
        ),
      );
    else if (kind === 'budget')
      this.store.travelBudgets.update((rows) =>
        rows.map((r) => (r.id === old.id ? { ...r, archived, revision: r.revision + 1 } : r)),
      );
    else
      this.store.travelExpenses.update((rows) =>
        rows.map((r) => (r.id === old.id ? { ...r, archived, revision: r.revision + 1 } : r)),
      );
  }
}
