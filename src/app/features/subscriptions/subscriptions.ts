import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { LifeStore } from '../../core/services/life-store';
import { SubscriptionLibrary } from '../../core/services/subscriptions';
import { UiService } from '../../core/services/ui';
import { Subscription, SubscriptionInput } from '../../core/models/domain';
import { subscriptionTotals } from '../../shared/utilities/subscriptions';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-subscriptions',
  imports: [ReactiveFormsModule, DatePipe, RouterLink, Icon],
  templateUrl: './subscriptions.html',
})
export class SubscriptionsPage {
  readonly store = inject(LifeStore);
  readonly library = inject(SubscriptionLibrary);
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly reminderId = computed(() => this.params()?.get('reminder'));
  readonly search = signal(String(history.state?.search ?? ''));
  readonly filter = signal('all');
  readonly totals = computed(() => subscriptionTotals(this.store.subscriptions()));
  readonly rows = computed(() =>
    this.store
      .subscriptions()
      .filter((s) =>
        this.reminderId()
          ? s.id === this.reminderId()
          : (this.filter() === 'all' || s.status === this.filter()) &&
            (s.title + ' ' + s.category).toLowerCase().includes(this.search().trim().toLowerCase()),
      )
      .sort(
        (a, b) =>
          (a.status === 'cancelled' ? 1 : 0) - (b.status === 'cancelled' ? 1 : 0) ||
          this.date(a).localeCompare(this.date(b)),
      ),
  );
  readonly activeCount = computed(
    () => this.store.subscriptions().filter((s) => s.status === 'active').length,
  );
  readonly trialCount = computed(
    () => this.store.subscriptions().filter((s) => s.status === 'trial').length,
  );
  readonly busy = signal(false);
  readonly error = signal('');
  readonly showForm = signal(false);
  readonly editing = signal<Subscription | null>(null);
  private requestId: string = crypto.randomUUID();
  readonly form = inject(FormBuilder).nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(200)]],
    amount: ['0', [Validators.required, Validators.pattern(/^\d{1,12}(\.\d{1,2})?$/)]],
    currency: 'INR',
    frequency: 'monthly' as Subscription['frequency'],
    next_on: ['', Validators.required],
    status: 'active' as 'active' | 'trial',
    trial_ends_on: '',
    category: ['Subscriptions', [Validators.required, Validators.maxLength(100)]],
    provider_url: ['', Validators.maxLength(500)],
    notes: ['', Validators.maxLength(2000)],
    link_mode: 'track' as SubscriptionInput['link_mode'],
    account_id: '',
    recurring_id: '',
    automatic: false,
  });
  readonly mode = toSignal(this.form.controls.link_mode.valueChanges, { initialValue: 'track' });
  readonly status = toSignal(this.form.controls.status.valueChanges, { initialValue: 'active' });
  private readonly selectedCurrency = toSignal(this.form.controls.currency.valueChanges, {
    initialValue: 'INR',
  });
  private readonly selectedSchedule = toSignal(this.form.controls.recurring_id.valueChanges, {
    initialValue: '',
  });
  readonly currencies = computed(() => [
    ...new Set([
      'INR',
      'USD',
      'EUR',
      'GBP',
      this.store.currency(),
      ...this.store.accounts().map((a) => a.currency),
      ...this.store.subscriptions().map((s) => s.currency),
    ]),
  ]);
  readonly accounts = computed(() =>
    this.store
      .accounts()
      .filter(
        (a) => a.owner_id === this.store.profile()?.id && a.currency === this.selectedCurrency(),
      ),
  );
  readonly plans = computed(() =>
    this.store
      .recurring()
      .filter(
        (r) =>
          r.owner_id === this.store.profile()?.id &&
          r.kind === 'expense' &&
          ['monthly', 'yearly'].includes(r.frequency) &&
          !this.store
            .subscriptions()
            .some((s) => s.id !== this.editing()?.id && s.recurring_id === r.id),
      ),
  );
  constructor() {
    effect(() => {
      const linked = this.mode() === 'existing';
      for (const key of ['amount', 'currency', 'frequency', 'next_on'] as const) {
        if (linked) this.form.controls[key].disable({ emitEvent: false });
        else this.form.controls[key].enable({ emitEvent: false });
      }
      const plan = this.store.recurring().find((r) => r.id === this.selectedSchedule());
      if (linked && plan)
        this.form.patchValue({
          amount: String(plan.amount),
          currency:
            this.store.accounts().find((a) => a.id === plan.account_id)?.currency ??
            this.store.currency(),
          frequency: plan.frequency as Subscription['frequency'],
          next_on: plan.next_on,
        });
    });
    effect(() => {
      const mode = this.mode(),
        accounts = this.accounts();
      if (mode === 'create' && !accounts.some((a) => a.id === this.form.controls.account_id.value))
        this.form.controls.account_id.setValue(accounts[0]?.id ?? '');
    });
    effect(() => {
      this.store.workspace();
      this.showForm.set(false);
      this.editing.set(null);
      this.error.set('');
    });
  }
  money(amount: number, currency: string) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  }
  date(s: Subscription) {
    return s.status === 'trial' ? s.trial_ends_on! : s.next_on;
  }
  plan(s: Subscription) {
    return this.store.recurring().find((r) => r.id === s.recurring_id);
  }
  due(s: Subscription) {
    return this.date(s) <= this.library.today();
  }
  clearReminder() {
    void this.router.navigate([], {
      queryParams: { reminder: null },
      queryParamsHandling: 'merge',
    });
  }
  add() {
    this.editing.set(null);
    this.requestId = crypto.randomUUID();
    this.error.set('');
    this.showForm.set(true);
    this.form.reset({
      title: '',
      amount: '0',
      currency: this.store.currency(),
      frequency: 'monthly',
      next_on: this.library.today(),
      status: 'active',
      trial_ends_on: '',
      category: 'Subscriptions',
      provider_url: '',
      notes: '',
      link_mode: 'track',
      account_id: '',
      recurring_id: '',
      automatic: false,
    });
  }
  async edit(s: Subscription, startPaid = false) {
    await this.run(async () => {
      if (s.recurring_id) await this.library.ensurePlan(s);
      this.editing.set(s);
      this.requestId = s.id;
      this.showForm.set(true);
      const restart = startPaid || s.status === 'cancelled';
      this.form.reset({
        title: s.title,
        amount: String(s.amount),
        currency: s.currency,
        frequency: s.frequency,
        next_on: restart && s.next_on < this.library.today() ? this.library.today() : s.next_on,
        status: restart ? 'active' : s.status === 'trial' ? 'trial' : 'active',
        trial_ends_on: restart ? '' : (s.trial_ends_on ?? ''),
        category: s.category,
        provider_url: s.provider_url,
        notes: s.notes,
        link_mode: s.recurring_id ? (restart ? 'create' : 'existing') : 'track',
        account_id: this.plan(s)?.account_id ?? '',
        recurring_id: restart ? '' : (s.recurring_id ?? ''),
        automatic: false,
      });
    });
  }
  async save() {
    if (this.form.invalid) {
      this.error.set('Complete the required subscription fields.');
      return;
    }
    await this.run(async () => {
      await this.library.save(this.requestId, this.form.getRawValue(), this.editing() ?? undefined);
      this.showForm.set(false);
      this.editing.set(null);
      this.ui.notify('Subscription saved');
    });
  }
  async cancel(s: Subscription) {
    await this.run(async () => {
      await this.library.cancel(s);
      this.ui.notify('Marked cancelled; linked expense recording stopped');
    });
  }
  async advance(s: Subscription) {
    await this.run(async () => {
      await this.library.advance(s);
      this.ui.notify('Renewal date advanced');
    });
  }
  async post(s: Subscription) {
    await this.run(async () => {
      const count = await this.library.post(s);
      this.ui.notify(`${count} due expense entries recorded`);
    });
  }
  private async run(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
