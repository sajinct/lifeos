import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { EducationStudent, EducationFee, EducationPayment } from '../../core/models/domain';
import { EducationLibrary } from '../../core/services/education';
import { UiService } from '../../core/services/ui';
import {
  validateStudent,
  validateFee,
  validatePayment,
  educationTotals,
  educationCsv,
  educationPaymentsCsv,
} from '../../shared/utilities/education';
@Component({
  selector: 'app-education',
  imports: [DatePipe, DecimalPipe, ReactiveFormsModule, RouterLink],
  templateUrl: './education.html',
  styleUrl: './education.css',
})
export class EducationPage {
  readonly library = inject(EducationLibrary);
  readonly store = this.library.store;
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  readonly linked = computed(() => this.params()?.get('linked') ?? '');
  readonly search = signal('');
  readonly view = signal('current');
  readonly selectedId = signal('');
  readonly rows = computed(() =>
    this.library
      .students()
      .filter((s) =>
        this.linked()
          ? s.id === this.linked()
          : s.archived === (this.view() === 'archived') &&
            [s.name, s.institution, s.class_name, s.academic_year]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  );
  readonly student = computed(() =>
    this.library.students().find((s) => s.id === (this.selectedId() || this.linked())),
  );
  readonly feeView = signal('current');
  readonly fees = computed(() =>
    this.student()
      ? this.library
          .fees(this.student()!)
          .filter((f) =>
            this.feeView() === 'archived'
              ? f.archived
              : !f.archived &&
                (this.feeView() === 'current' ||
                  (this.feeView() === 'paid'
                    ? this.library.balance(f).remaining === 0
                    : this.library.balance(f).remaining > 0 &&
                      (this.feeView() !== 'overdue' || f.due_on < this.library.today()))),
          )
      : [],
  );
  readonly totals = computed(() =>
    educationTotals(this.fees(), this.store.educationPayments(), this.library.today()),
  );
  readonly paymentView = signal('all');
  payments(fee: EducationFee) {
    return this.library
      .payments(fee)
      .filter(
        (p) => this.paymentView() === 'all' || p.voided === (this.paymentView() === 'voided'),
      );
  }
  readonly editing = signal(false);
  readonly previous = signal<EducationStudent | undefined>(undefined);
  readonly feeEditor = signal(false);
  readonly editingFee = signal<EducationFee | undefined>(undefined);
  readonly payingFee = signal<EducationFee | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly pending = signal<
    | {
        run: () => Promise<void>;
        message: string;
        editor?: 'student' | 'fee' | 'payment';
        entry?: string;
      }
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
  readonly canManage = computed(
    () =>
      this.canChange() &&
      !!this.student() &&
      !this.student()!.archived &&
      this.store.canEdit(this.student()!),
  );
  readonly form = inject(FormBuilder).nonNullable.group({
    name: [''],
    institution: [''],
    class_name: [''],
    academic_year: [''],
    member_id: [''],
    notes: [''],
    visibility: ['private' as EducationStudent['visibility']],
  });
  readonly feeForm = inject(FormBuilder).nonNullable.group({
    title: [''],
    due_on: [''],
    amount: [''],
    currency: ['INR'],
    notes: [''],
  });
  readonly paymentForm = inject(FormBuilder).nonNullable.group({
    amount: [''],
    paid_on: [''],
    reference: [''],
    notes: [''],
    expense: [''],
  });
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
  private feeRequest = crypto.randomUUID();
  private feeEntry: string = crypto.randomUUID();
  private paymentRequest = crypto.randomUUID();
  private paymentEntry: string = crypto.randomUUID();
  private childParent: EducationStudent | undefined;
  constructor() {
    effect(() => {
      this.context();
      untracked(() => {
        this.resetDraft();
        this.selectedId.set('');
        this.search.set('');
        this.view.set('current');
        this.feeView.set('current');
        this.paymentView.set('all');
      });
    });
  }
  resetDraft() {
    this.form.reset();
    this.feeForm.reset();
    this.paymentForm.reset();
    this.editing.set(false);
    this.previous.set(undefined);
    this.closeChildren();
    this.pending.set(undefined);
    this.error.set('');
    this.request = crypto.randomUUID();
    this.entry = crypto.randomUUID();
  }
  closeChildren() {
    this.feeEditor.set(false);
    this.editingFee.set(undefined);
    this.payingFee.set(undefined);
    this.childParent = undefined;
    this.feeForm.reset();
    this.paymentForm.reset();
  }
  create() {
    if (!this.canChange()) return;
    this.resetDraft();
    this.editing.set(true);
  }
  edit(student: EducationStudent) {
    if (!this.canChange() || student.archived || !this.store.canEdit(student)) return;
    this.resetDraft();
    this.previous.set(student);
    this.selectedId.set(student.id);
    this.entry = student.id;
    this.form.reset({
      name: student.name,
      institution: student.institution,
      class_name: student.class_name,
      academic_year: student.academic_year,
      member_id: student.member_id ?? '',
      notes: student.notes,
      visibility: student.visibility,
    });
    this.editing.set(true);
  }
  open(student: EducationStudent) {
    if (this.busy() || this.pending()) return;
    this.resetDraft();
    this.selectedId.set(student.id);
    this.feeView.set('current');
    this.paymentView.set('all');
  }
  async saveStudent() {
    if (!this.canChange()) return;
    try {
      const input = validateStudent(this.form.getRawValue()),
        request = this.request,
        id = this.entry,
        old = this.previous();
      this.pending.set({
        run: () => this.library.saveStudent(request, id, input, old),
        message: old ? 'Student updated' : 'Student created',
        editor: 'student',
        entry: id,
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  startFee(fee?: EducationFee) {
    if (!this.canManage() || fee?.archived) return;
    this.closeChildren();
    this.childParent = this.student();
    this.feeRequest = crypto.randomUUID();
    this.feeEntry = fee?.id ?? crypto.randomUUID();
    this.editingFee.set(fee);
    this.feeForm.reset({
      title: fee?.title ?? '',
      due_on: fee?.due_on ?? '',
      amount: fee ? String(fee.amount) : '',
      currency: fee?.currency ?? this.store.profile()?.currency ?? 'INR',
      notes: fee?.notes ?? '',
    });
    this.feeEditor.set(true);
  }
  async saveFee() {
    if (!this.canManage() || !this.childParent) return;
    try {
      const input = this.feeForm.getRawValue();
      validateFee(input);
      const parent = this.childParent,
        request = this.feeRequest,
        id = this.feeEntry,
        old = this.editingFee();
      this.pending.set({
        run: () => this.library.saveFee(request, id, parent, input, old),
        message: old ? 'Fee updated' : 'Fee scheduled',
        editor: 'fee',
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  startPayment(fee: EducationFee) {
    if (!this.canManage() || fee.archived || this.library.balance(fee).remaining <= 0) return;
    this.closeChildren();
    this.childParent = this.student();
    this.payingFee.set(fee);
    this.paymentRequest = crypto.randomUUID();
    this.paymentEntry = crypto.randomUUID();
    this.paymentForm.reset({
      amount: String(this.library.balance(fee).remaining),
      paid_on: this.library.today(),
      reference: '',
      notes: '',
      expense: '',
    });
  }
  chooseExpense(id: string) {
    this.paymentForm.controls.expense.setValue(id);
    const fee = this.payingFee();
    if (!fee) return;
    const expense = this.library.expenseChoices(fee).find((t) => t.id === id);
    if (expense)
      this.paymentForm.patchValue({ amount: String(expense.amount), paid_on: expense.booked_on });
  }
  async recordPayment() {
    if (!this.canManage() || !this.childParent || !this.payingFee()) return;
    try {
      const input = this.paymentForm.getRawValue();
      validatePayment(input, this.library.today());
      const parent = this.childParent,
        fee = this.payingFee()!,
        request = this.paymentRequest,
        id = this.paymentEntry;
      this.pending.set({
        run: () => this.library.recordPayment(request, id, parent, fee, input),
        message: 'Payment recorded',
        editor: 'payment',
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  async archive(student: EducationStudent, fee?: EducationFee) {
    if (!this.canChange() || !this.store.canEdit(student) || (fee && student.archived)) return;
    const request = crypto.randomUUID(),
      archived = !(fee?.archived ?? student.archived);
    this.pending.set({
      run: () => this.library.archive(request, student, archived, fee),
      message: (fee ? 'Fee' : 'Student') + (archived ? ' archived' : ' restored'),
    });
    await this.retry();
  }
  async voidPayment(fee: EducationFee, payment: EducationPayment) {
    if (!this.canManage() || fee.archived) return;
    const student = this.student()!,
      request = crypto.randomUUID();
    this.pending.set({
      run: () => this.library.voidPayment(request, student, fee, payment, !payment.voided),
      message: payment.voided ? 'Payment restored' : 'Payment voided',
    });
    await this.retry();
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
      if (p.editor === 'student') {
        this.resetDraft();
        this.selectedId.set(p.entry!);
        this.view.set('current');
        this.search.set('');
        if (this.linked()) void this.clearLink();
      } else {
        if (p.editor) {
          this.closeChildren();
          this.feeView.set('current');
          this.paymentView.set('all');
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
  exportCsv(payments = false) {
    if (this.store.loading() || this.store.error() || !this.student() || !this.fees().length)
      return;
    const content = payments
      ? educationPaymentsCsv(
          this.fees(),
          this.fees().flatMap((f) => this.payments(f)),
        )
      : educationCsv([this.student()!], this.fees(), this.store.educationPayments());
    if (!content) return;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = payments ? 'lifeos-school-payments.csv' : 'lifeos-school-fees.csv';
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
