import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { HouseholdBudget, HouseholdSpending } from '../../core/models/domain';
import { HouseholdBudgetsLibrary } from '../../core/services/household-budgets';
import { UiService } from '../../core/services/ui';
import {
  validateHouseholdBudget,
  householdBudgetTotals,
  householdBudgetsCsv,
  householdSpendingCsv,
} from '../../shared/utilities/household-budgets';
@Component({
  selector: 'app-household-budgets',
  imports: [DatePipe, DecimalPipe, ReactiveFormsModule, RouterLink],
  templateUrl: './household-budgets.html',
  styleUrl: './household-budgets.css',
})
export class HouseholdBudgetsPage {
  readonly library = inject(HouseholdBudgetsLibrary);
  readonly store = this.library.store;
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  readonly linked = computed(() => this.params()?.get('linked') ?? '');
  readonly search = signal('');
  readonly month = signal(this.library.month());
  readonly view = signal('current');
  readonly status = signal('all');
  readonly selectedId = signal('');
  readonly rows = computed(() =>
    this.library
      .budgets()
      .filter((b) =>
        this.linked()
          ? b.id === this.linked()
          : b.archived === (this.view() === 'archived') &&
            (!this.month() || b.month.slice(0, 7) === this.month()) &&
            [b.category, b.notes]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()) &&
            (this.status() === 'all' ||
              (this.status() === 'over'
                ? this.library.balance(b).overspent > 0
                : this.library.balance(b).overspent === 0)),
      )
      .sort(
        (a, b) =>
          b.month.localeCompare(a.month) ||
          a.category.localeCompare(b.category) ||
          a.id.localeCompare(b.id),
      ),
  );
  readonly totals = computed(() =>
    householdBudgetTotals(this.rows(), this.store.householdSpending()),
  );
  readonly budget = computed(() =>
    this.library.budgets().find((b) => b.id === (this.selectedId() || this.linked())),
  );
  readonly spendingView = signal('included');
  readonly spending = computed(() =>
    this.budget()
      ? this.library
          .spending(this.budget()!)
          .filter((s) => s.withdrawn === (this.spendingView() === 'withdrawn'))
      : [],
  );
  readonly ownHistory = computed(() =>
    this.library
      .ownSpending()
      .filter((s) => !this.month() || s.booked_on.slice(0, 7) === this.month())
      .sort((a, b) => b.booked_on.localeCompare(a.booked_on) || a.id.localeCompare(b.id)),
  );
  readonly editing = signal(false);
  readonly previous = signal<HouseholdBudget | undefined>(undefined);
  readonly contributionEditor = signal(false);
  readonly editingContribution = signal<HouseholdSpending | undefined>(undefined);
  readonly contributionBudget = signal<HouseholdBudget | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pending = signal<
    | { run: () => Promise<void>; message: string; editor?: 'budget' | 'spending'; entry?: string }
    | undefined
  >(undefined);
  readonly canChange = computed(
    () =>
      this.store.writable() &&
      !this.busy() &&
      !this.pending() &&
      !this.store.loading() &&
      !this.store.error(),
  );
  canPublish(budget: HouseholdBudget) {
    return (
      this.canChange() && !budget.archived && this.library.budgets().some((b) => b.id === budget.id)
    );
  }
  readonly form = inject(FormBuilder).nonNullable.group({
    category: [''],
    month: [this.library.month()],
    currency: ['INR'],
    amount: [''],
    notes: [''],
    visibility: ['private' as HouseholdBudget['visibility']],
  });
  readonly contributionForm = inject(FormBuilder).nonNullable.group({ expense: [''], notes: [''] });
  private readonly context = computed(() =>
    [
      this.store.workspace()?.id,
      this.store.profile()?.id,
      this.store.fileSession(),
      this.store.auth.user()?.id,
      this.store.auth.demo(),
    ].join(':'),
  );
  private request = crypto.randomUUID();
  private entry: string = crypto.randomUUID();
  private spendingRequest = crypto.randomUUID();
  private spendingEntry: string = crypto.randomUUID();
  constructor() {
    effect(() => {
      this.context();
      untracked(() => {
        this.resetDraft();
        this.selectedId.set('');
        this.search.set('');
        this.month.set(this.library.month());
        this.view.set('current');
        this.status.set('all');
        this.spendingView.set('included');
      });
    });
  }
  resetDraft() {
    this.form.reset();
    this.editing.set(false);
    this.previous.set(undefined);
    this.closeContribution();
    this.pending.set(undefined);
    this.error.set('');
    this.request = crypto.randomUUID();
    this.entry = crypto.randomUUID();
  }
  closeContribution() {
    this.contributionEditor.set(false);
    this.editingContribution.set(undefined);
    this.contributionBudget.set(undefined);
    this.contributionForm.reset();
  }
  create() {
    if (!this.canChange()) return;
    this.resetDraft();
    this.form.patchValue({
      month: this.month() || this.library.month(),
      currency: this.store.profile()?.currency ?? 'INR',
    });
    this.editing.set(true);
  }
  edit(budget: HouseholdBudget) {
    if (!this.canChange() || budget.archived || !this.store.canEdit(budget)) return;
    this.resetDraft();
    this.previous.set(budget);
    this.selectedId.set(budget.id);
    this.entry = budget.id;
    this.form.reset({
      category: budget.category,
      month: budget.month.slice(0, 7),
      currency: budget.currency,
      amount: String(budget.amount),
      notes: budget.notes,
      visibility: budget.visibility,
    });
    this.editing.set(true);
  }
  open(budget: HouseholdBudget) {
    if (this.busy() || this.pending()) return;
    this.resetDraft();
    this.selectedId.set(budget.id);
    this.spendingView.set('included');
  }
  async save() {
    if (!this.canChange()) return;
    try {
      const input = this.form.getRawValue();
      validateHouseholdBudget(input);
      const request = this.request,
        id = this.entry,
        old = this.previous();
      this.pending.set({
        run: () => this.library.save(request, id, input, old),
        message: old ? 'Budget updated' : 'Budget created',
        editor: 'budget',
        entry: id,
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  startContribution(budget: HouseholdBudget, previous?: HouseholdSpending) {
    if (!this.canPublish(budget) || (previous && previous.owner_id !== this.store.profile()?.id))
      return;
    this.closeContribution();
    this.contributionBudget.set(budget);
    this.editingContribution.set(previous);
    this.spendingRequest = crypto.randomUUID();
    this.spendingEntry = previous?.id ?? crypto.randomUUID();
    this.contributionForm.reset({
      expense: previous ? (this.library.link(previous)?.transaction_id ?? '') : '',
      notes: previous?.notes ?? '',
    });
    this.contributionEditor.set(true);
  }
  async publish() {
    const budget = this.contributionBudget();
    if (!budget || !this.canPublish(budget)) return;
    const input = this.contributionForm.getRawValue();
    if (!input.expense || input.notes.length > 2000 || input.notes.includes('\0')) {
      this.error.set('Choose an expense and valid contribution notes.');
      return;
    }
    const request = this.spendingRequest,
      id = this.spendingEntry,
      old = this.editingContribution();
    this.pending.set({
      run: () => this.library.publish(request, id, budget, input.expense, input.notes, old),
      message: old
        ? old.withdrawn
          ? 'Contribution restored and refreshed'
          : 'Contribution refreshed'
        : 'Spending linked',
      editor: 'spending',
    });
    await this.retry();
  }
  async withdraw(spending: HouseholdSpending) {
    if (!this.canChange() || spending.withdrawn || spending.owner_id !== this.store.profile()?.id)
      return;
    const request = crypto.randomUUID();
    this.pending.set({
      run: () => this.library.withdraw(request, spending),
      message: 'Contribution withdrawn',
    });
    await this.retry();
  }
  async archive(budget: HouseholdBudget) {
    if (!this.canChange() || !this.store.canEdit(budget)) return;
    const request = crypto.randomUUID();
    this.pending.set({
      run: () => this.library.archive(request, budget, !budget.archived),
      message: budget.archived ? 'Budget restored' : 'Budget archived',
    });
    await this.retry();
  }
  budgetFor(spending: HouseholdSpending) {
    return this.library.budgets().find((b) => b.id === spending.budget_id);
  }
  async retry() {
    const p = this.pending();
    if (!p || this.busy()) return;
    const context = this.context();
    this.busy.set(true);
    this.error.set('');
    try {
      await p.run();
      if (context !== this.context()) return;
      this.ui.notify(p.message);
      if (p.editor === 'budget') {
        this.resetDraft();
        this.selectedId.set(p.entry!);
        this.month.set(this.budget()?.month.slice(0, 7) ?? '');
        this.view.set('current');
        this.status.set('all');
        this.search.set('');
        if (this.linked()) void this.clearLink();
      } else {
        if (p.editor === 'spending') {
          this.closeContribution();
          this.spendingView.set('included');
        }
        this.pending.set(undefined);
      }
    } catch (e) {
      if (context === this.context()) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async refresh() {
    if (this.busy() || this.pending() || !this.store.workspace()) return;
    this.resetDraft();
    const context = this.context();
    this.busy.set(true);
    try {
      await this.store.switchWorkspace(this.store.workspace()!);
      if (context === this.context() && this.store.error()) this.error.set(this.store.error());
    } catch (e) {
      if (context === this.context()) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  exportCsv(spending = false) {
    if (this.store.loading() || this.store.error()) return;
    const content =
      spending && this.budget()
        ? householdSpendingCsv(this.budget()!, this.spending())
        : householdBudgetsCsv(this.rows(), this.store.householdSpending());
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = spending ? 'lifeos-household-spending.csv' : 'lifeos-household-budgets.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  clearLink() {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { linked: null },
      queryParamsHandling: 'merge',
    });
  }
}
