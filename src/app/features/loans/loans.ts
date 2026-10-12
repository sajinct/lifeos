import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { LifeStore } from '../../core/services/life-store';
import { LoanLibrary } from '../../core/services/loans';
import { UiService } from '../../core/services/ui';
import { Loan } from '../../core/models/domain';
import {
  loanSchedule,
  loanTerms,
  loanTotals,
  outstanding,
  suggestedRepayment,
} from '../../shared/utilities/loans';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-loans',
  imports: [ReactiveFormsModule, DatePipe, RouterLink, Icon],
  templateUrl: './loans.html',
})
export class LoansPage {
  readonly store = inject(LifeStore);
  readonly library = inject(LoanLibrary);
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly reminderId = computed(
    () => this.params()?.get('reminder') ?? this.params()?.get('linked'),
  );
  readonly search = signal(String(history.state?.search ?? ''));
  readonly filter = signal('all');
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(
    () => this.store.loans().find((l) => l.id === (this.selectedId() ?? this.reminderId())) ?? null,
  );
  readonly rows = computed(() =>
    this.store
      .loans()
      .filter((l) =>
        this.reminderId()
          ? l.id === this.reminderId()
          : (this.filter() === 'all' ||
              l.direction === this.filter() ||
              l.status === this.filter()) &&
            (l.title + ' ' + l.counterparty)
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => (a.next_due_on ?? '9999').localeCompare(b.next_due_on ?? '9999')),
  );
  readonly totals = computed(() => loanTotals(this.store.loans()));
  readonly schedule = computed(() => (this.selected() ? loanSchedule(this.selected()!) : []));
  readonly history = computed(() =>
    this.store
      .loanRepayments()
      .filter((p) => p.loan_id === this.selected()?.id)
      .sort(
        (a, b) =>
          b.booked_on.localeCompare(a.booked_on) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly busy = signal(false);
  readonly error = signal('');
  readonly showForm = signal(false);
  readonly showRepayment = signal(false);
  private requestId = crypto.randomUUID();
  private paymentId = crypto.randomUUID();
  private paymentLoanId = '';
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required]],
    counterparty: ['', [Validators.required]],
    direction: 'borrowed' as Loan['direction'],
    currency: 'INR',
    principal: ['', [Validators.required]],
    annual_rate: '0',
    installments: 12,
    opened_on: '',
    first_due_on: '',
    notes: '',
    account_id: '',
  });
  readonly payment = this.fb.nonNullable.group({
    principal: '0',
    interest: '0',
    date: '',
    account_id: '',
    notes: '',
  });
  private readonly values = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });
  readonly estimate = computed(() => {
    this.values();
    try {
      return loanTerms(this.form.getRawValue(), this.library.today());
    } catch {
      return null;
    }
  });
  readonly currencies = computed(() => [
    ...new Set([
      'INR',
      'USD',
      'EUR',
      'GBP',
      this.store.currency(),
      ...this.store.accounts().map((a) => a.currency),
    ]),
  ]);
  readonly accounts = computed(() => {
    const currency = this.values().currency;
    return this.store
      .accounts()
      .filter((a) => a.owner_id === this.store.profile()?.id && a.currency === currency);
  });
  readonly paymentAccounts = computed(() =>
    this.store
      .accounts()
      .filter(
        (a) => a.owner_id === this.store.profile()?.id && a.currency === this.selected()?.currency,
      ),
  );
  readonly balance = outstanding;
  constructor() {
    effect(() => {
      this.store.workspace();
      this.showForm.set(false);
      this.showRepayment.set(false);
      this.selectedId.set(null);
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
  add() {
    this.requestId = crypto.randomUUID();
    this.showForm.set(true);
    this.showRepayment.set(false);
    this.error.set('');
    this.form.reset({
      title: '',
      counterparty: '',
      direction: 'borrowed',
      currency: this.store.currency(),
      principal: '',
      annual_rate: '0',
      installments: 12,
      opened_on: this.library.today(),
      first_due_on: this.library.today(),
      notes: '',
      account_id: '',
    });
  }
  select(l: Loan) {
    this.selectedId.set(l.id);
    this.showRepayment.set(false);
    this.error.set('');
  }
  repay() {
    const l = this.selected();
    if (!l) return;
    this.paymentId = crypto.randomUUID();
    this.paymentLoanId = l.id;
    this.showRepayment.set(true);
    this.error.set('');
    const b = suggestedRepayment(l);
    this.payment.reset({
      principal: String(b.principal),
      interest: String(b.interest),
      date: this.library.today(),
      account_id: '',
      notes: '',
    });
  }
  async save() {
    await this.run(async () => {
      await this.library.create(this.requestId, this.form.getRawValue());
      this.showForm.set(false);
      this.selectedId.set(this.requestId);
      this.ui.notify('Loan saved');
    });
  }
  async savePayment() {
    const l = this.selected();
    if (!l || l.id !== this.paymentLoanId) return;
    await this.run(async () => {
      await this.library.repay(this.paymentId, l, this.payment.getRawValue());
      this.showRepayment.set(false);
      this.ui.notify('Repayment recorded');
    });
  }
  clearReminder() {
    void this.router.navigate([], {
      queryParams: { reminder: null, linked: null },
      queryParamsHandling: 'merge',
    });
  }
  accountName(id: string | null) {
    return id
      ? (this.store.accounts().find((a) => a.id === id)?.name ?? 'Linked Finance account')
      : 'Tracking only';
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
