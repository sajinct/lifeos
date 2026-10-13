import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { FinanceImporter, FinanceImportRequest } from '../../core/services/finance-import';
import { ImportPreviewRow, importMaxBytes } from '../../shared/utilities/finance-import';
import { csv } from '../../shared/utilities/finance';

@Component({
  selector: 'app-finance-import',
  imports: [RouterLink, ReactiveFormsModule],
  templateUrl: './finance-import.html',
  styleUrl: './finance-import.css',
})
export class FinanceImportPage {
  readonly importer = inject(FinanceImporter);
  readonly store = this.importer.store;
  readonly form = inject(FormBuilder).nonNullable.group({ account: [''], text: [''] });
  readonly rows = signal<ImportPreviewRow[]>([]);
  readonly selected = signal(new Set<number>());
  readonly busy = signal(false);
  readonly error = signal('');
  readonly result = signal<{ imported: number; skipped: number } | null>(null);
  readonly filename = signal('');
  readonly pending = signal<FinanceImportRequest | null>(null);
  readonly accounts = computed(() =>
    this.store
      .accounts()
      .filter(
        (a) =>
          a.owner_id === this.store.profile()?.id &&
          a.workspace_id === this.store.workspace()?.id &&
          !this.store.creditCards().some((c) => c.account_id === a.id && c.archived),
      ),
  );
  readonly ready = computed(() => this.rows().filter((r) => r.status === 'ready'));
  readonly invalid = computed(() => this.rows().filter((r) => r.status === 'invalid').length);
  readonly duplicates = computed(() => this.rows().filter((r) => r.status === 'duplicate').length);
  private version = 0;
  private previewContext: { workspace: string; user: string; session: number } | null = null;
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
    this.rows.set([]);
    this.selected.set(new Set());
    this.pending.set(null);
    this.error.set('');
    this.result.set(null);
    this.previewContext = null;
  }
  async file(event: Event) {
    const input = event.target as HTMLInputElement,
      file = input.files?.[0];
    if (!file || this.busy()) return;
    const version = ++this.version;
    this.clear();
    this.busy.set(true);
    try {
      if (file.size > importMaxBytes)
        throw new Error('Choose a UTF-8 CSV file smaller than 1 MiB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (version !== this.version) return;
      this.form.controls.text.setValue(text, { emitEvent: false });
      this.filename.set(file.name);
    } catch (e) {
      if (version === this.version) this.error.set(this.store.message(e));
    } finally {
      if (version === this.version) this.busy.set(false);
      input.value = '';
    }
  }
  preview() {
    this.clear();
    try {
      const rows = this.importer.preview(
        this.form.controls.text.value,
        this.form.controls.account.value,
      );
      this.rows.set(rows);
      this.selected.set(new Set(rows.filter((r) => r.status === 'ready').map((r) => r.line)));
      this.previewContext = {
        workspace: this.store.workspace()!.id,
        user: this.store.profile()!.id,
        session: this.store.fileSession(),
      };
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  toggle(line: number) {
    const selected = new Set(this.selected());
    if (selected.has(line)) selected.delete(line);
    else selected.add(line);
    this.selected.set(selected);
  }
  async save() {
    if (this.busy()) return;
    if (!this.previewContext || !this.importer.current(this.previewContext)) {
      this.clear();
      this.error.set('Workspace changed; preview again.');
      return;
    }
    const version = this.version;
    this.busy.set(true);
    this.error.set('');
    try {
      let request = this.pending();
      if (!request) {
        request = this.importer.prepare(
          this.form.controls.account.value,
          this.rows()
            .filter((r) => r.status === 'ready' && this.selected().has(r.line))
            .map((r) => r.row!),
        );
        this.pending.set(request);
      }
      const result = await this.importer.save(request);
      if (version !== this.version || !this.importer.current(request)) return;
      this.result.set(result);
      this.pending.set(null);
      this.selected.set(new Set());
      this.rows.set([]);
    } catch (e) {
      if (version === this.version) this.error.set(this.store.message(e));
    } finally {
      if (version === this.version) this.busy.set(false);
    }
  }
  template() {
    const a = this.accounts().find((a) => a.id === this.form.controls.account.value);
    const content = csv([
      {
        date: this.importer.today(),
        title: 'Example purchase',
        kind: 'expense',
        amount: '12.50',
        currency: a?.currency ?? this.store.currency(),
        category: 'Other',
        reference: 'example-001',
      },
    ]);
    const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lifeos-finance-template.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
