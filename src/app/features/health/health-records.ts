import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { HealthTracking } from '../../core/services/health-tracking';
import {
  HealthLog,
  HealthExpense,
  MedicationPlan,
  HealthTrackingKind,
  HealthTrackingAction,
} from '../../core/models/domain';
import {
  medicalTotals,
  measurementHistory,
  healthLogsCsv,
} from '../../shared/utilities/health-tracking';
import { csv } from '../../shared/utilities/finance';
import { UiService } from '../../core/services/ui';
export type HealthTab = 'fitness' | 'measurement' | 'medication' | 'expense';
@Component({
  selector: 'app-health-records',
  imports: [DatePipe, ReactiveFormsModule],
  templateUrl: './health-records.html',
})
export class HealthRecords {
  readonly library = inject(HealthTracking);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  readonly section = input<HealthTab>('fitness');
  readonly selectedId = input<string | null>(null);
  readonly archived = signal(false);
  readonly search = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly editor = signal(false);
  readonly editing = signal<HealthLog | MedicationPlan | HealthExpense | undefined>(undefined);
  private request: string = crypto.randomUUID();
  readonly days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly logForm = inject(FormBuilder).nonNullable.group({
    title: '',
    logged_on: this.library.health.today(),
    minutes: '30',
    value: '',
    unit: '',
    notes: '',
  });
  readonly medicationForm = inject(FormBuilder).nonNullable.group({
    title: '',
    instructions: '',
    starts_on: this.library.health.today(),
    ends_on: '',
    weekdays: [[0, 1, 2, 3, 4, 5, 6]],
    reminder_time: '09:00',
    timezone: this.store.profile()?.timezone ?? 'UTC',
  });
  readonly expenseForm = inject(FormBuilder).nonNullable.group({
    expense: '',
    appointment: '',
    notes: '',
  });
  readonly logs = computed(() =>
    this.store
      .healthLogs()
      .filter(
        (r) =>
          r.owner_id === this.store.profile()?.id &&
          r.workspace_id === this.store.workspace()?.id &&
          r.kind === this.section() &&
          (this.archived() || !r.archived) &&
          [r.title, r.notes, r.unit].join(' ').toLowerCase().includes(this.search().toLowerCase()),
      )
      .sort(
        (a, b) =>
          b.logged_on.localeCompare(a.logged_on) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly plans = computed(() =>
    this.store
      .medicationPlans()
      .filter(
        (r) =>
          r.owner_id === this.store.profile()?.id &&
          r.workspace_id === this.store.workspace()?.id &&
          (this.selectedId()
            ? r.id === this.selectedId()
            : (this.archived() || !r.archived) &&
              [r.title, r.instructions]
                .join(' ')
                .toLowerCase()
                .includes(this.search().toLowerCase())),
      ),
  );
  readonly expenses = computed(() =>
    this.store
      .healthExpenses()
      .filter(
        (r) =>
          r.owner_id === this.store.profile()?.id &&
          r.workspace_id === this.store.workspace()?.id &&
          (this.archived() || !r.archived) &&
          [this.transaction(r.transaction_id)?.title, r.notes]
            .join(' ')
            .toLowerCase()
            .includes(this.search().toLowerCase()),
      ),
  );
  readonly history = computed(() => measurementHistory(this.logs()));
  readonly minutes = computed(() =>
    this.logs()
      .filter((r) => !r.archived)
      .reduce((s, r) => s + (r.minutes ?? 0), 0),
  );
  readonly totals = computed(() => {
    try {
      return {
        rows: medicalTotals(
          this.expenses(),
          this.store.transactions(),
          this.store.accounts(),
          this.store.profile()?.id ?? '',
          this.store.workspace()?.id ?? '',
        ),
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
          t.owner_id === this.store.profile()?.id &&
          t.workspace_id === this.store.workspace()?.id &&
          t.kind === 'expense' &&
          (!this.store.healthExpenses().some((l) => l.transaction_id === t.id) ||
            (this.editing() &&
              'transaction_id' in this.editing()! &&
              t.id === (this.editing() as HealthExpense).transaction_id)),
      ),
  );
  readonly appointments = computed(() =>
    this.store
      .healthAppointments()
      .filter(
        (r) =>
          r.owner_id === this.store.profile()?.id && r.workspace_id === this.store.workspace()?.id,
      ),
  );
  constructor() {
    effect(() => {
      this.section();
      this.store.workspace();
      this.store.fileSession();
      this.editor.set(false);
      this.editing.set(undefined);
      this.error.set('');
      this.search.set('');
      this.archived.set(false);
    });
  }
  transaction(id: string) {
    return this.store
      .transactions()
      .find(
        (t) =>
          t.id === id &&
          t.owner_id === this.store.profile()?.id &&
          t.workspace_id === this.store.workspace()?.id &&
          t.kind === 'expense',
      );
  }
  money(id: string) {
    const t = this.transaction(id),
      a = t && this.store.accounts().find((a) => a.id === t.account_id);
    return t && a ? this.formatMoney(Number(t.amount), a.currency) : 'Unavailable expense';
  }
  formatMoney(value: number, currency: string) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(value);
  }
  appointment(id: string | null) {
    return this.appointments().find((a) => a.id === id)?.title ?? 'No appointment link';
  }
  weekdays(row: MedicationPlan) {
    return row.weekdays.map((d) => this.days[d]).join(', ');
  }
  selectDay(day: number, checked: boolean) {
    const c = this.medicationForm.controls.weekdays;
    c.setValue(checked ? [...new Set([...c.value, day])].sort() : c.value.filter((d) => d !== day));
  }
  add(row?: HealthLog | MedicationPlan | HealthExpense) {
    this.editing.set(row);
    this.request = row?.id ?? crypto.randomUUID();
    this.error.set('');
    if (this.section() === 'fitness' || this.section() === 'measurement') {
      const r = row as HealthLog | undefined;
      this.logForm.reset({
        title: r?.title ?? '',
        logged_on: r?.logged_on ?? this.library.health.today(),
        minutes: r?.minutes ? String(r.minutes) : this.section() === 'fitness' ? '30' : '',
        value: r?.value === null || r?.value === undefined ? '' : String(r.value),
        unit: r?.unit ?? '',
        notes: r?.notes ?? '',
      });
    } else if (this.section() === 'medication') {
      const r = row as MedicationPlan | undefined;
      this.medicationForm.reset({
        title: r?.title ?? '',
        instructions: r?.instructions ?? '',
        starts_on: r?.starts_on ?? this.library.health.today(),
        ends_on: r?.ends_on ?? '',
        weekdays: r?.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
        reminder_time: r?.reminder_time ?? '09:00',
        timezone: r?.timezone ?? this.store.profile()?.timezone ?? 'UTC',
      });
    } else {
      const r = row as HealthExpense | undefined;
      this.expenseForm.reset({
        expense: r?.transaction_id ?? '',
        appointment: r?.appointment_id ?? '',
        notes: r?.notes ?? '',
      });
    }
    this.editor.set(true);
  }
  async save() {
    await this.run(
      async () => {
        const previous = this.editing();
        if (this.section() === 'fitness' || this.section() === 'measurement')
          await this.library.saveLog(
            this.request,
            { ...this.logForm.getRawValue(), kind: this.section() as 'fitness' | 'measurement' },
            previous as HealthLog | undefined,
          );
        else if (this.section() === 'medication')
          await this.library.saveMedication(
            this.request,
            this.medicationForm.getRawValue(),
            previous as MedicationPlan | undefined,
          );
        else {
          const v = this.expenseForm.getRawValue();
          await this.library.saveExpense(
            this.request,
            v.expense,
            v.appointment,
            v.notes,
            previous as HealthExpense | undefined,
          );
        }
      },
      () => {
        this.editor.set(false);
        this.ui.notify('Health record saved');
      },
    );
  }
  async act(
    row: HealthLog | MedicationPlan | HealthExpense,
    kind: HealthTrackingKind,
    action: HealthTrackingAction,
  ) {
    await this.run(
      () => this.library.act(row, kind, action),
      () => this.ui.notify('Health record updated'),
    );
  }
  export() {
    if (this.store.loading() || this.store.error()) return;
    const text =
      this.section() === 'medication'
        ? csv(
            this.plans().map((r) => ({
              title: r.title,
              instructions: r.instructions,
              start: r.starts_on,
              end: r.ends_on,
              weekdays: this.weekdays(r),
              time: r.reminder_time,
              timezone: r.timezone,
              active: r.active,
              archived: r.archived,
            })),
          )
        : this.section() === 'expense'
          ? csv(
              this.expenses().map((r) => ({
                transaction_id: r.transaction_id,
                title: this.transaction(r.transaction_id)?.title,
                expense: this.money(r.transaction_id),
                date: this.transaction(r.transaction_id)?.booked_on,
                appointment: this.appointment(r.appointment_id),
                notes: r.notes,
                archived: r.archived,
              })),
            )
          : healthLogsCsv(this.logs());
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-health-${this.section()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async run(action: () => Promise<void>, after?: () => void) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      s = this.store.fileSession(),
      tab = this.section();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (
        w === this.store.workspace()?.id &&
        s === this.store.fileSession() &&
        tab === this.section()
      )
        after?.();
    } catch (e) {
      if (
        w === this.store.workspace()?.id &&
        s === this.store.fileSession() &&
        tab === this.section()
      )
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
