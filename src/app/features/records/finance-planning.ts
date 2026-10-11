import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { Bill, Budget, Frequency, RecurringTransaction } from '../../core/models/domain';
import { budgetSpent, localDate } from '../../shared/utilities/finance';
@Component({
  selector: 'app-finance-planning',
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './finance-planning.html',
})
export class FinancePlanning {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly Math = Math;
  private readonly fb = inject(FormBuilder);
  readonly tab = signal<'budgets' | 'bills' | 'recurring'>('budgets');
  readonly month = signal(localDate().slice(0, 7));
  readonly showForm = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly today = localDate();
  readonly budgets = computed(() =>
    this.store.budgets().filter((b) => b.month.slice(0, 7) === this.month()),
  );
  readonly bills = computed(() =>
    [...this.store.bills()].sort(
      (a, b) =>
        (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
        a.due_on.localeCompare(b.due_on),
    ),
  );
  readonly ownedAccounts = computed(() =>
    this.store
      .accounts()
      .filter(
        (a) => a.owner_id === (this.store.auth.demo() ? 'demo-user' : this.store.auth.user()?.id),
      ),
  );
  readonly currencies = computed(() => [
    ...new Set([this.store.currency(), ...this.ownedAccounts().map((a) => a.currency)]),
  ]);
  readonly budgetForm = this.fb.nonNullable.group({
    category: ['Food', [Validators.required, Validators.maxLength(100)]],
    month: [this.month(), Validators.required],
    currency: [this.store.currency(), Validators.required],
    amount: ['', Validators.required],
  });
  readonly planForm = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(200)]],
    account_id: ['', Validators.required],
    amount: ['', Validators.required],
    category: ['Other', [Validators.required, Validators.maxLength(100)]],
    date: [localDate(), Validators.required],
    frequency: ['monthly' as Frequency, Validators.required],
    kind: ['expense' as 'income' | 'expense', Validators.required],
    automatic: [false],
  });
  select(tab: 'budgets' | 'bills' | 'recurring') {
    this.tab.set(tab);
    this.showForm.set(false);
    this.error.set('');
  }
  add() {
    this.error.set('');
    this.showForm.set(true);
    this.budgetForm.patchValue({
      month: this.month(),
      currency: this.store.currency(),
      amount: '',
    });
    this.planForm.reset({
      title: '',
      account_id: this.ownedAccounts()[0]?.id ?? '',
      amount: '',
      category: 'Other',
      date: localDate(),
      frequency: 'monthly',
      kind: 'expense',
      automatic: false,
    });
  }
  editBudget(b: Budget) {
    this.budgetForm.setValue({
      category: b.category,
      month: b.month.slice(0, 7),
      currency: b.currency,
      amount: String(b.amount),
    });
    this.showForm.set(true);
    this.error.set('');
  }
  async saveBudget() {
    await this.perform(async () => {
      if (this.budgetForm.invalid) throw new Error('Complete all budget fields.');
      const v = this.budgetForm.getRawValue();
      await this.store.saveBudget(v.category, v.month, v.currency, v.amount);
      this.month.set(v.month);
      this.showForm.set(false);
      this.ui.notify('Budget saved');
    });
  }
  async savePlan() {
    await this.perform(async () => {
      if (this.planForm.invalid) throw new Error('Complete all required fields.');
      await this.store.createFinancePlan(
        this.tab() === 'bills' ? 'bill' : 'recurring',
        this.planForm.getRawValue(),
      );
      this.showForm.set(false);
      this.ui.notify(this.tab() === 'bills' ? 'Bill added' : 'Recurring schedule added');
    });
  }
  async pay(b: Bill) {
    await this.perform(async () => {
      await this.store.settleBill(b);
      this.ui.notify('Payment recorded as an expense');
    });
  }
  async cancel(b: Bill) {
    await this.perform(async () => {
      await this.store.cancelBill(b);
      this.ui.notify('Bill cancelled');
    });
  }
  async remove(b: Budget) {
    await this.perform(() => this.store.deleteBudget(b));
  }
  async pause(r: RecurringTransaction) {
    await this.perform(() => this.store.setRecurringActive(r));
  }
  async post(r: RecurringTransaction) {
    await this.perform(async () => {
      const count = await this.store.postRecurring(r);
      this.ui.notify(`${count} due transaction${count === 1 ? '' : 's'} recorded`);
    });
  }
  private async perform(action: () => Promise<unknown>) {
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
  spent(b: Budget) {
    return budgetSpent(b, this.store.transactions(), this.store.accounts());
  }
  progress(b: Budget) {
    return Math.min(100, Math.round((this.spent(b) / Number(b.amount)) * 100));
  }
  money(amount: number, currency: string) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(amount);
  }
  accountLabel(id: string) {
    const a = this.store.accounts().find((a) => a.id === id);
    return a ? `${a.name} · ${a.currency}` : 'Account';
  }
  currency(id: string) {
    return this.store.accounts().find((a) => a.id === id)?.currency ?? this.store.currency();
  }
}
