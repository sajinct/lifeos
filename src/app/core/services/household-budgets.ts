import { computed, effect, inject, Injectable } from '@angular/core';
import { HouseholdBudget, HouseholdBudgetInput, HouseholdSpending } from '../models/domain';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  validateHouseholdBudget,
  householdBudgetBalance,
} from '../../shared/utilities/household-budgets';
import { cents } from '../../shared/utilities/finance';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class HouseholdBudgetsLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly requests = new Map<
    string,
    { w: string; user: string; session: number; payload: string; done: boolean }
  >();
  private requestSession = -1;
  readonly budgets = computed(() =>
    this.store
      .householdBudgets()
      .filter(
        (b) =>
          b.workspace_id === this.store.workspace()?.id &&
          (b.owner_id === this.store.profile()?.id || b.visibility === 'workspace'),
      ),
  );
  readonly ownSpending = computed(() =>
    this.store
      .householdSpending()
      .filter(
        (s) =>
          s.workspace_id === this.store.workspace()?.id && s.owner_id === this.store.profile()?.id,
      ),
  );
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.syncRequests();
    });
  }
  month() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC').slice(0, 7);
  }
  spending(budget: HouseholdBudget) {
    if (!this.budgets().some((b) => b.id === budget.id)) return [];
    return this.store
      .householdSpending()
      .filter(
        (s) =>
          s.budget_id === budget.id &&
          s.workspace_id === budget.workspace_id &&
          (!s.withdrawn || s.owner_id === this.store.profile()?.id),
      )
      .sort((a, b) => b.booked_on.localeCompare(a.booked_on) || a.id.localeCompare(b.id));
  }
  balance(budget: HouseholdBudget) {
    return householdBudgetBalance(budget, this.spending(budget));
  }
  link(spending: HouseholdSpending) {
    return this.store
      .householdSpendingLinks()
      .find(
        (l) =>
          l.id === spending.id &&
          l.workspace_id === spending.workspace_id &&
          l.owner_id === this.store.profile()?.id,
      );
  }
  source(spending: HouseholdSpending) {
    const link = this.link(spending);
    return this.store
      .transactions()
      .find(
        (t) =>
          t.id === link?.transaction_id &&
          t.workspace_id === spending.workspace_id &&
          t.owner_id === this.store.profile()?.id,
      );
  }
  sourceStatus(spending: HouseholdSpending, budget?: HouseholdBudget) {
    const source = this.source(spending),
      account = this.store
        .accounts()
        .find((a) => a.id === source?.account_id && a.owner_id === this.store.profile()?.id);
    if (!source || !account) return 'Expense unavailable — snapshot kept until you withdraw it';
    if (
      source.kind !== 'expense' ||
      cents(source.amount) !== cents(spending.amount) ||
      source.booked_on !== spending.booked_on ||
      account.currency !== spending.currency ||
      (budget && account.currency !== budget.currency)
    )
      return 'Changed in Finance — refresh or withdraw this snapshot';
    return 'Matches Finance: ' + source.title;
  }
  expenseChoices(budget: HouseholdBudget, previous?: HouseholdSpending) {
    const original = previous ? this.link(previous)?.transaction_id : undefined;
    return this.store
      .transactions()
      .filter(
        (t) =>
          t.workspace_id === budget.workspace_id &&
          t.owner_id === this.store.profile()?.id &&
          t.kind === 'expense' &&
          t.amount > 0 &&
          t.amount <= 1000000000 &&
          t.booked_on.slice(0, 7) === budget.month.slice(0, 7) &&
          this.store
            .accounts()
            .some(
              (a) =>
                a.id === t.account_id &&
                a.owner_id === this.store.profile()?.id &&
                a.workspace_id === budget.workspace_id &&
                a.currency === budget.currency,
            ) &&
          (!previous || t.id === original) &&
          !this.store
            .householdSpendingLinks()
            .some((l) => l.transaction_id === t.id && l.active && l.id !== previous?.id),
      );
  }
  private syncRequests() {
    const s = this.store.fileSession();
    if (s !== this.requestSession) {
      this.requests.clear();
      this.requestSession = s;
    }
  }
  private stamp() {
    return {
      w: this.store.workspace()?.id,
      user: this.store.profile()?.id,
      session: this.store.fileSession(),
    };
  }
  private current(c: ReturnType<HouseholdBudgetsLibrary['stamp']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private context(request: string) {
    this.syncRequests();
    const c = this.stamp(),
      old = this.requests.get(request),
      retry = !this.store.auth.demo() && old && this.current(old);
    if (
      !c.w ||
      !c.user ||
      (!this.store.writable() && !retry) ||
      (!this.store.auth.demo() && c.user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { ...c, w: c.w, user: c.user };
  }
  private remember(
    request: string,
    c: ReturnType<HouseholdBudgetsLibrary['context']>,
    payload: unknown,
  ) {
    const p = JSON.stringify(payload),
      old = this.requests.get(request);
    if (
      old &&
      (old.w !== c.w || old.user !== c.user || old.session !== c.session || old.payload !== p)
    )
      throw new Error('Request was already used for another change.');
    this.requests.set(request, { ...c, payload: p, done: old?.done ?? false });
    return !!old?.done;
  }
  private finish(request: string) {
    const r = this.requests.get(request)!;
    this.requests.set(request, { ...r, done: true });
  }
  private async reload(c: ReturnType<HouseholdBudgetsLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error())
      throw new Error(
        'Household budget change saved, but refresh failed. Retry this change safely.',
      );
  }

  private parent(
    previous: HouseholdBudget,
    c: ReturnType<HouseholdBudgetsLibrary['context']>,
    retry: boolean,
    manage = false,
  ) {
    const old = this.budgets().find((b) => b.id === previous.id);
    if (!this.store.auth.demo() && retry && previous.workspace_id === c.w) return old ?? previous;
    if (!old || (manage && !this.store.canEdit(old)))
      throw new Error('Household budget is inaccessible.');
    return old;
  }
  private bump(id: string) {
    this.store.householdBudgets.update((rows) =>
      rows.map((b) =>
        b.id === id ? { ...b, revision: b.revision + 1, updated_at: new Date().toISOString() } : b,
      ),
    );
  }
  async save(request: string, id: string, input: HouseholdBudgetInput, previous?: HouseholdBudget) {
    const c = this.context(request),
      v = validateHouseholdBudget(input),
      old = previous
        ? this.parent(previous, c, this.requests.has(request), true)
        : this.budgets().find((b) => b.id === id),
      done = this.remember(request, c, ['budget', id, previous?.revision ?? null, v]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_household_budget', {
        request,
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        budget_category: v.category,
        budget_month: v.month + '-01',
        budget_currency: v.currency,
        budget_amount: v.amount,
        budget_notes: v.notes,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (old && !this.store.canEdit(old)) throw new Error('Household budget is inaccessible.');
    if (done) return;
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Household budget changed; refresh and try again.');
    if (previous && !old) throw new Error('Household budget is inaccessible.');
    if (old?.archived) throw new Error('Restore the budget before editing.');
    if (old && old.owner_id !== c.user && old.visibility !== v.visibility)
      throw new Error('Only the budget creator can change sharing.');
    if (
      old &&
      (old.category !== v.category ||
        old.month.slice(0, 7) !== v.month ||
        old.currency !== v.currency) &&
      this.store.householdSpending().some((s) => s.budget_id === id)
    )
      throw new Error('Category, month and currency cannot change after spending history exists.');
    if (
      this.store
        .householdBudgets()
        .some(
          (b) =>
            b.id !== id &&
            b.workspace_id === c.w &&
            b.owner_id === (old?.owner_id ?? c.user) &&
            b.month.slice(0, 7) === v.month &&
            b.category.toLowerCase() === v.category.toLowerCase() &&
            b.currency === v.currency,
        )
    )
      throw new Error('This monthly category budget already exists; restore or edit it.');
    const now = new Date().toISOString();
    this.store.householdBudgets.update((rows) => [
      {
        ...v,
        id,
        month: v.month + '-01',
        workspace_id: c.w,
        owner_id: old?.owner_id ?? c.user,
        archived: false,
        revision: old ? old.revision + 1 : 1,
        created_at: old?.created_at ?? now,
        updated_at: now,
      },
      ...rows.filter((b) => b.id !== id),
    ]);
    this.finish(request);
  }
  async archive(request: string, budget: HouseholdBudget, archived: boolean) {
    const c = this.context(request),
      old = this.parent(budget, c, this.requests.has(request), true),
      done = this.remember(request, c, ['archive', budget.id, budget.revision, archived]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_household_budget_archive', {
        request,
        entry: budget.id,
        expected_revision: budget.revision,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (old.revision !== budget.revision)
      throw new Error('Household budget changed; refresh and try again.');
    if (typeof archived !== 'boolean') throw new Error('Choose archive or restore.');
    this.store.householdBudgets.update((rows) =>
      rows.map((b) => (b.id === budget.id ? { ...b, archived } : b)),
    );
    this.bump(budget.id);
    this.finish(request);
  }
  async publish(
    request: string,
    id: string,
    budget: HouseholdBudget,
    expense: string,
    notes: string,
    previous?: HouseholdSpending,
  ) {
    const c = this.context(request),
      parent = this.parent(budget, c, this.requests.has(request)),
      old = this.store.householdSpending().find((s) => s.id === id),
      done = this.remember(request, c, [
        'spending',
        id,
        budget.id,
        budget.revision,
        previous?.revision ?? null,
        expense,
        notes,
      ]);
    if (notes.length > 2000 || notes.includes('\0') || !expense)
      throw new Error('Choose an expense and valid contribution notes.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_household_spending', {
        request,
        entry: id,
        parent: budget.id,
        expected_revision: previous?.revision ?? null,
        expected_parent_revision: budget.revision,
        expense,
        spending_notes: notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (old && (old.owner_id !== c.user || old.workspace_id !== c.w || old.budget_id !== budget.id))
      throw new Error('Spending contribution is inaccessible.');
    if (done) return;
    if (parent.archived)
      throw new Error('Restore the budget before linking or refreshing spending.');
    if (parent.revision !== budget.revision)
      throw new Error('Household budget changed; refresh and try again.');
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Spending contribution changed; refresh and try again.');
    if (previous && !old) throw new Error('Spending contribution is inaccessible.');
    if (old && this.link(old)?.transaction_id !== expense)
      throw new Error('Original expense is unavailable or cannot be replaced.');
    const tx = this.expenseChoices(parent, old).find((t) => t.id === expense);
    if (!tx)
      throw new Error(
        'Choose your own expense in the budget month and currency that is not already included.',
      );
    if (
      !old &&
      this.store
        .householdSpending()
        .filter((s) => s.budget_id === parent.id && s.workspace_id === parent.workspace_id)
        .length >= 500
    )
      throw new Error('A budget supports up to 500 contributions including withdrawn history.');
    const now = new Date().toISOString();
    this.store.householdSpending.update((rows) => [
      {
        id,
        workspace_id: c.w,
        owner_id: c.user,
        budget_id: budget.id,
        currency: parent.currency,
        amount: tx.amount,
        booked_on: tx.booked_on,
        notes,
        withdrawn: false,
        revision: old ? old.revision + 1 : 1,
        created_at: old?.created_at ?? now,
        updated_at: now,
      },
      ...rows.filter((s) => s.id !== id),
    ]);
    this.store.householdSpendingLinks.update((rows) => [
      {
        id,
        workspace_id: c.w,
        owner_id: c.user,
        transaction_id: expense,
        active: true,
        created_at: old?.created_at ?? now,
        updated_at: now,
      },
      ...rows.filter((l) => l.id !== id),
    ]);
    this.bump(budget.id);
    this.finish(request);
  }
  async withdraw(request: string, spending: HouseholdSpending) {
    const c = this.context(request),
      old = this.ownSpending().find((s) => s.id === spending.id),
      retry = this.requests.has(request);
    if (
      (!old &&
        !(
          retry &&
          !this.store.auth.demo() &&
          spending.workspace_id === c.w &&
          spending.owner_id === c.user
        )) ||
      spending.owner_id !== c.user ||
      spending.workspace_id !== c.w
    )
      throw new Error('Your contribution with workspace write access is required.');
    const done = this.remember(request, c, ['withdraw', spending.id, spending.revision]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('withdraw_household_spending', {
        request,
        entry: spending.id,
        expected_revision: spending.revision,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (old!.revision !== spending.revision)
      throw new Error('Spending contribution changed; refresh and try again.');
    this.store.householdSpending.update((rows) =>
      rows.map((s) =>
        s.id === spending.id
          ? {
              ...s,
              withdrawn: true,
              revision: s.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : s,
      ),
    );
    this.store.householdSpendingLinks.update((rows) =>
      rows.map((l) => (l.id === spending.id ? { ...l, active: false } : l)),
    );
    this.bump(spending.budget_id);
    this.finish(request);
  }
}
