import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FinanceJsonImporter, FinanceJsonRequest } from '../../core/services/finance-json-import';
import {
  FinanceJsonLink,
  FinanceJsonResult,
  FinanceJsonSource,
  JsonReviewRow,
  JsonSourceAccount,
  jsonImportMaxBytes,
} from '../../shared/utilities/finance-json-import';
@Component({
  selector: 'app-finance-json-import',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './finance-json-import.html',
  styleUrl: '../finance-import/finance-import.css',
})
export class FinanceJsonImportPage {
  readonly importer = inject(FinanceJsonImporter);
  readonly store = this.importer.store;
  readonly form = inject(FormBuilder).nonNullable.group({ text: [''] });
  readonly source = signal<FinanceJsonSource | null>(null);
  readonly links = signal<FinanceJsonLink[]>([]);
  readonly mapping = signal<Record<string, string>>({});
  readonly rows = signal<JsonReviewRow[]>([]);
  readonly selected = signal(new Set<number>());
  readonly busy = signal(false);
  readonly error = signal('');
  readonly result = signal<FinanceJsonResult | null>(null);
  readonly pending = signal<FinanceJsonRequest | null>(null);
  readonly counts = computed(() =>
    Object.fromEntries(
      ['ready', 'duplicate', 'invalid', 'unsupported', 'unmapped'].map((s) => [
        s,
        this.rows().filter((r) => r.status === s).length,
      ]),
    ),
  );
  readonly mapped = computed(
    () =>
      this.source()?.accounts.filter(
        (a) => !a.error && this.mapping()[a.source_id] && this.mapping()[a.source_id] !== 'skip',
      ).length ?? 0,
  );
  readonly mappingErrors = computed(
    () => this.source()?.accounts.some((a) => !!this.mappingError(a)) ?? false,
  );
  private version = 0;
  private previewContext: ReturnType<FinanceJsonImporter['context']> | null = null;
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.profile();
      this.store.fileSession();
      this.version++;
      this.busy.set(false);
      this.clear();
      this.form.reset({}, { emitEvent: false });
    });
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      if (!this.busy()) this.clear();
    });
  }
  clear() {
    this.source.set(null);
    this.links.set([]);
    this.mapping.set({});
    this.rows.set([]);
    this.selected.set(new Set());
    this.pending.set(null);
    this.error.set('');
    this.result.set(null);
    this.previewContext = null;
  }
  options(a: JsonSourceAccount) {
    return this.store
      .accounts()
      .filter(
        (t) =>
          t.workspace_id === this.store.workspace()?.id &&
          t.owner_id === this.store.profile()?.id &&
          t.currency === a.currency &&
          !this.store.creditCards().some((c) => c.account_id === t.id && c.archived) &&
          (!a.card_source || this.store.creditCards().some((c) => c.account_id === t.id)),
      );
  }
  bound(a: JsonSourceAccount) {
    return this.links().some((l) => l.source_kind === 'account' && l.source_id === a.source_id);
  }
  mappingError(a: JsonSourceAccount) {
    const target = this.mapping()[a.source_id];
    if (!target || target === 'skip') return '';
    if (a.error) return a.error;
    if (target === 'new') return a.card_source ? 'Choose an existing credit card.' : '';
    return this.options(a).some((t) => t.id === target)
      ? ''
      : 'Saved destination is unavailable; restore access or the archived card.';
  }
  rebuild() {
    if (!this.source()) return;
    this.rows.set(this.importer.review(this.source()!, this.mapping(), this.links()));
    this.selected.set(
      new Set(
        this.rows()
          .filter((r) => r.status === 'ready')
          .map((r) => r.index),
      ),
    );
  }
  map(a: JsonSourceAccount, event: Event) {
    if (this.busy() || this.pending() || this.bound(a)) return;
    this.mapping.update((m) => ({
      ...m,
      [a.source_id]: (event.target as HTMLSelectElement).value,
    }));
    this.rebuild();
  }
  toggle(index: number) {
    const selected = new Set(this.selected());
    if (selected.has(index)) selected.delete(index);
    else selected.add(index);
    this.selected.set(selected);
  }
  async file(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file || this.busy() || this.pending()) return;
    const version = ++this.version;
    this.clear();
    this.busy.set(true);
    try {
      if (file.size > jsonImportMaxBytes)
        throw new Error('Choose a UTF-8 JSON file no larger than 5 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (version === this.version) this.form.controls.text.setValue(text, { emitEvent: false });
    } catch (e) {
      if (version === this.version) this.error.set(this.store.message(e));
    } finally {
      if (version === this.version) this.busy.set(false);
      input.value = '';
    }
  }
  async preview() {
    if (this.busy() || this.pending()) return;
    this.clear();
    const version = this.version;
    this.busy.set(true);
    try {
      const preview = await this.importer.preview(this.form.controls.text.value);
      if (version !== this.version || !this.importer.current(preview.context)) return;
      this.source.set(preview.source);
      this.links.set(preview.links);
      this.mapping.set(preview.mapping);
      this.previewContext = preview.context;
      this.rebuild();
    } catch (e) {
      if (version === this.version) this.error.set(this.store.message(e));
    } finally {
      if (version === this.version) this.busy.set(false);
    }
  }
  async save() {
    if (this.busy()) return;
    if (!this.source() || !this.previewContext || !this.importer.current(this.previewContext)) {
      this.clear();
      this.error.set('Workspace changed; preview again.');
      return;
    }
    const version = this.version;
    this.busy.set(true);
    this.error.set('');
    try {
      const request =
        this.pending() ??
        this.importer.prepare(this.source()!, this.mapping(), this.links(), this.selected());
      this.pending.set(request);
      const result = await this.importer.save(request);
      if (version !== this.version || !this.importer.current(request)) return;
      this.clear();
      this.result.set(result);
    } catch (e) {
      if (version === this.version) this.error.set(this.store.message(e));
    } finally {
      if (version === this.version) this.busy.set(false);
    }
  }
  template() {
    const text = JSON.stringify(
      {
        accounts: [
          {
            id: 'example-account',
            name: 'Example account',
            currency: this.store.currency(),
            opening_balance: '0.00',
          },
        ],
        transactions: [
          {
            id: 'example-transaction',
            account_id: 'example-account',
            title: 'Example purchase',
            kind: 'expense',
            amount: '12.50',
            category: 'Other',
            booked_on: this.importer.today(),
            import_reference: '',
          },
        ],
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'lifeos-finance-template.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
