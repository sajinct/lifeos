import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { TravelLibrary } from '../../core/services/travel';
import { UiService } from '../../core/services/ui';
import {
  TravelPlan,
  TravelPlanInput,
  TravelEntry,
  TravelEntryInput,
  TravelBudget,
  TravelExpense,
  TravelRecordKind,
  TravelAction,
} from '../../core/models/domain';
import {
  TRAVEL_STATUSES,
  emptyTravelEntry,
  travelTotals,
  travelEntriesCsv,
} from '../../shared/utilities/travel';
import { csv } from '../../shared/utilities/finance';
type Tab = TravelEntry['kind'] | 'budget' | 'expense';
@Component({
  selector: 'app-travel',
  imports: [DatePipe, TitleCasePipe, ReactiveFormsModule],
  templateUrl: './travel.html',
})
export class TravelPage {
  readonly library = inject(TravelLibrary);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly linked = computed(() => this.params()?.get('linked'));
  readonly selectedId = signal('');
  readonly selected = computed(() => this.owned().find((p) => p.id === this.selectedId()));
  readonly search = signal('');
  readonly kind = signal('all');
  readonly archived = signal(false);
  readonly childArchived = signal(false);
  readonly tabName = signal<Tab>('itinerary');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly owned = computed(() =>
    this.store
      .travelPlans()
      .filter(
        (p) =>
          p.owner_id === this.store.profile()?.id && p.workspace_id === this.store.workspace()?.id,
      ),
  );
  readonly plans = computed(() =>
    this.owned().filter((p) =>
      this.linked()
        ? p.id === this.linked()
        : (this.archived() || !p.archived) &&
          (this.kind() === 'all' || p.kind === this.kind()) &&
          [p.title, p.location, p.notes]
            .join(' ')
            .toLowerCase()
            .includes(this.search().trim().toLowerCase()),
    ),
  );
  readonly entries = computed(() =>
    this.store
      .travelEntries()
      .filter(
        (r) =>
          r.plan_id === this.selectedId() &&
          r.owner_id === this.store.profile()?.id &&
          r.workspace_id === this.store.workspace()?.id &&
          (this.childArchived() || !r.archived) &&
          r.kind === this.tabName(),
      )
      .sort(
        (a, b) =>
          (a.date_on ?? '9999').localeCompare(b.date_on ?? '9999') ||
          a.time_at.localeCompare(b.time_at) ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      ),
  );
  readonly budgets = computed(() =>
    this.store
      .travelBudgets()
      .filter(
        (r) =>
          r.plan_id === this.selectedId() &&
          r.owner_id === this.store.profile()?.id &&
          (this.childArchived() || !r.archived),
      )
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  );
  readonly expenses = computed(() =>
    this.store
      .travelExpenses()
      .filter(
        (r) =>
          r.plan_id === this.selectedId() &&
          r.owner_id === this.store.profile()?.id &&
          (this.childArchived() || !r.archived),
      ),
  );
  readonly totals = computed(() => {
    try {
      const p = this.selected();
      return {
        rows: p
          ? travelTotals(
              p,
              this.store.travelBudgets(),
              this.store.travelExpenses(),
              this.store.transactions(),
              this.store.accounts(),
              this.store.profile()?.id ?? '',
            )
          : [],
        error: '',
      };
    } catch (e) {
      return { rows: [], error: this.store.message(e) };
    }
  });
  readonly availableExpenses = computed(() =>
    this.store
      .transactions()
      .filter(
        (t) =>
          t.workspace_id === this.store.workspace()?.id &&
          t.owner_id === this.store.profile()?.id &&
          t.kind === 'expense' &&
          (!this.store.travelExpenses().some((l) => l.transaction_id === t.id && !l.archived) ||
            t.id === this.previousExpense()?.transaction_id),
      ),
  );
  readonly planningWritable = computed(() => {
    const p = this.selected();
    return (
      !!p &&
      !p.archived &&
      !['completed', 'cancelled'].includes(p.status) &&
      this.store.writable() &&
      !this.busy() &&
      !this.store.loading()
    );
  });
  readonly financialWritable = computed(
    () =>
      !!this.selected() &&
      !this.selected()!.archived &&
      this.store.writable() &&
      !this.busy() &&
      !this.store.loading(),
  );
  readonly planEditor = signal(false);
  readonly previousPlan = signal<TravelPlan | undefined>(undefined);
  private planRequest: string = crypto.randomUUID();
  readonly entryEditor = signal(false);
  readonly previousEntry = signal<TravelEntry | undefined>(undefined);
  private entryRequest: string = crypto.randomUUID();
  readonly budgetEditor = signal(false);
  readonly previousBudget = signal<TravelBudget | undefined>(undefined);
  private budgetRequest: string = crypto.randomUUID();
  readonly expenseEditor = signal(false);
  readonly previousExpense = signal<TravelExpense | undefined>(undefined);
  private expenseRequest: string = crypto.randomUUID();
  readonly statuses = TRAVEL_STATUSES;
  entryStatuses() {
    return this.statuses[this.entryForm.controls.kind.value as TravelEntry['kind']] ?? [];
  }
  readonly planForm = inject(FormBuilder).nonNullable.group({
    kind: 'trip',
    title: '',
    location: '',
    starts_on: this.library.today(),
    ends_on: this.library.today(),
    timezone: this.store.profile()?.timezone ?? 'UTC',
    status: 'planning',
    notes: '',
  });
  readonly entryForm = inject(FormBuilder).nonNullable.group({
    kind: 'itinerary',
    title: '',
    date_on: '',
    end_on: '',
    time_at: '',
    end_time: '',
    location: '',
    reference: '',
    cost: '',
    currency: '',
    email: '',
    phone: '',
    guest_count: '',
    status: 'scheduled',
    notes: '',
  });
  readonly budgetForm = inject(FormBuilder).nonNullable.group({
    currency: this.store.currency(),
    amount: '',
  });
  readonly expenseForm = inject(FormBuilder).nonNullable.group({ expense: '', notes: '' });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => {
        this.selectedId.set(this.linked() ?? '');
        this.closeEditors();
        this.error.set('');
        this.childArchived.set(false);
      });
    });
    effect(() => {
      const id = this.linked();
      if (id) this.selectedId.set(id);
    });
  }
  closeEditors() {
    this.planEditor.set(false);
    this.entryEditor.set(false);
    this.budgetEditor.set(false);
    this.expenseEditor.set(false);
  }
  open(p: TravelPlan) {
    this.selectedId.set(p.id);
    this.tabName.set('itinerary');
    this.childArchived.set(false);
    this.closeEditors();
    this.error.set('');
  }
  tab(tab: Tab) {
    this.tabName.set(tab);
    this.closeEditors();
    this.error.set('');
  }
  clearLinked() {
    this.selectedId.set('');
    void this.router.navigate(['/travel']);
  }
  summary(p: TravelPlan) {
    const rows = this.store
        .travelEntries()
        .filter(
          (r) =>
            r.plan_id === p.id &&
            r.owner_id === this.store.profile()?.id &&
            r.workspace_id === p.workspace_id &&
            !r.archived,
        ),
      checks = rows.filter((r) => r.kind === 'checklist');
    return {
      checks: checks.length,
      done: checks.filter((r) => r.status === 'done').length,
      itinerary: rows.filter((r) => r.kind === 'itinerary').length,
      bookings: rows.filter((r) => r.kind === 'booking' && r.status !== 'cancelled').length,
      guests: rows
        .filter((r) => r.kind === 'guest' && r.status === 'accepted')
        .reduce((s, r) => s + (r.guest_count ?? 0), 0),
    };
  }
  money(value: number, currency: string) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(value);
  }
  transaction(id: string) {
    return this.store
      .transactions()
      .find(
        (t) =>
          t.id === id &&
          t.workspace_id === this.store.workspace()?.id &&
          t.owner_id === this.store.profile()?.id &&
          t.kind === 'expense',
      );
  }
  expenseLabel(id: string) {
    const t = this.transaction(id),
      a =
        t &&
        this.store
          .accounts()
          .find(
            (a) =>
              a.id === t.account_id &&
              a.owner_id === t.owner_id &&
              a.workspace_id === t.workspace_id,
          );
    return t && a
      ? `${t.title} · ${this.money(Number(t.amount), a.currency)} · ${t.booked_on}`
      : 'Unavailable recorded expense';
  }
  editPlan(p?: TravelPlan) {
    this.previousPlan.set(p);
    this.planRequest = p?.id ?? crypto.randomUUID();
    this.planForm.controls.kind.enable();
    this.planForm.reset(
      p ?? {
        kind: 'trip',
        title: '',
        location: '',
        starts_on: this.library.today(),
        ends_on: this.library.today(),
        timezone: this.store.profile()?.timezone ?? 'UTC',
        status: 'planning',
        notes: '',
      },
    );
    if (p) this.planForm.controls.kind.disable();
    this.planEditor.set(true);
    this.error.set('');
  }
  editEntry(r?: TravelEntry) {
    const p = this.selected(),
      kind = this.tabName();
    if (!p || kind === 'budget' || kind === 'expense') return;
    this.previousEntry.set(r);
    this.entryRequest = r?.id ?? crypto.randomUUID();
    this.entryForm.reset(
      r
        ? {
            ...r,
            date_on: r.date_on ?? '',
            end_on: r.end_on ?? '',
            cost: r.cost === null ? '' : String(r.cost),
            guest_count: r.guest_count === null ? '' : String(r.guest_count),
          }
        : emptyTravelEntry(kind, p),
    );
    this.entryEditor.set(true);
    this.error.set('');
  }
  editBudget(r?: TravelBudget) {
    this.previousBudget.set(r);
    this.budgetRequest = r?.id ?? crypto.randomUUID();
    this.budgetForm.controls.currency.enable();
    this.budgetForm.reset({
      currency: r?.currency ?? this.store.currency(),
      amount: r ? String(r.amount) : '',
    });
    if (r) this.budgetForm.controls.currency.disable();
    this.budgetEditor.set(true);
    this.error.set('');
  }
  editExpense(r?: TravelExpense) {
    this.previousExpense.set(r);
    this.expenseRequest = r?.id ?? crypto.randomUUID();
    this.expenseForm.controls.expense.enable();
    this.expenseForm.reset({ expense: r?.transaction_id ?? '', notes: r?.notes ?? '' });
    if (r) this.expenseForm.controls.expense.disable();
    this.expenseEditor.set(true);
    this.error.set('');
  }
  async savePlan() {
    await this.run(
      () =>
        this.library.savePlan(
          this.planRequest,
          this.planForm.getRawValue() as TravelPlanInput,
          this.previousPlan(),
        ),
      () => {
        this.planEditor.set(false);
        this.selectedId.set(this.planRequest);
        this.ui.notify('Travel plan saved');
      },
    );
  }
  async saveEntry() {
    const p = this.selected();
    if (!p) return;
    await this.run(
      () =>
        this.library.saveEntry(
          this.entryRequest,
          p,
          this.entryForm.getRawValue() as TravelEntryInput,
          this.previousEntry(),
        ),
      () => {
        this.entryEditor.set(false);
        this.ui.notify('Planning entry saved');
      },
    );
  }
  async saveBudget() {
    const p = this.selected(),
      v = this.budgetForm.getRawValue();
    if (!p) return;
    await this.run(
      () =>
        this.library.saveBudget(this.budgetRequest, p, v.currency, v.amount, this.previousBudget()),
      () => {
        this.budgetEditor.set(false);
        this.ui.notify('Travel budget saved');
      },
    );
  }
  async saveExpense() {
    const p = this.selected(),
      v = this.expenseForm.getRawValue();
    if (!p) return;
    await this.run(
      () =>
        this.library.saveExpense(
          this.expenseRequest,
          p,
          v.expense,
          v.notes,
          this.previousExpense(),
        ),
      () => {
        this.expenseEditor.set(false);
        this.ui.notify('Travel expense linked');
      },
    );
  }
  async act(
    row: TravelPlan | TravelEntry | TravelBudget | TravelExpense,
    kind: TravelRecordKind,
    action: TravelAction,
  ) {
    await this.run(
      () => this.library.act(row, kind, action),
      () => this.ui.notify('Travel record updated'),
    );
  }
  export(kind: 'plans' | 'entries' | 'finances') {
    if (this.store.loading() || this.store.error()) return;
    try {
      const plans = this.selected() ? [this.selected()!] : this.plans(),
        user = this.store.profile()?.id ?? '',
        text =
          kind === 'entries'
            ? travelEntriesCsv(this.entries())
            : kind === 'plans'
              ? csv(
                  plans.map((p) => ({
                    kind: p.kind,
                    title: p.title,
                    location: p.location,
                    start: p.starts_on,
                    end: p.ends_on,
                    timezone: p.timezone,
                    status: p.status,
                    notes: p.notes,
                    archived: p.archived,
                    ...this.summary(p),
                  })),
                )
              : csv(
                  plans.flatMap((p) =>
                    travelTotals(
                      p,
                      this.store.travelBudgets(),
                      this.store.travelExpenses(),
                      this.store.transactions(),
                      this.store.accounts(),
                      user,
                    ).map((t) => ({
                      plan: p.title,
                      currency: t.currency,
                      budget: t.planned,
                      recorded_expenses: t.spent,
                      remaining: t.remaining,
                    })),
                  ),
                );
      const url = URL.createObjectURL(
          new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
        ),
        a = document.createElement('a');
      a.href = url;
      a.download = `lifeos-travel-${kind}-${this.library.today()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  private async run(action: () => Promise<void>, after?: () => void) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (w === this.store.workspace()?.id && s === this.store.fileSession()) after?.();
    } catch (e) {
      if (w === this.store.workspace()?.id && s === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
