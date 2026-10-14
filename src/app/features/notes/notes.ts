import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { Note, NoteInput, Attachment } from '../../core/models/domain';
import { LifeStore } from '../../core/services/life-store';
import { NotesLibrary } from '../../core/services/notes';
import { FileLibrary } from '../../core/services/file-library';
import { UiService } from '../../core/services/ui';
import { matchesNoteSearch, noteTags } from '../../shared/utilities/notes';
import { validateFile, fileSize } from '../../shared/utilities/files';
@Component({
  selector: 'app-notes',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './notes.html',
  styleUrl: './notes.css',
})
export class NotesPage {
  readonly store = inject(LifeStore);
  readonly library = inject(NotesLibrary);
  readonly files = inject(FileLibrary);
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  readonly linked = computed(() => this.params()?.get('linked') ?? '');
  readonly search = signal(String(history.state?.search ?? ''));
  readonly view = signal<'active' | 'archived'>('active');
  readonly kind = signal('all');
  readonly tag = signal('all');
  readonly tags = computed(() =>
    [
      ...new Set(
        this.store
          .notes()
          .filter((n) => !!n.archived === (this.view() === 'archived'))
          .flatMap((n) => n.tags ?? []),
      ),
    ].sort(),
  );
  readonly rows = computed(() =>
    this.store
      .notes()
      .filter((n) =>
        this.linked()
          ? n.id === this.linked()
          : !!n.archived === (this.view() === 'archived') &&
            (this.kind() === 'all' ||
              (this.kind() === 'journal' ? !!n.journal_on : !n.journal_on)) &&
            (this.tag() === 'all' || n.tags?.includes(this.tag())) &&
            matchesNoteSearch(n, this.search()),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)),
  );
  readonly editing = signal(false);
  readonly previous = signal<Note | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly file = signal<File | undefined>(undefined);
  readonly uploadFailed = signal(false);
  readonly selectedDocuments = signal<string[]>([]);
  readonly canLink = computed(
    () => !this.previous() || this.previous()?.owner_id === this.store.profile()?.id,
  );
  readonly readOnly = computed(
    () =>
      !!this.previous() && (!this.store.canEdit(this.previous()!) || !!this.previous()?.archived),
  );
  readonly form = inject(FormBuilder).nonNullable.group({
    title: [''],
    body: [''],
    project: [''],
    tags: [''],
    kind: ['note'],
    journal_on: [''],
    visibility: ['private' as NoteInput['visibility']],
  });
  readonly formValues = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  readonly existingJournal = computed(() =>
    this.formValues()?.kind === 'journal'
      ? this.store
          .notes()
          .find(
            (n) =>
              n.owner_id === this.store.profile()?.id &&
              n.journal_on === this.formValues()?.journal_on &&
              n.id !== this.previous()?.id,
          )
      : undefined,
  );
  readonly selectedFiles = computed(() =>
    this.library.documents().filter((f) => this.selectedDocuments().includes(f.id)),
  );
  readonly pending = signal<
    { run: () => Promise<void>; message: string; entry?: string } | undefined
  >(undefined);
  readonly fileSize = fileSize;
  private request: string = crypto.randomUUID();
  private entry: string = crypto.randomUUID();
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => {
        this.close();
        this.tag.set('all');
        this.search.set('');
        void this.loadDocuments();
      });
    });
  }
  private current(w: string | undefined, session: number) {
    return w === this.store.workspace()?.id && session === this.store.fileSession();
  }
  async loadDocuments() {
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    try {
      await this.library.loadDocuments();
    } catch (e) {
      if (this.current(w, session)) this.error.set(this.store.message(e));
    }
  }
  close() {
    this.form.reset();
    this.editing.set(false);
    this.previous.set(undefined);
    this.pending.set(undefined);
    this.error.set('');
    this.file.set(undefined);
    this.uploadFailed.set(false);
    this.selectedDocuments.set([]);
    this.request = crypto.randomUUID();
    this.entry = crypto.randomUUID();
  }
  create(journal = false) {
    if (this.busy()) return;
    this.close();
    const existing = journal
      ? this.store
          .notes()
          .find(
            (n) => n.owner_id === this.store.profile()?.id && n.journal_on === this.library.today(),
          )
      : undefined;
    if (existing) {
      this.open(existing);
      return;
    }
    this.form.reset({
      title: journal ? `Journal · ${this.library.today()}` : '',
      body: '',
      project: '',
      tags: '',
      kind: journal ? 'journal' : 'note',
      journal_on: journal ? this.library.today() : '',
      visibility: 'private',
    });
    this.editing.set(true);
  }
  open(note: Note) {
    if (this.busy() || this.pending()) return;
    this.close();
    this.entry = note.id;
    this.previous.set(note);
    this.form.reset({
      title: note.title,
      body: note.body,
      project: note.project_id ?? '',
      tags: (note.tags ?? []).join(', '),
      kind: note.journal_on ? 'journal' : 'note',
      journal_on: note.journal_on ?? '',
      visibility: note.visibility,
    });
    this.selectedDocuments.set(
      this.store
        .noteDocuments()
        .filter((l) => l.note_id === note.id)
        .map((l) => l.attachment_id),
    );
    this.editing.set(true);
    void this.loadDocuments();
  }
  changeKind() {
    if (this.form.controls.kind.value === 'journal')
      this.form.patchValue({
        visibility: 'private',
        journal_on: this.form.controls.journal_on.value || this.library.today(),
      });
    else this.form.controls.journal_on.setValue('');
  }
  selectDocument(id: string, selected: boolean) {
    this.selectedDocuments.update((ids) =>
      selected ? [...new Set([...ids, id])] : ids.filter((f) => f !== id),
    );
  }
  choose(event: Event) {
    const input = event.target as HTMLInputElement;
    this.error.set('');
    this.file.set(undefined);
    const file = input.files?.[0];
    if (!file) return;
    try {
      validateFile(file, 'personal-documents');
      this.file.set(file);
    } catch (e) {
      this.error.set(this.store.message(e));
    }
    input.value = '';
  }
  async upload() {
    const file = this.file();
    if (
      !file ||
      this.busy() ||
      !this.canLink() ||
      this.readOnly() ||
      this.pending() ||
      this.uploadFailed()
    )
      return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      const id = await this.files.upload(file, 'personal-documents', {
        category: 'Notes',
        expires_on: '',
        project_id: '',
        transaction_id: '',
      });
      if (this.current(w, session)) {
        this.selectDocument(id, true);
        this.file.set(undefined);
        this.ui.notify('File uploaded. Save the note to keep its link.');
      }
    } catch (e) {
      if (this.current(w, session)) {
        this.uploadFailed.set(true);
        this.error.set(
          this.store.message(e) +
            ' Open Documents → Unfinished uploads to retry, then link the completed file here.',
        );
      }
    } finally {
      this.busy.set(false);
    }
  }
  async save() {
    if (this.busy() || this.readOnly() || this.pending()) return;
    try {
      const v = this.form.getRawValue(),
        input: NoteInput = {
          title: v.title,
          body: v.body,
          project: v.project,
          tags: noteTags(v.tags),
          journal_on: v.kind === 'journal' ? v.journal_on : '',
          visibility: v.kind === 'journal' ? 'private' : v.visibility,
          documents: this.canLink() ? [...this.selectedDocuments()] : null,
        },
        id = this.entry,
        request = this.request,
        previous = this.previous();
      if (v.kind === 'journal' && !v.journal_on) throw new Error('Choose a journal date.');
      this.pending.set({
        run: () => this.library.save(request, id, input, previous),
        message: previous ? 'Note updated' : 'Note created',
        entry: id,
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  async archive(note: Note) {
    if (this.busy() || this.pending()) return;
    const request = crypto.randomUUID();
    this.pending.set({
      run: () => this.library.archive(request, note, !note.archived),
      message: note.archived ? 'Note restored' : 'Note archived',
    });
    await this.retry();
  }
  async retry() {
    const p = this.pending();
    if (!p || this.busy()) return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await p.run();
      if (this.current(w, session)) {
        this.ui.notify(p.message);
        this.close();
        if (p.entry) {
          this.view.set('active');
          this.search.set('');
          this.kind.set('all');
          this.tag.set('all');
        }
        if (this.linked()) void this.clearLink();
      }
    } catch (e) {
      if (this.current(w, session)) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async download(file: Attachment) {
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    try {
      const blob = await this.files.download(file);
      if (!this.current(w, session)) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (this.current(w, session)) this.error.set(this.store.message(e));
    }
  }
  clearLink() {
    return this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { linked: null },
      queryParamsHandling: 'merge',
    });
  }
}
