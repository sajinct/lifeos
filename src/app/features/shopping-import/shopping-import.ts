import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ShoppingImporter, ShoppingImportRequest } from '../../core/services/shopping-import';
import {
  ShoppingImportSource,
  ShoppingImportRow,
  ShoppingImportReview,
  ShoppingImportResult,
  shoppingImportMaxBytes,
  shoppingImportTemplate,
} from '../../shared/utilities/shopping-import';
@Component({
  selector: 'app-shopping-import',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './shopping-import.html',
  styleUrl: '../finance-import/finance-import.css',
})
export class ShoppingImportPage {
  readonly importer = inject(ShoppingImporter);
  readonly store = this.importer.store;
  readonly form = inject(FormBuilder).nonNullable.group({ text: [''] });
  readonly source = signal<ShoppingImportSource | null>(null);
  readonly review = signal<ShoppingImportReview[]>([]);
  readonly selected = signal(new Set<number>());
  readonly busy = signal(false);
  readonly pending = signal<ShoppingImportRequest | null>(null);
  readonly error = signal('');
  readonly result = signal<ShoppingImportResult | null>(null);
  readonly ready = computed(
    () =>
      this.source()?.rows.filter((r) => r.row && this.state(r.row.source_id) === 'ready').length ??
      0,
  );
  private version = 0;
  private previewContext: ReturnType<ShoppingImporter['context']> | null = null;
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
    this.review.set([]);
    this.selected.set(new Set());
    this.pending.set(null);
    this.error.set('');
    this.result.set(null);
    this.previewContext = null;
  }
  discard() {
    if (this.busy()) return;
    this.version++;
    this.clear();
  }
  state(id: string) {
    return this.review().find((r) => r.source_id === id)?.state ?? 'invalid';
  }
  message(id: string) {
    return this.review().find((r) => r.source_id === id)?.message ?? 'Preview unavailable';
  }
  toggle(index: number) {
    if (this.busy() || this.pending()) return;
    const s = new Set(this.selected());
    if (s.has(index)) s.delete(index);
    else s.add(index);
    this.selected.set(s);
  }
  async file(event: Event) {
    const input = event.target as HTMLInputElement,
      f = input.files?.[0];
    if (!f || this.busy() || this.pending()) return;
    const version = ++this.version;
    this.clear();
    this.busy.set(true);
    try {
      if (f.size > shoppingImportMaxBytes)
        throw new Error('Choose a UTF-8 JSON file no larger than 5 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await f.arrayBuffer());
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
    const v = this.version;
    this.busy.set(true);
    try {
      const p = await this.importer.preview(this.form.controls.text.value);
      if (v !== this.version || !this.importer.current(p.context)) return;
      this.source.set(p.source);
      this.review.set(p.review);
      this.previewContext = p.context;
      this.selected.set(
        new Set(
          p.source.rows
            .filter((r) => r.row && this.state(r.row.source_id) === 'ready')
            .map((r) => r.index),
        ),
      );
    } catch (e) {
      if (v === this.version) this.error.set(this.store.message(e));
    } finally {
      if (v === this.version) this.busy.set(false);
    }
  }
  async save() {
    if (this.busy()) return;
    if (!this.source() || !this.previewContext || !this.importer.current(this.previewContext)) {
      this.clear();
      this.error.set('Workspace changed; preview again.');
      return;
    }
    const v = this.version;
    this.busy.set(true);
    this.error.set('');
    try {
      const request =
        this.pending() ?? this.importer.prepare(this.source()!, this.review(), this.selected());
      this.pending.set(request);
      const result = await this.importer.save(request);
      if (v !== this.version || !this.importer.current(request)) return;
      this.clear();
      this.result.set(result);
    } catch (e) {
      if (v === this.version) this.error.set(this.store.message(e));
    } finally {
      if (v === this.version) this.busy.set(false);
    }
  }
  checked(row: ShoppingImportRow) {
    return row.items.filter((i) => i.checked).length;
  }
  archived(row: ShoppingImportRow) {
    return row.items.filter((i) => i.archived).length;
  }
  template() {
    const url = URL.createObjectURL(
        new Blob([shoppingImportTemplate()], { type: 'application/json' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'lifeos-shopping-template.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
