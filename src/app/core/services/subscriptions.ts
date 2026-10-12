import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Subscription, SubscriptionInput, RecurringTransaction } from '../models/domain';
import { validateSubscription, subscriptionToday } from '../../shared/utilities/subscriptions';
import { recurrenceDate } from '../../shared/utilities/finance';
@Injectable({ providedIn: 'root' })
export class SubscriptionLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  private context() {
    const workspace = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (!workspace || !user || !this.store.writable())
      throw new Error('Workspace write access required.');
    return { workspace, user, session };
  }
  private current(c: ReturnType<SubscriptionLibrary['context']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private own(row: Subscription, c: ReturnType<SubscriptionLibrary['context']>) {
    if (row.owner_id !== c.user || row.workspace_id !== c.workspace)
      throw new Error('Subscription is inaccessible.');
  }
  private async reload(c: ReturnType<SubscriptionLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  async ensurePlan(row: Subscription) {
    if (!row.recurring_id || this.store.recurring().some((r) => r.id === row.recurring_id)) return;
    const c = this.context();
    this.own(row, c);
    if (this.store.auth.demo()) throw new Error('Expense schedule is unavailable.');
    const { data, error } = await this.backend
      .requireClient()
      .from('recurring_transactions')
      .select('*')
      .eq('id', row.recurring_id)
      .eq('workspace_id', c.workspace)
      .eq('owner_id', c.user)
      .maybeSingle();
    if (error) throw error;
    if (!this.current(c)) throw new Error('Workspace changed.');
    if (!data) throw new Error('Expense schedule is unavailable.');
    this.store.recurring.update((rows) => [...rows, data]);
  }
  async save(id: string, input: SubscriptionInput, previous?: Subscription) {
    const v = {
      ...input,
      title: input.title.trim(),
      category: input.category.trim(),
      provider_url: input.provider_url.trim(),
    };
    let amount = validateSubscription(v);
    const c = this.context();
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_subscription', {
        entry: id,
        w: c.workspace,
        revision: previous?.updated_at ?? null,
        service_name: v.title,
        price: amount,
        price_currency: v.currency,
        billing_frequency: v.frequency,
        first_renewal: v.next_on,
        trial_end: v.status === 'trial' ? v.trial_ends_on : null,
        subscription_status: v.status,
        service_category: v.category,
        service_url: v.provider_url,
        service_notes: v.notes,
        link_mode: v.link_mode,
        expense_account: v.account_id || null,
        existing_schedule: v.recurring_id || null,
        auto_record: v.automatic,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const existing = this.store.subscriptions().find((s) => s.id === id);
    if (existing && !previous) return;
    if (previous && (!existing || existing.updated_at !== previous.updated_at))
      throw new Error('Subscription changed; refresh and try again.');
    const timestamp = new Date().toISOString();
    const base = {
      id,
      workspace_id: c.workspace,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: existing?.created_at ?? timestamp,
      updated_at: timestamp,
    };
    let plan: RecurringTransaction | undefined,
      frequency = v.frequency,
      currency = v.currency,
      next = v.next_on,
      anchor = next,
      count = 0;
    if (v.link_mode === 'existing') {
      plan = this.store
        .recurring()
        .find(
          (r) => r.id === v.recurring_id && r.owner_id === c.user && r.workspace_id === c.workspace,
        );
      if (!plan || plan.kind !== 'expense' || !['monthly', 'yearly'].includes(plan.frequency))
        throw new Error('Choose your own monthly or yearly expense schedule.');
      if (this.store.subscriptions().some((s) => s.id !== id && s.recurring_id === plan!.id))
        throw new Error('Expense schedule already belongs to another subscription.');
      if (
        existing?.status === 'cancelled' ||
        (existing?.status === 'trial' && v.status === 'active')
      )
        throw new Error('Create a fresh expense schedule when restarting a paid plan.');
      if (
        v.status === 'trial' &&
        (!existing ||
          existing.status !== 'trial' ||
          existing.recurring_id !== plan.id ||
          plan.occurrence_count !== 0)
      )
        throw new Error('A trial requires a new paused expense schedule.');
      currency = this.store.accounts().find((a) => a.id === plan!.account_id)!.currency;
      amount = Number(plan.amount);
      frequency = plan.frequency as Subscription['frequency'];
      next = plan.next_on;
      anchor = plan.start_on;
      count = plan.occurrence_count;
      if (v.status === 'trial' && next < v.trial_ends_on)
        throw new Error('First paid renewal must be on or after the trial end.');
    } else if (v.link_mode === 'create') {
      const account = this.store
        .accounts()
        .find((a) => a.id === v.account_id && a.owner_id === c.user && a.currency === currency);
      if (!account || amount <= 0)
        throw new Error('Choose your own account in this currency and a positive price.');
      if (next < this.today()) throw new Error('A new expense schedule must start today or later.');
      plan = {
        ...base,
        id: crypto.randomUUID(),
        title: v.title,
        account_id: account.id,
        amount,
        kind: 'expense',
        category: v.category,
        start_on: next,
        next_on: next,
        frequency,
        occurrence_count: 0,
        active: v.status === 'active',
        automatic: v.status === 'active' && v.automatic,
      };
      this.store.recurring.update((rows) => [plan!, ...rows]);
    }
    if (existing?.recurring_id && existing.recurring_id !== plan?.id)
      this.store.recurring.update((rows) =>
        rows.map((r) =>
          r.id === existing.recurring_id ? { ...r, active: false, automatic: false } : r,
        ),
      );
    if (
      v.link_mode === 'track' &&
      existing &&
      !existing.recurring_id &&
      existing.status === v.status &&
      existing.next_on === next &&
      existing.frequency === frequency
    ) {
      anchor = existing.anchor_on;
      count = existing.renewal_count;
    }
    const row: Subscription = {
      ...base,
      title: v.title,
      amount,
      currency,
      frequency,
      next_on: next,
      anchor_on: anchor,
      renewal_count: count,
      status: v.status,
      trial_ends_on: v.status === 'trial' ? v.trial_ends_on : null,
      category: v.category,
      provider_url: v.provider_url,
      notes: v.notes,
      recurring_id: plan?.id ?? null,
    };
    this.store.subscriptions.update((rows) => [row, ...rows.filter((s) => s.id !== id)]);
    if (plan)
      this.store.transactions.update((rows) =>
        rows.map((t) =>
          t.recurring_id === plan.id && t.kind === 'expense' && !t.subscription_id
            ? { ...t, subscription_id: id }
            : t,
        ),
      );
    if (v.status === 'trial' && plan)
      this.store.recurring.update((rows) =>
        rows.map((r) => (r.id === plan!.id ? { ...r, active: false, automatic: false } : r)),
      );
  }
  async cancel(row: Subscription) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('cancel_subscription', { entry: row.id });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const current = this.store.subscriptions().find((s) => s.id === row.id);
    if (!current) throw new Error('Subscription is inaccessible.');
    this.store.subscriptions.update((rows) =>
      rows.map((s) =>
        s.id === row.id ? { ...s, status: 'cancelled', updated_at: new Date().toISOString() } : s,
      ),
    );
    this.store.recurring.update((rows) =>
      rows.map((r) =>
        r.id === current.recurring_id ? { ...r, active: false, automatic: false } : r,
      ),
    );
  }
  async advance(row: Subscription) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('advance_subscription', { entry: row.id, expected_date: row.next_on });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const current = this.store.subscriptions().find((s) => s.id === row.id);
    if (!current || current.status !== 'active' || current.recurring_id)
      throw new Error('Use the linked expense schedule, or start the paid plan first.');
    if (current.next_on !== row.next_on) return;
    if (current.next_on > this.today()) throw new Error('Renewal is not due yet.');
    this.store.subscriptions.update((rows) =>
      rows.map((s) =>
        s.id === row.id
          ? {
              ...s,
              renewal_count: s.renewal_count + 1,
              next_on: recurrenceDate(s.anchor_on, s.frequency, s.renewal_count + 1),
              updated_at: new Date().toISOString(),
            }
          : s,
      ),
    );
  }
  async post(row: Subscription) {
    const c = this.context();
    this.own(row, c);
    await this.ensurePlan(row);
    const plan = this.store.recurring().find((r) => r.id === row.recurring_id);
    if (!plan) throw new Error('Expense schedule is unavailable.');
    if (!this.current(c)) throw new Error('Workspace changed.');
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend
        .requireClient()
        .rpc('post_recurring_due', { plan: plan.id });
      if (error) throw error;
      await this.reload(c);
      return data;
    }
    return this.store.postRecurring(plan);
  }
}
