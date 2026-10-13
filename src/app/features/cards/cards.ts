import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { LifeStore } from '../../core/services/life-store';
import { CardLibrary } from '../../core/services/cards';
import { CardStatement, CreditCard } from '../../core/models/domain';
import { UiService } from '../../core/services/ui';
import { accountBalance, csv } from '../../shared/utilities/finance';
import { billingDates, statementBalance, suggestedCardDue } from '../../shared/utilities/cards';
@Component({
  selector: 'app-cards',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './cards.html',
  styleUrl: './cards.css',
})
export class CardsPage {
  readonly store = inject(LifeStore);
  readonly library = inject(CardLibrary);
  readonly ui = inject(UiService);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly selectedId = signal('');
  readonly search = signal('');
  readonly archived = signal(false);
  readonly rows = computed(() =>
    this.store
      .creditCards()
      .filter(
        (c) =>
          c.owner_id === this.store.profile()?.id &&
          c.archived === this.archived() &&
          (c.title + ' ' + c.last_four).toLowerCase().includes(this.search().toLowerCase()),
      )
      .sort((a, b) => a.title.localeCompare(b.title)),
  );
  readonly selected = computed(() => {
    const id =
      this.selectedId() ||
      this.params()?.get('linked') ||
      this.store.cardStatements().find((s) => s.id === this.params()?.get('reminder'))?.card_id;
    return this.store
      .creditCards()
      .find((c) => c.id === id && c.owner_id === this.store.profile()?.id);
  });
  readonly statements = computed(() =>
    this.store
      .cardStatements()
      .filter((s) => s.card_id === this.selected()?.id)
      .sort(
        (a, b) =>
          b.cycle_end.localeCompare(a.cycle_end) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly current = computed(() => this.statements().find((s) => s.status === 'open'));
  readonly payments = computed(() =>
    this.store
      .cardPayments()
      .filter((p) => this.statements().some((s) => s.id === p.statement_id))
      .sort(
        (a, b) =>
          b.booked_on.localeCompare(a.booked_on) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly banks = computed(() =>
    this.store
      .accounts()
      .filter(
        (a) =>
          a.owner_id === this.store.profile()?.id &&
          a.currency === this.currency(this.selected()) &&
          !this.store.creditCards().some((c) => c.account_id === a.id),
      ),
  );
  readonly ledger = computed(() =>
    this.store
      .transactions()
      .filter((t) => t.account_id === this.selected()?.account_id)
      .sort(
        (a, b) =>
          b.booked_on.localeCompare(a.booked_on) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly busy = signal(false);
  readonly error = signal('');
  readonly cardEditor = signal(false);
  readonly statementEditor = signal(false);
  readonly paymentEditor = signal(false);
  readonly previousCard = signal<CreditCard | undefined>(undefined);
  readonly previousStatement = signal<CardStatement | undefined>(undefined);
  private cardRequest: string = crypto.randomUUID();
  private statementRequest: string = crypto.randomUUID();
  private paymentRequest: string = crypto.randomUUID();
  private readonly fb = inject(FormBuilder);
  readonly cardForm = this.fb.nonNullable.group({
    title: '',
    last_four: '',
    currency: 'INR',
    opening_debt: '0',
    credit_limit: '0',
    closing_day: 25,
    due_day: 15,
    notes: '',
    reminders_enabled: false,
  });
  readonly statementForm = this.fb.nonNullable.group({
    cycle_end: '',
    due_on: '',
    amount: '',
    minimum_due: '0',
    notes: '',
  });
  readonly paymentForm = this.fb.nonNullable.group({ source: '', amount: '', date: '', notes: '' });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.selectedId.set('');
      this.cardEditor.set(false);
      this.statementEditor.set(false);
      this.paymentEditor.set(false);
      this.error.set('');
    });
  }
  currency(c?: CreditCard) {
    return (
      this.store.accounts().find((a) => a.id === c?.account_id)?.currency ?? this.store.currency()
    );
  }
  money(n: number, c?: CreditCard) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: this.currency(c) }).format(
      n,
    );
  }
  balance = statementBalance;
  remaining(s: CardStatement) {
    return statementBalance(s, this.store.cardPayments()).remaining;
  }
  debt(c: CreditCard) {
    const a = this.store.accounts().find((a) => a.id === c.account_id);
    return a ? -accountBalance(a, this.store.transactions()) : 0;
  }
  status(s: CardStatement) {
    return s.status === 'open'
      ? this.remaining(s) === 0
        ? 'Paid'
        : s.due_on < this.library.today()
          ? 'Overdue'
          : 'Payment due'
      : s.status === 'superseded'
        ? 'Replaced by newer statement'
        : 'Cancelled';
  }
  select(c: CreditCard) {
    this.selectedId.set(c.id);
    this.statementEditor.set(false);
    this.paymentEditor.set(false);
    this.error.set('');
  }
  newCard(old?: CreditCard) {
    this.previousCard.set(old);
    this.cardRequest = old?.id ?? crypto.randomUUID();
    this.cardForm.reset(
      old
        ? {
            ...old,
            currency: this.currency(old),
            opening_debt: '0',
            credit_limit: String(old.credit_limit),
          }
        : {
            title: '',
            last_four: '',
            currency: this.store.currency(),
            opening_debt: '0',
            credit_limit: '0',
            closing_day: 25,
            due_day: 15,
            notes: '',
            reminders_enabled: false,
          },
    );
    this.cardEditor.set(true);
  }
  newStatement(old?: CardStatement) {
    const c = this.selected();
    if (!c) return;
    this.previousStatement.set(old);
    this.statementRequest = old?.id ?? crypto.randomUUID();
    this.statementForm.reset(
      old
        ? { ...old, amount: String(old.amount), minimum_due: String(old.minimum_due) }
        : {
            ...billingDates(this.library.today(), c.closing_day, c.due_day),
            amount: '',
            minimum_due: '0',
            notes: '',
          },
    );
    this.statementEditor.set(true);
    this.paymentEditor.set(false);
  }
  suggestDue() {
    const c = this.selected(),
      end = this.statementForm.controls.cycle_end.value;
    if (c && /^\d{4}-\d{2}-\d{2}$/.test(end))
      this.statementForm.controls.due_on.setValue(suggestedCardDue(end, c.due_day));
  }
  newPayment() {
    const s = this.current();
    if (!s) return;
    this.paymentRequest = crypto.randomUUID();
    this.paymentForm.reset({
      source: this.banks()[0]?.id ?? '',
      amount: String(this.remaining(s)),
      date: this.library.today(),
      notes: '',
    });
    this.paymentEditor.set(true);
    this.statementEditor.set(false);
  }
  private async run(action: () => Promise<void>, done: () => void, message: string) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (w === this.store.workspace()?.id && session === this.store.fileSession()) {
        done();
        this.ui.notify(message);
      }
    } catch (e) {
      if (w === this.store.workspace()?.id && session === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  saveCard() {
    const id = this.cardRequest;
    void this.run(
      () => this.library.saveCard(id, this.cardForm.getRawValue(), this.previousCard()),
      () => {
        this.cardEditor.set(false);
        this.selectedId.set(id);
      },
      'Card saved',
    );
  }
  saveStatement() {
    const c = this.selected();
    if (!c) return;
    void this.run(
      () =>
        this.library.saveStatement(
          this.statementRequest,
          c,
          this.statementForm.getRawValue(),
          this.previousStatement(),
        ),
      () => this.statementEditor.set(false),
      'Statement saved',
    );
  }
  pay() {
    const s = this.current();
    if (!s) return;
    void this.run(
      () => this.library.pay(this.paymentRequest, s, this.paymentForm.getRawValue()),
      () => this.paymentEditor.set(false),
      'Card payment recorded',
    );
  }
  voidPayment(id: string) {
    void this.run(
      () => this.library.voidPayment(id),
      () => {},
      'Payment reversed',
    );
  }
  act(
    r: CreditCard | CardStatement,
    kind: 'card' | 'statement',
    action: 'archive' | 'restore' | 'cancel',
  ) {
    void this.run(
      () => this.library.act(r, kind, action),
      () => {},
      'Card record updated',
    );
  }
  export() {
    const c = this.selected();
    if (!c) return;
    const text = csv(
      this.statements().map((s) => ({
        card: c.title,
        last_four: c.last_four,
        currency: this.currency(c),
        cycle_end: s.cycle_end,
        due_on: s.due_on,
        total: s.amount,
        minimum_due: s.minimum_due,
        ...statementBalance(s, this.store.cardPayments()),
        status: this.status(s),
        notes: s.notes,
        payments: this.store
          .cardPayments()
          .filter((p) => p.statement_id === s.id)
          .map((p) => `${p.booked_on}: ${p.amount}${p.voided ? ' (reversed)' : ''} — ${p.notes}`)
          .join('\n'),
      })),
    );
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-card-statements-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
