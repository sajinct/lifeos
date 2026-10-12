import { Component, computed, effect, inject, signal } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AssetLibrary } from '../../core/services/assets';
import { UiService } from '../../core/services/ui';
import { Asset, MaintenancePlan } from '../../core/models/domain';
import { assetsCsv, maintenanceCsv } from '../../shared/utilities/assets';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-assets',
  imports: [CurrencyPipe, DatePipe, ReactiveFormsModule, RouterLink, Icon],
  templateUrl: './assets.html',
})
export class AssetsPage {
  readonly library = inject(AssetLibrary);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly reminderId = computed(() => this.params()?.get('reminder'));
  readonly selectedId = computed(() => {
    const id = this.reminderId() ?? this.params()?.get('asset');
    return this.store.maintenancePlans().find((p) => p.id === id)?.asset_id ?? id;
  });
  readonly selected = computed(() => this.owned().find((a) => a.id === this.selectedId()) ?? null);
  readonly owned = computed(() =>
    this.store
      .assets()
      .filter(
        (a) =>
          a.workspace_id === this.store.workspace()?.id && a.owner_id === this.store.profile()?.id,
      ),
  );
  readonly search = signal('');
  readonly statusFilter = signal('active');
  readonly category = signal('all');
  readonly categories = computed(() => [...new Set(this.owned().map((a) => a.category))].sort());
  readonly rows = computed(() =>
    this.owned()
      .filter((a) =>
        this.selectedId()
          ? a.id === this.selectedId()
          : (this.statusFilter() === 'all' ||
              (this.statusFilter() === 'inactive'
                ? a.status !== 'active'
                : a.status === this.statusFilter())) &&
            (this.category() === 'all' || a.category === this.category()) &&
            [a.name, a.category, a.manufacturer, a.model, a.serial_number, a.location, a.notes]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  readonly plans = computed(() =>
    this.store
      .maintenancePlans()
      .filter((p) => p.asset_id === this.selectedId() && p.owner_id === this.store.profile()?.id)
      .sort((a, b) => (a.next_on ?? '9999').localeCompare(b.next_on ?? '9999')),
  );
  readonly logs = computed(() =>
    this.store
      .maintenanceLogs()
      .filter((l) => l.asset_id === this.selectedId() && l.owner_id === this.store.profile()?.id)
      .sort(
        (a, b) =>
          b.performed_on.localeCompare(a.performed_on) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly counts = computed(() => ({
    active: this.owned().filter((a) => a.status === 'active').length,
    warranty: this.owned().filter(
      (a) =>
        a.status === 'active' &&
        a.warranty_until &&
        a.warranty_until >= this.library.today() &&
        a.warranty_until <= this.soon(),
    ).length,
    due: this.store
      .maintenancePlans()
      .filter(
        (p) =>
          p.status === 'active' &&
          p.next_on &&
          p.next_on <= this.library.today() &&
          this.owned().some((a) => a.id === p.asset_id && a.status === 'active'),
      ).length,
  }));
  readonly busy = signal(false);
  readonly error = signal('');
  readonly assetFormOpen = signal(false);
  readonly planFormOpen = signal(false);
  readonly editing = signal<Asset | null>(null);
  readonly editingPlan = signal<MaintenancePlan | null>(null);
  readonly servicing = signal<MaintenancePlan | null>(null);
  private readonly fb = inject(FormBuilder);
  private assetRequest: string = crypto.randomUUID();
  private planRequest: string = crypto.randomUUID();
  private serviceRequest: string = crypto.randomUUID();
  readonly assetForm = this.fb.nonNullable.group({
    name: '',
    category: 'Appliance',
    manufacturer: '',
    model: '',
    serial_number: '',
    location: '',
    purchased_on: '',
    purchase_price: '',
    currency: 'INR',
    warranty_until: '',
    notes: '',
    document_ids: new FormControl<string[]>([], { nonNullable: true }),
  });
  readonly planForm = this.fb.nonNullable.group({
    asset_id: '',
    title: '',
    next_on: '',
    frequency: 'once' as MaintenancePlan['frequency'],
    notes: '',
  });
  readonly serviceForm = this.fb.nonNullable.group({ performed_on: '', cost: '', notes: '' });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.closeForms();
      this.error.set('');
    });
  }
  soon() {
    return new Date(Date.parse(this.library.today() + 'T00:00:00Z') + 30 * 86400000)
      .toISOString()
      .slice(0, 10);
  }
  closeForms() {
    this.assetFormOpen.set(false);
    this.planFormOpen.set(false);
    this.editing.set(null);
    this.editingPlan.set(null);
    this.servicing.set(null);
  }
  links(a: Asset) {
    return this.store
      .assetDocuments()
      .filter((l) => l.asset_id === a.id && l.owner_id === a.owner_id);
  }
  documentName(id: string) {
    return this.library.documents().find((f) => f.id === id)?.name ?? 'Linked document';
  }
  selectDocument(id: string, checked: boolean) {
    const c = this.assetForm.controls.document_ids;
    c.setValue(checked ? [...new Set([...c.value, id])] : c.value.filter((v) => v !== id));
  }
  async addAsset(previous?: Asset) {
    await this.run(async () => {
      const w = this.store.workspace()?.id,
        s = this.store.fileSession();
      await this.library.loadDocuments();
      if (w !== this.store.workspace()?.id || s !== this.store.fileSession()) return;
      this.closeForms();
      this.editing.set(previous ?? null);
      this.assetRequest = previous?.id ?? crypto.randomUUID();
      this.assetForm.reset(
        previous
          ? {
              ...previous,
              purchased_on: previous.purchased_on ?? '',
              purchase_price:
                previous.purchase_price === null ? '' : String(previous.purchase_price),
              warranty_until: previous.warranty_until ?? '',
              document_ids: this.links(previous).map((l) => l.attachment_id),
            }
          : {
              name: '',
              category: 'Appliance',
              manufacturer: '',
              model: '',
              serial_number: '',
              location: '',
              purchased_on: '',
              purchase_price: '',
              currency: this.store.currency(),
              warranty_until: '',
              notes: '',
              document_ids: [],
            },
      );
      this.assetFormOpen.set(true);
    });
  }
  async saveAsset() {
    await this.run(async () => {
      await this.library.save(
        this.assetRequest,
        this.assetForm.getRawValue(),
        this.editing() ?? undefined,
      );
      this.closeForms();
      this.ui.notify('Asset saved');
    });
  }
  async changeStatus(a: Asset, target: Asset['status']) {
    await this.run(async () => {
      await this.library.setStatus(a, target);
      this.ui.notify(target === 'active' ? 'Asset restored' : `Asset marked ${target}`);
    });
  }
  manage(a: Asset) {
    this.closeForms();
    void this.router.navigate([], {
      queryParams: { asset: a.id, reminder: null },
      queryParamsHandling: 'merge',
    });
  }
  clearSelection() {
    this.closeForms();
    void this.router.navigate([], {
      queryParams: { asset: null, reminder: null },
      queryParamsHandling: 'merge',
    });
  }
  addPlan(previous?: MaintenancePlan) {
    this.closeForms();
    this.editingPlan.set(previous ?? null);
    this.planRequest = previous?.id ?? crypto.randomUUID();
    this.planForm.reset({
      asset_id: previous?.asset_id ?? this.selectedId() ?? '',
      title: previous?.title ?? '',
      next_on: previous?.next_on ?? this.library.today(),
      frequency: previous?.frequency ?? 'once',
      notes: previous?.notes ?? '',
    });
    this.planFormOpen.set(true);
  }
  async savePlan() {
    await this.run(async () => {
      await this.library.savePlan(
        this.planRequest,
        this.planForm.getRawValue(),
        this.editingPlan() ?? undefined,
      );
      this.closeForms();
      this.ui.notify('Maintenance schedule saved');
    });
  }
  async pause(p: MaintenancePlan) {
    await this.run(async () => {
      await this.library.pause(p);
      this.ui.notify(p.status === 'paused' ? 'Maintenance resumed' : 'Maintenance paused');
    });
  }
  service(p: MaintenancePlan) {
    this.closeForms();
    this.servicing.set(p);
    this.serviceRequest = crypto.randomUUID();
    this.serviceForm.reset({ performed_on: this.library.today(), cost: '', notes: '' });
  }
  async recordService() {
    await this.run(async () => {
      await this.library.record(
        this.serviceRequest,
        this.servicing()!,
        this.serviceForm.getRawValue(),
      );
      this.closeForms();
      this.ui.notify('Service recorded; schedule updated');
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
  export(history = false) {
    if (this.store.loading() || this.store.error()) return;
    const text = history
      ? maintenanceCsv(this.plans(), this.logs(), this.owned())
      : assetsCsv(this.rows(), this.store.assetDocuments(), this.library.documents());
    if (!text) return;
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-${history ? 'maintenance' : 'assets'}-${this.library.today()}.csv`;
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
