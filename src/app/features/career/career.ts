import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { CareerLibrary } from '../../core/services/career';
import { UiService } from '../../core/services/ui';
import { CareerRecord } from '../../core/models/domain';
import { emptyCareer, CAREER_STATUSES, careerCsv } from '../../shared/utilities/career';
@Component({
  selector: 'app-career',
  imports: [DatePipe, TitleCasePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './career.html',
})
export class CareerPage {
  readonly library = inject(CareerLibrary);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly selectedId = computed(
    () => this.params()?.get('reminder') ?? this.params()?.get('record'),
  );
  readonly section = signal<CareerRecord['kind']>('employment');
  readonly search = signal('');
  readonly status = signal('open');
  readonly statuses = CAREER_STATUSES;
  readonly owned = computed(() =>
    this.store
      .careerRecords()
      .filter(
        (r) =>
          r.workspace_id === this.store.workspace()?.id && r.owner_id === this.store.profile()?.id,
      ),
  );
  readonly rows = computed(() =>
    this.owned()
      .filter((r) =>
        this.selectedId()
          ? r.id === this.selectedId()
          : r.kind === this.section() &&
            (this.status() === 'all' ||
              (this.status() === 'open' ? this.open(r) : r.status === this.status())) &&
            [r.title, r.organization, r.location, r.skills, r.notes]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.title.localeCompare(b.title)),
  );
  readonly counts = computed(() => ({
    employment: this.owned().filter((r) => r.kind === 'employment' && this.open(r)).length,
    applications: this.owned().filter((r) => r.kind === 'application' && this.open(r)).length,
    certifications: this.owned().filter((r) => r.kind === 'certification' && this.open(r)).length,
  }));
  readonly busy = signal(false);
  readonly error = signal('');
  readonly formOpen = signal(false);
  readonly editing = signal<CareerRecord | null>(null);
  private request: string = crypto.randomUUID();
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    ...emptyCareer('employment', this.library.today()),
    document_ids: new FormControl<string[]>([], { nonNullable: true }),
  });
  constructor() {
    effect(() => {
      const selected = this.owned().find((r) => r.id === this.selectedId());
      if (selected) this.section.set(selected.kind);
    });
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.formOpen.set(false);
      this.editing.set(null);
      this.error.set('');
    });
  }
  open(r: CareerRecord) {
    return ['active', 'applied', 'interview', 'offer'].includes(r.status);
  }
  tab(kind: CareerRecord['kind']) {
    this.section.set(kind);
    this.status.set('open');
    this.formOpen.set(false);
    void this.router.navigate(['/career']);
  }
  links(r: CareerRecord) {
    return this.store
      .careerDocuments()
      .filter((l) => l.record_id === r.id && l.owner_id === r.owner_id);
  }
  documentName(id: string) {
    return this.library.documents().find((f) => f.id === id)?.name ?? 'Linked document';
  }
  selectDocument(id: string, checked: boolean) {
    const c = this.form.controls.document_ids;
    c.setValue(checked ? [...new Set([...c.value, id])] : c.value.filter((v) => v !== id));
  }
  async add(previous?: CareerRecord) {
    await this.run(async () => {
      const w = this.store.workspace()?.id,
        s = this.store.fileSession();
      await this.library.loadDocuments();
      if (w !== this.store.workspace()?.id || s !== this.store.fileSession()) return;
      this.editing.set(previous ?? null);
      this.request = previous?.id ?? crypto.randomUUID();
      this.form.reset(
        previous
          ? {
              ...previous,
              starts_on: previous.starts_on ?? '',
              ends_on: previous.ends_on ?? '',
              applied_on: previous.applied_on ?? '',
              interview_on: previous.interview_on ?? '',
              follow_up_on: previous.follow_up_on ?? '',
              expires_on: previous.expires_on ?? '',
              document_ids: this.links(previous).map((l) => l.attachment_id),
            }
          : emptyCareer(this.section(), this.library.today()),
      );
      this.formOpen.set(true);
    });
  }
  async save() {
    await this.run(async () => {
      await this.library.save(this.request, this.form.getRawValue(), this.editing() ?? undefined);
      this.formOpen.set(false);
      this.ui.notify('Career record saved');
    });
  }
  async act(r: CareerRecord, action: 'archive' | 'restore' | 'follow_up' | 'interview') {
    await this.run(async () => {
      await this.library.act(r, action);
      this.ui.notify(
        action === 'archive'
          ? 'Record archived'
          : action === 'restore'
            ? 'Record restored'
            : 'Date completed and cleared',
      );
    });
  }
  async openDocument(id: string) {
    await this.run(async () => {
      const row = await this.library.openDocument(id);
      if (row)
        await this.router.navigate(['/documents'], {
          queryParams: { linked: row.id },
          state: { bucket: row.bucket_id },
        });
    });
  }
  export() {
    if (this.store.loading() || this.store.error()) return;
    const text = careerCsv(this.rows(), this.store.careerDocuments(), this.library.documents());
    if (!text) return;
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-career-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async run(action: () => Promise<void>) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      if (w === this.store.workspace()?.id && s === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
