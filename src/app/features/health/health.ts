import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { HealthLibrary } from '../../core/services/health';
import { UiService } from '../../core/services/ui';
import { HealthAppointment, HealthAction } from '../../core/models/domain';
import { emptyHealth, healthCsv } from '../../shared/utilities/health';
@Component({
  selector: 'app-health',
  imports: [DatePipe, TitleCasePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './health.html',
})
export class HealthPage {
  readonly library = inject(HealthLibrary);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly selectedId = computed(
    () => this.params()?.get('reminder') ?? this.params()?.get('record'),
  );
  readonly search = signal('');
  readonly status = signal('scheduled');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly formOpen = signal(false);
  readonly editing = signal<HealthAppointment | null>(null);
  private request: string = crypto.randomUUID();
  readonly owned = computed(() =>
    this.store
      .healthAppointments()
      .filter(
        (r) =>
          r.owner_id === this.store.profile()?.id && r.workspace_id === this.store.workspace()?.id,
      ),
  );
  readonly rows = computed(() =>
    this.owned()
      .filter((r) =>
        this.selectedId()
          ? r.id === this.selectedId()
          : (this.status() === 'all' ||
              (this.status() === 'archived'
                ? r.archived
                : !r.archived && r.status === this.status())) &&
            [r.title, r.provider, r.location, r.notes]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort(
        (a, b) =>
          a.appointment_on.localeCompare(b.appointment_on) ||
          a.appointment_time.localeCompare(b.appointment_time) ||
          a.id.localeCompare(b.id),
      ),
  );
  readonly counts = computed(() => ({
    scheduled: this.owned().filter((r) => !r.archived && r.status === 'scheduled').length,
    completed: this.owned().filter((r) => !r.archived && r.status === 'completed').length,
    documents: this.store
      .healthDocuments()
      .filter((l) => this.owned().some((r) => r.id === l.appointment_id && !r.archived)).length,
  }));
  readonly form = inject(FormBuilder).nonNullable.group({
    ...emptyHealth(this.library.today()),
    document_ids: new FormControl<string[]>([], { nonNullable: true }),
  });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.formOpen.set(false);
      this.editing.set(null);
      this.error.set('');
    });
  }
  links(r: HealthAppointment) {
    return this.store
      .healthDocuments()
      .filter(
        (l) =>
          l.appointment_id === r.id &&
          l.owner_id === r.owner_id &&
          l.workspace_id === r.workspace_id,
      );
  }
  documentName(id: string) {
    return this.library.documents().find((f) => f.id === id)?.name ?? 'Linked document';
  }
  selectDocument(id: string, checked: boolean) {
    const c = this.form.controls.document_ids;
    c.setValue(checked ? [...new Set([...c.value, id])] : c.value.filter((v) => v !== id));
  }
  async add(previous?: HealthAppointment) {
    await this.run(
      async () => {
        await this.library.loadDocuments();
      },
      () => {
        this.editing.set(previous ?? null);
        this.request = previous?.id ?? crypto.randomUUID();
        this.form.reset(
          previous
            ? { ...previous, document_ids: this.links(previous).map((l) => l.attachment_id) }
            : emptyHealth(this.library.today()),
        );
        this.formOpen.set(true);
      },
    );
  }
  async save() {
    await this.run(
      () => this.library.save(this.request, this.form.getRawValue(), this.editing() ?? undefined),
      () => {
        this.formOpen.set(false);
        this.ui.notify('Appointment saved');
      },
    );
  }
  async act(r: HealthAppointment, action: HealthAction) {
    await this.run(
      () => this.library.act(r, action),
      () => this.ui.notify('Appointment updated'),
    );
  }
  async openDocument(id: string) {
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    await this.run(async () => {
      const row = await this.library.openDocument(id);
      if (row && w === this.store.workspace()?.id && s === this.store.fileSession())
        await this.router.navigate(['/documents'], {
          queryParams: { linked: row.id },
          state: { bucket: row.bucket_id },
        });
    });
  }
  export() {
    if (this.store.loading() || this.store.error()) return;
    const text = healthCsv(this.rows(), this.store.healthDocuments(), this.library.documents());
    if (!text) return;
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-health-appointments-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async run(action: () => Promise<void>, after?: () => void) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (w === this.store.workspace()?.id && s === this.store.fileSession()) after?.();
    } catch (e) {
      if (w === this.store.workspace()?.id && s === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
