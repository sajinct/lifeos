import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Loan, LoanInput, RepaymentInput, Transaction } from '../models/domain';
import { loanSchedule, loanTerms, outstanding, validLoanDate } from '../../shared/utilities/loans';
import { cents } from '../../shared/utilities/finance';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class LoanLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  private context() {
    const workspace = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !workspace ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { workspace, user, session };
  }
  private current(c: ReturnType<LoanLibrary['context']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private async reload(c: ReturnType<LoanLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private account(id: string, c: ReturnType<LoanLibrary['context']>, currency: string) {
    if (
      id &&
      !this.store
        .accounts()
        .some(
          (a) =>
            a.id === id &&
            a.workspace_id === c.workspace &&
            a.owner_id === c.user &&
            a.currency === currency,
        )
    )
      throw new Error('Choose your own account in the loan currency.');
  }
  async create(id: string, v: LoanInput) {
    const terms = loanTerms(v, this.today()),
      c = this.context();
    this.account(v.account_id, c, v.currency);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('create_loan', {
        entry: id,
        w: c.workspace,
        loan_title: v.title.trim(),
        party: v.counterparty.trim(),
        loan_direction: v.direction,
        loan_currency: v.currency,
        principal_amount: terms.principal,
        rate: Number(v.annual_rate),
        term: v.installments,
        opened: v.opened_on,
        first_due: v.first_due_on,
        loan_notes: v.notes,
        initial_account: v.account_id || null,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (this.store.loans().some((l) => l.id === id)) return;
    const time = new Date().toISOString(),
      base = {
        workspace_id: c.workspace,
        owner_id: c.user,
        visibility: 'private' as const,
        created_at: time,
        updated_at: time,
      };
    const l: Loan = {
      ...base,
      id,
      title: v.title.trim(),
      counterparty: v.counterparty.trim(),
      direction: v.direction,
      currency: v.currency,
      principal: terms.principal,
      annual_rate: Number(v.annual_rate),
      interest_total: terms.interest,
      installments: v.installments,
      installment_amount: terms.installment,
      opened_on: v.opened_on,
      first_due_on: v.first_due_on,
      next_due_on: v.first_due_on,
      principal_paid: 0,
      interest_paid: 0,
      status: 'active',
      notes: v.notes,
    };
    this.store.loans.update((rows) => [l, ...rows]);
    if (v.account_id)
      this.store.transactions.update((rows) => [
        {
          ...base,
          id: crypto.randomUUID(),
          title: l.title + ' · principal',
          account_id: v.account_id,
          amount: l.principal,
          kind: l.direction === 'borrowed' ? 'transfer_in' : 'transfer_out',
          category: 'Loan principal',
          booked_on: l.opened_on,
          transfer_id: crypto.randomUUID(),
          project_id: null,
          loan_id: id,
          loan_repayment_id: null,
        },
        ...rows,
      ]);
  }
  async repay(id: string, row: Loan, v: RepaymentInput) {
    const c = this.context();
    if (row.owner_id !== c.user || row.workspace_id !== c.workspace)
      throw new Error('Loan is inaccessible.');
    if (
      !/^\d{1,12}(\.\d{1,2})?$/.test(v.principal) ||
      !/^\d{1,12}(\.\d{1,2})?$/.test(v.interest) ||
      !validLoanDate(v.date) ||
      v.date < row.opened_on ||
      v.date > this.today() ||
      v.notes.length > 2000
    )
      throw new Error('Check repayment amounts, date and notes.');
    this.account(v.account_id, c, row.currency);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('record_loan_repayment', {
        entry: id,
        loan: row.id,
        principal_amount: Number(v.principal),
        interest_amount: Number(v.interest),
        payment_date: v.date,
        payment_account: v.account_id || null,
        payment_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.loanRepayments().find((p) => p.id === id);
    if (old) {
      if (old.loan_id !== row.id) throw new Error('Repayment request is inaccessible.');
      return;
    }
    const l = this.store.loans().find((l) => l.id === row.id);
    if (!l) throw new Error('Loan is inaccessible.');
    const balance = outstanding(l),
      principal = Number(v.principal),
      interest = Number(v.interest);
    if (
      l.status !== 'active' ||
      principal + interest <= 0 ||
      cents(principal) > cents(balance.principal) ||
      cents(interest) > cents(balance.interest)
    )
      throw new Error('Repayment exceeds the outstanding balance.');
    const time = new Date().toISOString(),
      base = {
        workspace_id: c.workspace,
        owner_id: c.user,
        visibility: 'private' as const,
        created_at: time,
        updated_at: time,
      };
    this.store.loanRepayments.update((rows) => [
      {
        ...base,
        id,
        loan_id: l.id,
        principal_amount: principal,
        interest_amount: interest,
        booked_on: v.date,
        account_id: v.account_id || null,
        notes: v.notes,
      },
      ...rows,
    ]);
    const entries: Transaction[] = [];
    if (v.account_id) {
      const common = {
        ...base,
        account_id: v.account_id,
        booked_on: v.date,
        project_id: null,
        loan_id: l.id,
        loan_repayment_id: id,
      };
      if (principal > 0)
        entries.push({
          ...common,
          id: crypto.randomUUID(),
          title: l.title + ' · principal repayment',
          amount: principal,
          kind: l.direction === 'borrowed' ? 'transfer_out' : 'transfer_in',
          category: 'Loan principal',
          transfer_id: id,
        });
      if (interest > 0)
        entries.push({
          ...common,
          id: crypto.randomUUID(),
          title: l.title + ' · interest',
          amount: interest,
          kind: l.direction === 'borrowed' ? 'expense' : 'income',
          category: 'Loan interest',
          transfer_id: null,
        });
    }
    this.store.transactions.update((rows) => [...entries, ...rows]);
    const updated: Loan = {
      ...l,
      principal_paid: (cents(l.principal_paid) + cents(principal)) / 100,
      interest_paid: (cents(l.interest_paid) + cents(interest)) / 100,
      updated_at: time,
    };
    const schedule = loanSchedule(updated),
      next = schedule.find((p) => p.remaining > 0);
    updated.next_due_on = next?.date ?? null;
    updated.status = next ? 'active' : 'paid';
    this.store.loans.update((rows) => rows.map((r) => (r.id === l.id ? updated : r)));
  }
}
