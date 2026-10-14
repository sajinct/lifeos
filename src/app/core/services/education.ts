import { computed, effect, inject, Injectable } from '@angular/core';
import {
  EducationStudent,
  EducationStudentInput,
  EducationFee,
  EducationFeeInput,
  EducationPayment,
  EducationPaymentInput,
} from '../models/domain';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  validateStudent,
  validateFee,
  validatePayment,
  feeBalance,
} from '../../shared/utilities/education';
import { cents } from '../../shared/utilities/finance';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class EducationLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly requests = new Map<
    string,
    { w: string; user: string; session: number; payload: string; done: boolean }
  >();
  private requestSession = -1;
  readonly students = computed(() =>
    this.store
      .educationStudents()
      .filter(
        (s) =>
          s.workspace_id === this.store.workspace()?.id &&
          (s.owner_id === this.store.profile()?.id || s.visibility === 'workspace'),
      ),
  );
  readonly memberChoices = computed(() =>
    this.store
      .householdMembers()
      .filter(
        (m) =>
          m.workspace_id === this.store.workspace()?.id &&
          (m.owner_id === this.store.profile()?.id || m.visibility === 'workspace'),
      ),
  );
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.syncRequests();
    });
  }
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  fees(student: EducationStudent) {
    return this.store
      .educationFees()
      .filter(
        (f) =>
          f.student_id === student.id &&
          f.workspace_id === student.workspace_id &&
          this.students().some((s) => s.id === student.id),
      )
      .sort((a, b) => a.due_on.localeCompare(b.due_on) || a.id.localeCompare(b.id));
  }
  payments(fee: EducationFee) {
    return this.store
      .educationPayments()
      .filter((p) => p.fee_id === fee.id && p.workspace_id === fee.workspace_id)
      .sort(
        (a, b) =>
          b.paid_on.localeCompare(a.paid_on) ||
          b.created_at.localeCompare(a.created_at) ||
          a.id.localeCompare(b.id),
      );
  }
  balance(fee: EducationFee) {
    return feeBalance(fee, this.payments(fee));
  }
  link(payment: EducationPayment) {
    return this.store
      .educationPaymentLinks()
      .find(
        (l) =>
          l.id === payment.id &&
          l.workspace_id === payment.workspace_id &&
          l.owner_id === this.store.profile()?.id,
      );
  }
  linkStatus(payment: EducationPayment, fee: EducationFee) {
    const link = this.link(payment);
    if (!link) return '';
    const expense = this.store
        .transactions()
        .find(
          (t) =>
            t.id === link.transaction_id &&
            t.workspace_id === payment.workspace_id &&
            t.owner_id === this.store.profile()?.id,
        ),
      account = this.store
        .accounts()
        .find((a) => a.id === expense?.account_id && a.owner_id === this.store.profile()?.id);
    return expense &&
      account &&
      expense.kind === 'expense' &&
      cents(expense.amount) === cents(payment.amount) &&
      expense.booked_on === payment.paid_on &&
      account.currency === fee.currency
      ? 'Linked expense: ' + expense.title
      : 'Linked expense unavailable or changed — review in Finance';
  }
  expenseChoices(fee: EducationFee) {
    return this.store
      .transactions()
      .filter(
        (t) =>
          t.workspace_id === fee.workspace_id &&
          t.owner_id === this.store.profile()?.id &&
          t.kind === 'expense' &&
          this.store
            .accounts()
            .some(
              (a) =>
                a.id === t.account_id &&
                a.owner_id === this.store.profile()?.id &&
                a.currency === fee.currency,
            ) &&
          !this.store.educationPaymentLinks().some((l) => l.transaction_id === t.id),
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
  private current(c: ReturnType<EducationLibrary['stamp']>) {
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
  private remember(request: string, c: ReturnType<EducationLibrary['context']>, payload: unknown) {
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
  private async reload(c: ReturnType<EducationLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error())
      throw new Error('Education change saved, but refresh failed. Retry this change safely.');
  }

  private parent(
    previous: EducationStudent,
    c: ReturnType<EducationLibrary['context']>,
    retry: boolean,
  ) {
    const old = this.students().find((s) => s.id === previous.id);
    if (!this.store.auth.demo() && retry && previous.workspace_id === c.w) return old ?? previous;
    if (!old || !this.store.canEdit(old)) throw new Error('Student is inaccessible.');
    return old;
  }
  private active(student: EducationStudent, previous: EducationStudent) {
    if (student.archived) throw new Error('Restore the student before changing fees.');
    if (student.revision !== previous.revision)
      throw new Error('Student changed; refresh and try again.');
  }
  private fee(previous: EducationFee, student: EducationStudent) {
    const old = this.fees(student).find((f) => f.id === previous.id);
    if (!old) throw new Error('Fee is inaccessible.');
    if (old.revision !== previous.revision) throw new Error('Fee changed; refresh and try again.');
    return old;
  }
  private bump(student: string, fee?: string) {
    const now = new Date().toISOString();
    this.store.educationStudents.update((rows) =>
      rows.map((s) => (s.id === student ? { ...s, revision: s.revision + 1, updated_at: now } : s)),
    );
    if (fee)
      this.store.educationFees.update((rows) =>
        rows.map((f) => (f.id === fee ? { ...f, revision: f.revision + 1, updated_at: now } : f)),
      );
  }
  async saveStudent(
    request: string,
    id: string,
    input: EducationStudentInput,
    previous?: EducationStudent,
  ) {
    const c = this.context(request),
      v = validateStudent(input),
      old = previous
        ? this.parent(previous, c, this.requests.has(request))
        : this.students().find((s) => s.id === id),
      done = this.remember(request, c, ['student', id, previous?.revision ?? null, v]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_education_student', {
        request,
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        student_name: v.name,
        school: v.institution,
        school_class: v.class_name,
        school_year: v.academic_year,
        student_notes: v.notes,
        household_member: v.member_id || null,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (old && !this.store.canEdit(old)) throw new Error('Student is inaccessible.');
    if (done) return;
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Student changed; refresh and try again.');
    if (previous && !old) throw new Error('Student is inaccessible.');
    if (old?.archived) throw new Error('Restore the student before editing.');
    if (
      old &&
      old.owner_id !== c.user &&
      (old.visibility !== v.visibility || old.member_id !== (v.member_id || null))
    )
      throw new Error('Only the student creator changes sharing or household links.');
    if (v.member_id) {
      const m = this.memberChoices().find((m) => m.id === v.member_id);
      if (
        !m ||
        (m.status !== 'active' && old?.member_id !== m.id) ||
        (v.visibility === 'workspace' && m.visibility !== 'workspace')
      )
        throw new Error('Choose an accessible household member with matching sharing.');
    }
    const now = new Date().toISOString();
    this.store.educationStudents.update((rows) => [
      {
        ...v,
        id,
        member_id: v.member_id || null,
        workspace_id: c.w,
        owner_id: old?.owner_id ?? c.user,
        created_at: old?.created_at ?? now,
        updated_at: now,
        revision: old ? old.revision + 1 : 1,
        archived: false,
      },
      ...rows.filter((s) => s.id !== id),
    ]);
    this.finish(request);
  }
  async saveFee(
    request: string,
    id: string,
    student: EducationStudent,
    input: EducationFeeInput,
    previous?: EducationFee,
  ) {
    const c = this.context(request),
      s = this.parent(student, c, this.requests.has(request)),
      v = validateFee(input),
      old = this.store.educationFees().find((f) => f.id === id),
      done = this.remember(request, c, [
        'fee',
        id,
        student.id,
        student.revision,
        previous?.revision ?? null,
        v,
      ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_education_fee', {
        request,
        entry: id,
        parent: student.id,
        expected_revision: previous?.revision ?? null,
        expected_parent_revision: student.revision,
        fee_title: v.title,
        deadline: v.due_on,
        fee_amount: v.amount,
        fee_currency: v.currency,
        fee_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    this.active(s, student);
    if (old && (old.student_id !== student.id || old.workspace_id !== c.w))
      throw new Error('Fee is inaccessible.');
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Fee changed; refresh and try again.');
    if (previous && !old) throw new Error('Fee is inaccessible.');
    if (old?.archived) throw new Error('Restore the fee before editing.');
    if (old && old.currency !== v.currency && this.payments(old).length)
      throw new Error('Currency cannot change after payment history exists.');
    if (old && cents(v.amount) < cents(this.balance(old).paid))
      throw new Error('Fee amount cannot be below recorded payments.');
    if (!old && this.fees(s).length >= 200)
      throw new Error('A student supports up to 200 fees including archives.');
    const now = new Date().toISOString();
    this.store.educationFees.update((rows) => [
      {
        ...v,
        id,
        student_id: s.id,
        workspace_id: c.w,
        owner_id: s.owner_id,
        created_at: old?.created_at ?? now,
        updated_at: now,
        revision: old ? old.revision + 1 : 1,
        archived: false,
      },
      ...rows.filter((f) => f.id !== id),
    ]);
    this.bump(s.id);
    this.finish(request);
  }
  async recordPayment(
    request: string,
    id: string,
    student: EducationStudent,
    fee: EducationFee,
    input: EducationPaymentInput,
  ) {
    const c = this.context(request),
      s = this.parent(student, c, this.requests.has(request)),
      v = validatePayment(input, this.today()),
      done = this.remember(request, c, [
        'payment',
        id,
        student.id,
        student.revision,
        fee.id,
        fee.revision,
        v,
      ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('record_education_payment', {
        request,
        entry: id,
        parent: fee.id,
        expected_fee_revision: fee.revision,
        expected_student_revision: student.revision,
        payment_amount: v.amount,
        payment_date: v.paid_on,
        payment_reference: v.reference,
        payment_notes: v.notes,
        expense: v.expense || null,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    this.active(s, student);
    const f = this.fee(fee, s);
    if (f.archived) throw new Error('Restore the fee before recording payments.');
    if (this.store.educationPayments().some((p) => p.id === id))
      throw new Error('Payment ID is already used.');
    if (cents(v.amount) > cents(this.balance(f).remaining))
      throw new Error('Payment exceeds the outstanding fee.');
    if (this.payments(f).length >= 200)
      throw new Error('A fee supports up to 200 payments including voided history.');
    if (v.expense) {
      const e = this.expenseChoices(f).find((e) => e.id === v.expense);
      if (!e || cents(e.amount) !== cents(v.amount) || e.booked_on !== v.paid_on)
        throw new Error('Choose your own expense with matching amount, currency and payment date.');
    }
    const now = new Date().toISOString();
    this.store.educationPayments.update((rows) => [
      {
        id,
        workspace_id: c.w,
        owner_id: c.user,
        fee_id: f.id,
        amount: v.amount,
        paid_on: v.paid_on,
        reference: v.reference,
        notes: v.notes,
        voided: false,
        revision: 1,
        created_at: now,
        updated_at: now,
      },
      ...rows,
    ]);
    if (v.expense)
      this.store.educationPaymentLinks.update((rows) => [
        {
          id,
          workspace_id: c.w,
          owner_id: c.user,
          transaction_id: v.expense,
          created_at: now,
          updated_at: now,
        },
        ...rows,
      ]);
    this.bump(s.id, f.id);
    this.finish(request);
  }
  async archive(request: string, student: EducationStudent, archived: boolean, fee?: EducationFee) {
    const c = this.context(request),
      s = this.parent(student, c, this.requests.has(request)),
      done = this.remember(request, c, [
        'archive',
        student.id,
        student.revision,
        fee?.id ?? null,
        fee?.revision ?? null,
        archived,
      ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_education_archive', {
        request,
        entry: fee?.id ?? student.id,
        record_kind: fee ? 'fee' : 'student',
        expected_revision: fee?.revision ?? student.revision,
        expected_student_revision: student.revision,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (typeof archived !== 'boolean') throw new Error('Choose archive or restore.');
    if (fee) {
      this.active(s, student);
      const f = this.fee(fee, s);
      this.store.educationFees.update((rows) =>
        rows.map((row) => (row.id === f.id ? { ...row, archived } : row)),
      );
      this.bump(s.id, f.id);
    } else {
      if (s.revision !== student.revision)
        throw new Error('Student changed; refresh and try again.');
      this.store.educationStudents.update((rows) =>
        rows.map((row) => (row.id === s.id ? { ...row, archived } : row)),
      );
      this.bump(s.id);
    }
    this.finish(request);
  }
  async voidPayment(
    request: string,
    student: EducationStudent,
    fee: EducationFee,
    payment: EducationPayment,
    voided: boolean,
  ) {
    const c = this.context(request),
      s = this.parent(student, c, this.requests.has(request)),
      done = this.remember(request, c, [
        'void',
        student.id,
        student.revision,
        fee.id,
        fee.revision,
        payment.id,
        payment.revision,
        voided,
      ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_education_payment_void', {
        request,
        entry: payment.id,
        expected_revision: payment.revision,
        expected_fee_revision: fee.revision,
        expected_student_revision: student.revision,
        is_voided: voided,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    this.active(s, student);
    const f = this.fee(fee, s),
      p = this.payments(f).find((p) => p.id === payment.id);
    if (f.archived) throw new Error('Restore the fee before correcting payments.');
    if (!p || p.revision !== payment.revision)
      throw new Error('Payment changed; refresh and try again.');
    if (typeof voided !== 'boolean') throw new Error('Choose void or restore.');
    if (
      !voided &&
      cents(
        feeBalance(
          f,
          this.payments(f).filter((row) => row.id !== p.id),
        ).paid,
      ) +
        cents(p.amount) >
        cents(f.amount)
    )
      throw new Error('Restored payment exceeds the outstanding fee.');
    this.store.educationPayments.update((rows) =>
      rows.map((row) =>
        row.id === p.id
          ? { ...row, voided, revision: row.revision + 1, updated_at: new Date().toISOString() }
          : row,
      ),
    );
    this.bump(s.id, f.id);
    this.finish(request);
  }
}
