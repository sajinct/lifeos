import { Component, computed, inject, signal, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Attachment, FileBucket } from '../../core/models/domain';
import { FileLibrary } from '../../core/services/file-library';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { Icon } from '../../shared/components/icon';
import { fileSize, validateFile } from '../../shared/utilities/files';
import { localDate } from '../../shared/utilities/finance';
@Component({
  selector: 'app-documents',
  imports: [DatePipe, ReactiveFormsModule, RouterLink, Icon],
  templateUrl: './documents.html',
})
export class DocumentsPage {
  readonly store = inject(LifeStore);
  readonly library = inject(FileLibrary);
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly reminderId = computed(
    () => this.params()?.get('reminder') ?? this.params()?.get('linked'),
  );
  readonly bucket = signal<FileBucket>(
    history.state?.transaction || history.state?.bucket === 'financial-receipts'
      ? 'financial-receipts'
      : 'personal-documents',
  );
  readonly view = signal<'ready' | 'archived' | 'unfinished'>('ready');
  readonly search = signal(String(history.state?.search ?? ''));
  readonly category = signal('all');
  readonly expiryFilter = signal('all');
  readonly showForm = signal(Boolean(history.state?.transaction));
  readonly editing = signal<Attachment | null>(null);
  readonly previous = signal<Attachment | null>(null);
  readonly retry = signal<Attachment | null>(null);
  readonly file = signal<File | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly today = localDate();
  readonly soon = localDate(new Date(Date.now() + 30 * 86400000));
  readonly fileSize = fileSize;
  readonly form = inject(FormBuilder).nonNullable.group({
    category: ['Other', [Validators.required, Validators.maxLength(100)]],
    expires_on: [''],
    project_id: [''],
    transaction_id: [String(history.state?.transaction ?? '')],
  });
  readonly rows = computed(() =>
    this.store.attachments().filter((a) => a.bucket_id === this.bucket()),
  );
  readonly categories = computed(() => [...new Set(this.rows().map((a) => a.category))].sort());
  readonly ownedTransactions = computed(() =>
    [...this.store.transactions()]
      .reverse()
      .filter(
        (t) => t.owner_id === (this.store.auth.demo() ? 'demo-user' : this.store.auth.user()?.id),
      ),
  );
  readonly files = computed(() =>
    this.rows().filter((a) => {
      if (this.reminderId()) return a.id === this.reminderId();
      const status =
        this.view() === 'unfinished'
          ? ['uploading', 'cancelled'].includes(a.status)
          : a.status === this.view();
      const search = (a.name + ' ' + a.category)
        .toLowerCase()
        .includes(this.search().trim().toLowerCase());
      const category = this.category() === 'all' || a.category === this.category();
      const expiry =
        this.expiryFilter() === 'all' ||
        (a.expires_on !== null &&
          (this.expiryFilter() === 'expired'
            ? a.expires_on < this.today
            : a.expires_on >= this.today && a.expires_on <= this.soon));
      return status && search && category && expiry;
    }),
  );
  constructor() {
    effect(() => {
      if (this.reminderId()) {
        const linked = this.store.attachments().find((a) => a.id === this.reminderId());
        this.bucket.set(linked?.bucket_id ?? 'personal-documents');
        this.view.set('ready');
      }
    });
  }
  clearReminder() {
    void this.router.navigate([], {
      queryParams: { reminder: null, linked: null },
      queryParamsHandling: 'merge',
    });
  }
  count(view: 'ready' | 'archived' | 'unfinished') {
    return this.rows().filter((a) =>
      view === 'unfinished' ? ['uploading', 'cancelled'].includes(a.status) : a.status === view,
    ).length;
  }
  selectBucket(bucket: FileBucket) {
    this.bucket.set(bucket);
    this.close();
    this.category.set('all');
    this.error.set('');
  }
  add(previous?: Attachment) {
    this.editing.set(null);
    this.retry.set(null);
    this.previous.set(previous ?? null);
    this.file.set(null);
    this.error.set('');
    this.showForm.set(true);
    this.form.reset({
      category: previous?.category ?? 'Other',
      expires_on: previous?.expires_on ?? '',
      project_id: previous?.project_id ?? '',
      transaction_id: previous?.transaction_id ?? '',
    });
  }
  edit(row: Attachment) {
    this.add();
    this.editing.set(row);
    this.form.setValue({
      category: row.category,
      expires_on: row.expires_on ?? '',
      project_id: row.project_id ?? '',
      transaction_id: row.transaction_id ?? '',
    });
  }
  retryFile(row: Attachment) {
    this.add();
    this.retry.set(row);
  }
  close() {
    this.showForm.set(false);
    this.file.set(null);
    this.editing.set(null);
    this.previous.set(null);
    this.retry.set(null);
  }
  choose(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.error.set('');
    this.file.set(null);
    if (!file) return;
    try {
      validateFile(file, this.bucket());
      this.file.set(file);
    } catch (e) {
      this.error.set(this.store.message(e));
      input.value = '';
    }
  }
  async save() {
    await this.perform(async () => {
      if (this.form.invalid) throw new Error('Enter a category.');
      const edited = this.editing(),
        retry = this.retry();
      if (edited) await this.library.edit(edited, this.form.getRawValue());
      else {
        const file = this.file();
        if (!file) throw new Error('Choose a file first.');
        if (retry) await this.library.retryUpload(retry, file);
        else
          await this.library.upload(
            file,
            this.bucket(),
            this.form.getRawValue(),
            this.previous() ?? undefined,
          );
      }
      this.close();
      this.view.set('ready');
      this.ui.notify(edited ? 'File details saved' : 'File uploaded privately');
    });
  }
  async archive(row: Attachment) {
    await this.perform(async () => {
      await this.library.archive(row, row.status === 'archived');
      this.ui.notify(
        row.status === 'archived' ? 'File restored' : 'File archived; you can restore it',
      );
    });
  }
  async finish(row: Attachment) {
    await this.perform(async () => {
      await this.library.finish(row);
      this.ui.notify('Upload completed');
    });
  }
  async discard(row: Attachment) {
    await this.perform(async () => {
      await this.library.discard(row);
      this.ui.notify('Unfinished upload removed');
    });
  }
  async download(row: Attachment) {
    await this.perform(async () => {
      const blob = await this.library.download(row);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = row.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  hasNewer(row: Attachment) {
    return this.store.attachments().some((a) => a.previous_version_id === row.id);
  }
  transactionTitle(id: string | null) {
    return this.store.transactions().find((t) => t.id === id)?.title ?? 'Linked finance entry';
  }
  private async perform(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
