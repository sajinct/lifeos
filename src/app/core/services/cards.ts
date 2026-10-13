import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  CardInput,
  CardPaymentInput,
  CardStatement,
  CreditCard,
  StatementInput,
  Transaction,
} from '../models/domain';
import {
  cardMoney,
  statementBalance,
  validateCard,
  validateStatement,
} from '../../shared/utilities/cards';
import { accountBalance, cents } from '../../shared/utilities/finance';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
import { validLoanDate } from '../../shared/utilities/loans';
@Injectable({ providedIn: 'root' })
export class CardLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  private context() {
    const w = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !w ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { w, user, session };
  }
  private current(c: ReturnType<CardLibrary['context']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private async reload(c: ReturnType<CardLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(id: string, c: ReturnType<CardLibrary['context']>) {
    const now = new Date().toISOString();
    return {
      id,
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: now,
      updated_at: now,
    };
  }
  private card(id: string, c: ReturnType<CardLibrary['context']>) {
    const r = this.store
      .creditCards()
      .find((r) => r.id === id && r.owner_id === c.user && r.workspace_id === c.w);
    if (!r) throw new Error('Card is inaccessible.');
    return r;
  }
  private statement(id: string, c: ReturnType<CardLibrary['context']>) {
    const r = this.store
      .cardStatements()
      .find((r) => r.id === id && r.owner_id === c.user && r.workspace_id === c.w);
    if (!r) throw new Error('Statement is inaccessible.');
    return r;
  }
  async saveCard(id: string, v: CardInput, old?: CreditCard) {
    const c = this.context(),
      values = validateCard(v);
    if (old) {
      const r = this.card(id, c);
      if (r.revision !== old.revision || r.archived)
        throw new Error('Card changed; restore or refresh.');
    }
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_credit_card', {
        entry: id,
        w: c.w,
        expected_revision: old?.revision ?? null,
        details: {
          ...v,
          title: v.title.trim(),
          credit_limit: values.limit,
          opening_debt: values.debt,
        },
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (!old && this.store.creditCards().some((r) => r.id === id)) {
      this.card(id, c);
      return;
    }
    const accountId = old?.account_id ?? crypto.randomUUID();
    const row: CreditCard = {
      ...this.base(id, c),
      account_id: accountId,
      title: v.title.trim(),
      last_four: v.last_four,
      closing_day: v.closing_day,
      due_day: v.due_day,
      credit_limit: values.limit,
      notes: v.notes,
      reminders_enabled: v.reminders_enabled,
      archived: false,
      revision: (old?.revision ?? 0) + 1,
    };
    if (old)
      this.store.accounts.update((rows) =>
        rows.map((r) => (r.id === accountId ? { ...r, name: row.title } : r)),
      );
    else
      this.store.accounts.update((rows) => [
        ...rows,
        {
          ...this.base(accountId, c),
          name: row.title,
          currency: v.currency,
          opening_balance: -values.debt,
        },
      ]);
    this.store.creditCards.update((rows) => [row, ...rows.filter((r) => r.id !== id)]);
  }
  async saveStatement(id: string, card: CreditCard, v: StatementInput, old?: CardStatement) {
    const c = this.context(),
      parent = this.card(card.id, c),
      value = validateStatement(v, this.today());
    if (parent.archived) throw new Error('Restore card first.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_card_statement', {
        entry: id,
        w: c.w,
        expected_revision: old?.revision ?? null,
        parent: card.id,
        details: { ...v, amount: value.amount, minimum_due: value.minimum },
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const existing = this.store.cardStatements().find((r) => r.id === id);
    if (existing) {
      const r = this.statement(id, c);
      if (r.card_id !== card.id) throw new Error('Statement is inaccessible.');
      if (!old) return;
      if (r.status !== 'open' || r.revision !== old.revision)
        throw new Error('Statement changed; refresh.');
      if (v.cycle_end !== r.cycle_end) throw new Error('Statement cycle cannot change.');
      if (value.amount < statementBalance(r, this.store.cardPayments()).paid)
        throw new Error('Statement total is below recorded payments.');
    } else if (old) throw new Error('Statement is inaccessible.');
    if (
      !existing &&
      this.store
        .cardStatements()
        .some(
          (r) => r.card_id === card.id && r.status !== 'cancelled' && r.cycle_end >= v.cycle_end,
        )
    )
      throw new Error('New statement must follow the latest billing cycle.');
    const row: CardStatement = {
      ...this.base(id, c),
      card_id: card.id,
      ...v,
      amount: value.amount,
      minimum_due: value.minimum,
      status: 'open',
      revision: (old?.revision ?? 0) + 1,
    };
    this.store.cardStatements.update((rows) => [
      row,
      ...rows
        .filter((r) => r.id !== id)
        .map((r) =>
          !old && r.card_id === card.id && r.status === 'open'
            ? { ...r, status: 'superseded' as const, revision: r.revision + 1 }
            : r,
        ),
    ]);
  }
  async pay(id: string, statement: CardStatement, v: CardPaymentInput) {
    const c = this.context(),
      s = this.statement(statement.id, c),
      card = this.card(s.card_id, c),
      amount = cardMoney(v.amount);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('record_card_payment', {
        entry: id,
        w: c.w,
        statement: s.id,
        source: v.source,
        payment_amount: amount,
        payment_date: v.date,
        payment_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.cardPayments().find((r) => r.id === id);
    if (old) {
      if (
        old.workspace_id !== c.w ||
        old.owner_id !== c.user ||
        old.statement_id !== s.id ||
        old.source_account_id !== v.source ||
        old.amount !== amount ||
        old.booked_on !== v.date ||
        old.notes !== v.notes
      )
        throw new Error('Payment request reused.');
      return;
    }
    if (card.archived || s.status !== 'open')
      throw new Error('Only the current statement can be paid.');
    if (
      amount <= 0 ||
      !validLoanDate(v.date) ||
      v.date <= s.cycle_end ||
      v.date > this.today() ||
      v.notes.length > 2000
    )
      throw new Error('Check payment amount, date and notes.');
    const a = this.store
        .accounts()
        .find((r) => r.id === v.source && r.workspace_id === c.w && r.owner_id === c.user),
      destination = this.store.accounts().find((r) => r.id === card.account_id);
    if (
      !a ||
      !destination ||
      a.currency !== destination.currency ||
      this.store.creditCards().some((r) => r.account_id === a.id)
    )
      throw new Error('Choose your own bank account in the card currency.');
    if (cents(amount) > cents(statementBalance(s, this.store.cardPayments()).remaining))
      throw new Error('Payment exceeds statement remaining.');
    if (cents(amount) > Math.max(0, -cents(accountBalance(destination, this.store.transactions()))))
      throw new Error(
        'Payment exceeds recorded card debt; record missing purchases or opening debt first.',
      );
    if (this.store.transactions().some((r) => r.transfer_id === id))
      throw new Error('Transfer request reused.');
    this.store.cardPayments.update((rows) => [
      {
        ...this.base(id, c),
        statement_id: s.id,
        card_id: card.id,
        source_account_id: a.id,
        amount,
        booked_on: v.date,
        notes: v.notes,
        voided: false,
        reversal_id: null,
      },
      ...rows,
    ]);
    this.postPair(id, c, a.id, card.account_id, amount, v.date, card.title + ' · card payment');
    this.store.cardStatements.update((rows) =>
      rows.map((r) => (r.id === s.id ? { ...r, revision: r.revision + 1 } : r)),
    );
  }
  private postPair(
    id: string,
    c: ReturnType<CardLibrary['context']>,
    source: string,
    destination: string,
    amount: number,
    date: string,
    title: string,
  ) {
    const common = {
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      title,
      amount,
      booked_on: date,
      category: 'Card payment',
      transfer_id: id,
      project_id: null,
    };
    const pair: Transaction[] = [
      { ...common, id: crypto.randomUUID(), account_id: source, kind: 'transfer_out' },
      { ...common, id: crypto.randomUUID(), account_id: destination, kind: 'transfer_in' },
    ];
    this.store.transactions.update((rows) => [...pair, ...rows]);
  }
  async voidPayment(id: string) {
    const c = this.context();
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('void_card_payment', { entry: id });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const p = this.store
      .cardPayments()
      .find((r) => r.id === id && r.owner_id === c.user && r.workspace_id === c.w);
    if (!p) throw new Error('Payment is inaccessible.');
    if (p.voided) return;
    const s = this.statement(p.statement_id, c),
      card = this.card(s.card_id, c);
    if (s.status !== 'open' || card.archived)
      throw new Error('Cancel the newer statement before correcting an older payment.');
    const reversal = crypto.randomUUID();
    this.postPair(
      reversal,
      c,
      card.account_id,
      p.source_account_id,
      p.amount,
      this.today(),
      card.title + ' · payment reversal',
    );
    this.store.cardPayments.update((rows) =>
      rows.map((r) => (r.id === id ? { ...r, voided: true, reversal_id: reversal } : r)),
    );
    this.store.cardStatements.update((rows) =>
      rows.map((r) => (r.id === s.id ? { ...r, revision: r.revision + 1 } : r)),
    );
  }
  async act(
    row: CreditCard | CardStatement,
    kind: 'card' | 'statement',
    action: 'archive' | 'restore' | 'cancel',
  ) {
    const c = this.context();
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('act_on_card_record', {
        entry: row.id,
        record_kind: kind,
        expected_revision: row.revision,
        action,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (kind === 'card') {
      const r = this.card(row.id, c),
        archive = action === 'archive';
      if (!['archive', 'restore'].includes(action)) throw new Error('Unknown card action.');
      if (r.archived === archive) return;
      if (r.revision !== row.revision) throw new Error('Card changed; refresh.');
      const account = this.store.accounts().find((a) => a.id === r.account_id);
      if (
        archive &&
        (!account ||
          cents(accountBalance(account, this.store.transactions())) !== 0 ||
          this.store
            .cardStatements()
            .some(
              (s) =>
                s.card_id === r.id &&
                s.status === 'open' &&
                statementBalance(s, this.store.cardPayments()).remaining > 0,
            ))
      )
        throw new Error('Clear card balance and statement before archiving.');
      this.store.creditCards.update((rows) =>
        rows.map((a) =>
          a.id === r.id ? { ...a, archived: archive, revision: a.revision + 1 } : a,
        ),
      );
    } else {
      const r = this.statement(row.id, c),
        card = this.card(r.card_id, c);
      if (action !== 'cancel') throw new Error('Unknown card action.');
      if (r.status === 'cancelled') return;
      if (r.revision !== row.revision || r.status !== 'open' || card.archived)
        throw new Error('Statement changed; refresh.');
      if (this.store.cardPayments().some((p) => p.statement_id === r.id && !p.voided))
        throw new Error('Void current statement payments before cancelling.');
      const previous = this.store
        .cardStatements()
        .filter((s) => s.card_id === card.id && s.status === 'superseded')
        .sort((a, b) => b.cycle_end.localeCompare(a.cycle_end))[0];
      this.store.cardStatements.update((rows) =>
        rows.map((s) =>
          s.id === r.id
            ? { ...s, status: 'cancelled', revision: s.revision + 1 }
            : s.id === previous?.id
              ? { ...s, status: 'open', revision: s.revision + 1 }
              : s,
        ),
      );
    }
  }
}
