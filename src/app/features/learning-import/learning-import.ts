import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LearningImporter, LearningImportRequest } from '../../core/services/learning-import';
import {
  LearningImportSource,
  LearningImportReview,
  LearningImportResult,
  learningImportMaxBytes,
  learningImportTemplate,
} from '../../shared/utilities/learning-import';
@Component({
  selector: 'app-learning-import',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './learning-import.html',
  styleUrl: '../finance-import/finance-import.css',
})
export class LearningImportPage {
  readonly importer = inject(LearningImporter);
  readonly store = this.importer.store;
  readonly form = inject(FormBuilder).nonNullable.group({ text: [''] });
  readonly source = signal<LearningImportSource | null>(null);
  readonly review = signal<LearningImportReview[]>([]);
  readonly selected = signal(new Set<number>());
  readonly busy = signal(false);
  readonly pending = signal<LearningImportRequest | null>(null);
  readonly error = signal('');
  readonly result = signal<LearningImportResult | null>(null);
  readonly ready = computed(
    () =>
      this.source()?.rows.filter((r) => r.row && this.state(r.row.source_id) === 'ready').length ??
      0,
  );
  private version = 0;
  private previewContext: ReturnType<LearningImporter['context']> | null = null;
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
      if (f.size > learningImportMaxBytes)
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
  template() {
    const url = URL.createObjectURL(
        new Blob([learningImportTemplate()], { type: 'application/json' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'lifeos-learning-template.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
