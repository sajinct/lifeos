import { Component, computed, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RecordJsonImporter, RecordImportRequest } from '../../core/services/record-json-import';
import {
  RecordImportSource,
  RecordImportLink,
  RecordReview,
  RecordImportResult,
  recordJsonMaxBytes,
} from '../../shared/utilities/record-json-import';
@Component({
  selector: 'app-record-json-import',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './record-json-import.html',
  styleUrl: '../finance-import/finance-import.css',
})
export class RecordJsonImportPage {
  readonly calendar = !!inject(ActivatedRoute).snapshot.data['calendarImport'];
  readonly importer = inject(RecordJsonImporter);
  readonly store = this.importer.store;
  readonly form = inject(FormBuilder).nonNullable.group({ text: [''] });
  readonly source = signal<RecordImportSource | null>(null);
  readonly links = signal<RecordImportLink[]>([]);
  readonly mapping = signal<Record<string, string>>({});
  readonly rows = signal<RecordReview[]>([]);
  readonly selected = signal(new Set<number>());
  readonly busy = signal(false);
  readonly pending = signal<RecordImportRequest | null>(null);
  readonly error = signal('');
  readonly result = signal<RecordImportResult | null>(null);
  readonly counts = computed(() =>
    Object.fromEntries(
      ['ready', 'duplicate', 'invalid', 'unmapped'].map((s) => [
        s,
        this.rows().filter((r) => r.state === s).length,
      ]),
    ),
  );
  private version = 0;
  private previewContext: ReturnType<RecordJsonImporter['context']> | null = null;
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
  bound(id: string) {
    return this.links().some((l) => l.record_kind === 'project' && l.source_id === id);
  }
  mappingError(id: string) {
    const t = this.mapping()[id];
    return t && t !== 'none' && t !== 'choose' && !this.importer.projects().some((p) => p.id === t)
      ? 'Saved project destination is unavailable. Import rows without this source or restore project access.'
      : '';
  }
  rebuild() {
    if (!this.source()) return;
    this.rows.set(this.importer.review(this.source()!, this.mapping(), this.links()));
    this.selected.set(
      new Set(
        this.rows()
          .filter((r) => r.state === 'ready')
          .map((r) => r.index),
      ),
    );
  }
  map(id: string, event: Event) {
    if (this.pending() || this.busy() || this.bound(id)) return;
    this.mapping.update((m) => ({ ...m, [id]: (event.target as HTMLSelectElement).value }));
    this.rebuild();
  }
  toggle(index: number) {
    const set = new Set(this.selected());
    if (set.has(index)) set.delete(index);
    else set.add(index);
    this.selected.set(set);
  }
  async file(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file || this.busy() || this.pending()) return;
    const version = ++this.version;
    this.clear();
    this.busy.set(true);
    try {
      if (file.size > recordJsonMaxBytes)
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
    if (this.pending() || this.busy()) return;
    this.clear();
    const version = this.version;
    this.busy.set(true);
    try {
      const p = await this.importer.preview(this.form.controls.text.value, this.calendar);
      if (version !== this.version || !this.importer.current(p.context)) return;
      this.source.set(p.source);
      this.links.set(p.links);
      this.mapping.set(p.mapping);
      this.previewContext = p.context;
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
      this.calendar
        ? {
            events: [
              {
                id: 'example-event',
                title: 'Example event',
                starts_at: '2027-01-01T09:00:00+05:30',
                ends_at: '2027-01-01T10:00:00+05:30',
                location: 'Replace this location',
                color: 'purple',
                project_id: null,
              },
            ],
            projects: [],
          }
        : {
            tasks: [
              {
                id: 'example-task',
                title: 'Example task',
                status: 'todo',
                priority: 'medium',
                due_date: null,
                project_id: null,
              },
            ],
            notes: [
              {
                id: 'example-note',
                title: 'Example note',
                body: 'Replace this content with your own note.',
                project_id: null,
              },
            ],
            projects: [],
          },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = this.calendar
      ? 'lifeos-calendar-template.json'
      : 'lifeos-tasks-notes-template.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
