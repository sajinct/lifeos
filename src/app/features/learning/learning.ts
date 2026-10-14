import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { LearningItem, LearningUnit, Attachment } from '../../core/models/domain';
import { LifeStore } from '../../core/services/life-store';
import { LearningLibrary } from '../../core/services/learning';
import { FileLibrary } from '../../core/services/file-library';
import { UiService } from '../../core/services/ui';
import { learningCsv, validateLearning } from '../../shared/utilities/learning';
import { fileSize } from '../../shared/utilities/files';

@Component({
  selector: 'app-learning',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './learning.html',
  styleUrl: './learning.css',
})
export class LearningPage {
  readonly store = inject(LifeStore);
  readonly library = inject(LearningLibrary);
  private readonly files = inject(FileLibrary);
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  readonly linked = computed(() => this.params()?.get('linked') ?? '');
  readonly search = signal('');
  readonly view = signal('active');
  readonly kind = signal('all');
  readonly status = signal('all');
  readonly rows = computed(() =>
    this.library
      .items()
      .filter((i) =>
        this.linked()
          ? i.id === this.linked()
          : i.archived === (this.view() === 'archived') &&
            (this.kind() === 'all' || i.kind === this.kind()) &&
            (this.status() === 'all' || i.status === this.status()) &&
            this.search()
              .trim()
              .toLowerCase()
              .split(/\s+/)
              .every((q) =>
                [i.title, i.provider, i.goal, i.notes].join(' ').toLowerCase().includes(q),
              ),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)),
  );
  readonly counts = computed(() => {
    const all = this.library.items().filter((i) => !i.archived);
    return {
      active: all.filter((i) => i.status === 'active').length,
      paused: all.filter((i) => i.status === 'paused').length,
      completed: all.filter((i) => i.status === 'completed').length,
      overdue: all.filter(
        (i) => i.status !== 'completed' && i.due_on && i.due_on < this.library.notes.today(),
      ).length,
    };
  });
  readonly selectedId = signal('');
  readonly item = computed(() =>
    this.library.items().find((i) => i.id === (this.selectedId() || this.linked())),
  );
  readonly editing = signal(false);
  readonly previous = signal<LearningItem | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly selectedNotes = signal<string[]>([]);
  readonly selectedDocuments = signal<string[]>([]);
  readonly selectedCertificates = signal<string[]>([]);
  readonly form = inject(FormBuilder).nonNullable.group({
    kind: ['course' as LearningItem['kind']],
    title: [''],
    provider: [''],
    url: [''],
    goal: [''],
    due_on: [''],
    notes: [''],
  });
  readonly unitForm = inject(FormBuilder).nonNullable.group({ title: [''], notes: [''] });
  readonly editingUnit = signal<LearningUnit | undefined>(undefined);
  readonly unitEditor = signal(false);
  readonly archivedUnits = signal(false);
  readonly pending = signal<
    | { run: () => Promise<void>; message: string; entry?: string; editor?: 'item' | 'unit' }
    | undefined
  >(undefined);
  readonly fileSize = fileSize;
  readonly canChange = computed(() => this.store.writable() && !this.busy() && !this.pending());
  readonly canProgress = computed(
    () =>
      this.canChange() &&
      !!this.item() &&
      !this.item()!.archived &&
      this.item()!.status !== 'paused',
  );
  private request = crypto.randomUUID();
  private entry: string = crypto.randomUUID();
  private unitRequest = crypto.randomUUID();
  private unitEntry: string = crypto.randomUUID();
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => {
        this.resetDraft();
        this.selectedId.set('');
        this.search.set('');
        this.view.set('active');
        this.status.set('all');
        this.kind.set('all');
        void this.loadDocuments();
      });
    });
  }
  private current(w: string | undefined, session: number) {
    return w === this.store.workspace()?.id && session === this.store.fileSession();
  }
  async loadDocuments() {
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    try {
      await this.library.notes.loadDocuments();
    } catch (e) {
      if (this.current(w, s)) this.error.set(this.store.message(e));
    }
  }
  resetDraft() {
    this.form.reset();
    this.unitForm.reset();
    this.editing.set(false);
    this.previous.set(undefined);
    this.unitEditor.set(false);
    this.editingUnit.set(undefined);
    this.pending.set(undefined);
    this.error.set('');
    this.selectedNotes.set([]);
    this.selectedDocuments.set([]);
    this.selectedCertificates.set([]);
    this.request = crypto.randomUUID();
    this.entry = crypto.randomUUID();
    this.unitRequest = crypto.randomUUID();
    this.unitEntry = crypto.randomUUID();
  }
  create() {
    if (!this.canChange()) return;
    this.resetDraft();
    this.editing.set(true);
  }
  edit(item: LearningItem) {
    if (!this.canChange() || item.archived) return;
    this.resetDraft();
    this.entry = item.id;
    this.previous.set(item);
    this.selectedId.set(item.id);
    this.form.reset({
      kind: item.kind,
      title: item.title,
      provider: item.provider,
      url: item.url,
      goal: item.goal,
      due_on: item.due_on ?? '',
      notes: item.notes,
    });
    this.selectedNotes.set(
      this.store
        .learningNotes()
        .filter((l) => l.item_id === item.id)
        .map((l) => l.note_id),
    );
    const files = this.store.learningDocuments().filter((l) => l.item_id === item.id);
    this.selectedDocuments.set(
      files.filter((l) => l.purpose === 'reference').map((l) => l.attachment_id),
    );
    this.selectedCertificates.set(
      files.filter((l) => l.purpose === 'certificate').map((l) => l.attachment_id),
    );
    this.editing.set(true);
    void this.loadDocuments();
  }
  open(item: LearningItem) {
    if (this.busy() || this.pending()) return;
    this.resetDraft();
    this.selectedId.set(item.id);
    this.archivedUnits.set(false);
    void this.loadDocuments();
  }
  toggleNote(id: string, selected: boolean) {
    this.selectedNotes.update((ids) =>
      selected ? [...new Set([...ids, id])] : ids.filter((i) => i !== id),
    );
  }
  toggleFile(id: string, purpose: 'reference' | 'certificate', selected: boolean) {
    const target = purpose === 'reference' ? this.selectedDocuments : this.selectedCertificates,
      other = purpose === 'reference' ? this.selectedCertificates : this.selectedDocuments;
    target.update((ids) => (selected ? [...new Set([...ids, id])] : ids.filter((i) => i !== id)));
    if (selected) other.update((ids) => ids.filter((i) => i !== id));
  }
  async save() {
    if (!this.canChange()) return;
    try {
      const input = validateLearning({
          ...this.form.getRawValue(),
          note_ids: [...this.selectedNotes()],
          document_ids: [...this.selectedDocuments()],
          certificate_ids: [...this.selectedCertificates()],
        }),
        request = this.request,
        id = this.entry,
        old = this.previous();
      this.pending.set({
        run: () => this.library.save(request, id, input, old),
        message: old ? 'Learning item updated' : 'Learning item created',
        entry: id,
        editor: 'item',
      });
      await this.retry();
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  startUnit(unit?: LearningUnit) {
    if (!this.canProgress()) return;
    this.unitRequest = crypto.randomUUID();
    this.unitEntry = unit?.id ?? crypto.randomUUID();
    this.editingUnit.set(unit);
    this.unitForm.reset({ title: unit?.title ?? '', notes: unit?.notes ?? '' });
    this.unitEditor.set(true);
  }
  closeUnit() {
    this.unitForm.reset();
    this.unitEditor.set(false);
    this.editingUnit.set(undefined);
  }
  async saveUnit() {
    if (!this.canProgress()) return;
    const item = this.item()!,
      v = this.unitForm.getRawValue(),
      old = this.editingUnit(),
      request = this.unitRequest,
      id = this.unitEntry;
    if (!v.title.trim() || v.title.trim().length > 200 || v.notes.length > 2000) {
      this.error.set('Enter valid lesson details.');
      return;
    }
    this.pending.set({
      run: () =>
        this.library.unit(
          request,
          id,
          item,
          v.title,
          v.notes,
          old?.done ?? false,
          old?.archived ?? false,
          old,
        ),
      message: old ? 'Lesson updated' : 'Lesson added',
      editor: 'unit',
    });
    await this.retry();
  }
  async changeUnit(unit: LearningUnit, archive = false) {
    if (!this.canProgress()) return;
    const item = this.item()!,
      request = crypto.randomUUID();
    this.pending.set({
      run: () =>
        this.library.unit(
          request,
          unit.id,
          item,
          unit.title,
          unit.notes,
          archive ? unit.done : !unit.done,
          archive ? !unit.archived : unit.archived,
          unit,
        ),
      message: archive
        ? unit.archived
          ? 'Lesson restored'
          : 'Lesson archived'
        : unit.done
          ? 'Lesson reopened'
          : 'Lesson completed',
      editor: 'unit',
    });
    await this.retry();
  }
  async changeState(item: LearningItem, status: LearningItem['status'], archived = item.archived) {
    if (!this.canChange()) return;
    const request = crypto.randomUUID();
    this.pending.set({
      run: () => this.library.state(request, item, status, archived),
      message:
        archived !== item.archived
          ? archived
            ? 'Learning item archived'
            : 'Learning item restored'
          : 'Learning status updated',
    });
    await this.retry();
  }
  async retry() {
    const p = this.pending();
    if (!p || this.busy()) return;
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await p.run();
      if (this.current(w, s)) {
        this.ui.notify(p.message);
        if (p.editor === 'item') {
          this.resetDraft();
          this.selectedId.set(p.entry!);
          this.view.set('active');
          this.search.set('');
          this.kind.set('all');
          this.status.set('all');
          if (this.linked()) void this.clearLink();
        } else {
          if (p.editor === 'unit') this.closeUnit();
          this.pending.set(undefined);
        }
      }
    } catch (e) {
      if (this.current(w, s)) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async download(file: Attachment) {
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    try {
      const blob = await this.files.download(file);
      if (!this.current(w, s)) return;
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (this.current(w, s)) this.error.set(this.store.message(e));
    }
  }
  exportCsv() {
    const url = URL.createObjectURL(
        new Blob([learningCsv(this.rows(), this.store.learningUnits())], {
          type: 'text/csv;charset=utf-8',
        }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'lifeos-learning.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  safeUrl(value: string) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        ? url.href
        : '';
    } catch {
      return '';
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
