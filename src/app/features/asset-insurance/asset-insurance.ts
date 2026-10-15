import { Component, computed, effect, inject, signal, DestroyRef } from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { AssetInsurance, AssetInsuranceInput } from '../../core/models/domain';
import { AssetInsuranceLibrary } from '../../core/services/asset-insurance';
import {
  insuranceCsv,
  insuranceStatus,
  validateInsurance,
} from '../../shared/utilities/asset-insurance';
type Change =
  | { request: string; id: string; input: AssetInsuranceInput; previous?: AssetInsurance }
  | { request: string; previous: AssetInsurance; cancelled: boolean; archived: boolean };
@Component({
  selector: 'app-asset-insurance',
  imports: [CurrencyPipe, DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './asset-insurance.html',
  styleUrl: './asset-insurance.css',
})
export class AssetInsurancePage {
  readonly library = inject(AssetInsuranceLibrary);
  readonly store = this.library.store;
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly assetFilter = signal('all');
  readonly search = signal('');
  readonly view = signal('current');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly opened = signal(false);
  readonly editing = signal<AssetInsurance | null>(null);
  readonly pending = signal<Change | null>(null);
  readonly form = inject(FormBuilder).nonNullable.group({
    asset_id: '',
    title: '',
    provider: '',
    policy_number: '',
    starts_on: '',
    ends_on: '',
    coverage_amount: '',
    premium_amount: '',
    currency: 'INR',
    premium_frequency: 'yearly' as AssetInsurance['premium_frequency'],
    notes: '',
    document_ids: new FormControl<string[]>([], { nonNullable: true }),
  });
  readonly writable = computed(
    () => this.store.writable() && !this.store.loading() && !this.store.error(),
  );
  private readonly now = signal(Date.now());
  readonly today = computed(() => {
    void this.now();
    return this.library.assets.today();
  });
  readonly soon = computed(() =>
    new Date(Date.parse(this.today() + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10),
  );
  readonly linked = computed(() => this.params()?.get('linked'));
  readonly rows = computed(() =>
    this.library
      .rows()
      .filter((p) => (this.linked() ? p.id === this.linked() : this.matches(p)))
      .sort((a, b) => a.ends_on.localeCompare(b.ends_on) || a.id.localeCompare(b.id)),
  );
  private matches(p: AssetInsurance) {
    if (this.assetFilter() !== 'all' && p.asset_id !== this.assetFilter()) return false;
    if (
      ![p.title, p.provider, p.policy_number, p.notes, this.assetName(p.asset_id)]
        .join(' ')
        .toLowerCase()
        .includes(this.search().trim().toLowerCase())
    )
      return false;
    switch (this.view()) {
      case 'all':
        return true;
      case 'archived':
        return p.archived;
      case 'cancelled':
        return !p.archived && p.cancelled;
      default:
        if (p.archived || p.cancelled) return false;
        if (this.view() === 'ending')
          return (
            p.starts_on <= this.today() && p.ends_on >= this.today() && p.ends_on <= this.soon()
          );
        if (this.view() === 'ended') return p.ends_on < this.today();
        if (this.view() === 'upcoming') return p.starts_on > this.today();
        return true;
    }
  }
  readonly counts = computed(() => {
    const rows = this.library.rows().filter((p) => !p.archived && !p.cancelled);
    return {
      current: rows.filter((p) => p.starts_on <= this.today() && p.ends_on >= this.today()).length,
      ending: rows.filter(
        (p) => p.starts_on <= this.today() && p.ends_on >= this.today() && p.ends_on <= this.soon(),
      ).length,
      ended: rows.filter((p) => p.ends_on < this.today()).length,
    };
  });
  readonly documents = this.library.assets.documents;
  private id: string = crypto.randomUUID();
  private generation = 0;
  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    effect(() => {
      const w = this.store.workspace()?.id,
        u = this.store.profile()?.id,
        s = this.store.fileSession();
      void [w, u, s];
      this.generation++;
      this.pending.set(null);
      this.close();
      this.error.set('');
      this.search.set('');
      this.view.set('current');
      this.assetFilter.set(this.params()?.get('asset') ?? 'all');
    });
  }
  hasActiveAssets() {
    return this.library.choices().some((a) => a.status === 'active');
  }
  premiumLabel(value: string) {
    return (
      (
        {
          once: 'one-time',
          monthly: 'per month',
          quarterly: 'per quarter',
          yearly: 'per year',
        } as Record<string, string>
      )[value] ?? value
    );
  }
  private scope() {
    return JSON.stringify([
      this.store.workspace()?.id,
      this.store.profile()?.id,
      this.store.fileSession(),
    ]);
  }
  assetName(id: string) {
    return this.library.choices().find((a) => a.id === id)?.name ?? 'Asset unavailable';
  }
  active(id: string) {
    return this.library.choices().some((a) => a.id === id && a.status === 'active');
  }
  status(p: AssetInsurance) {
    return insuranceStatus(p, this.today());
  }
  docName(id: string) {
    const f = this.library.assets.documents().find((f) => f.id === id);
    return f ? `${f.name} · version ${f.version_number}` : 'Selected document version';
  }
  async add(previous?: AssetInsurance, renew = false) {
    if (this.pending() || !this.writable()) return;
    await this.run(async () => {
      const g = this.generation,
        scope = this.scope();
      await this.library.assets.loadDocuments();
      if (g !== this.generation || scope !== this.scope()) return;
      this.editing.set(renew ? null : (previous ?? null));
      this.id = renew || !previous ? crypto.randomUUID() : previous.id;
      this.form.reset({
        asset_id: previous?.asset_id ?? (this.assetFilter() === 'all' ? '' : this.assetFilter()),
        title: previous?.title ?? '',
        provider: previous?.provider ?? '',
        policy_number: previous?.policy_number ?? '',
        starts_on: renew ? '' : (previous?.starts_on ?? ''),
        ends_on: renew ? '' : (previous?.ends_on ?? ''),
        coverage_amount: previous?.coverage_amount == null ? '' : String(previous.coverage_amount),
        premium_amount: previous?.premium_amount == null ? '' : String(previous.premium_amount),
        currency: previous?.currency ?? this.store.currency(),
        premium_frequency: previous?.premium_frequency ?? 'yearly',
        notes: renew ? '' : (previous?.notes ?? ''),
        document_ids:
          previous && !renew ? this.library.documents(previous).map((l) => l.attachment_id) : [],
      });
      this.opened.set(true);
    });
  }
  close() {
    this.opened.set(false);
    this.editing.set(null);
    this.form.reset();
  }
  selectDocument(id: string, checked: boolean) {
    const c = this.form.controls.document_ids;
    c.setValue(checked ? [...new Set([...c.value, id])] : c.value.filter((v) => v !== id));
  }
  async save() {
    if (this.pending()) return;
    try {
      validateInsurance(this.form.getRawValue());
    } catch (e) {
      this.error.set(this.store.message(e));
      return;
    }
    await this.apply({
      request: crypto.randomUUID(),
      id: this.id,
      input: this.form.getRawValue(),
      previous: this.editing() ?? undefined,
    });
  }
  async state(p: AssetInsurance, cancelled = p.cancelled, archived = p.archived) {
    if (this.pending()) return;
    await this.apply({
      request: crypto.randomUUID(),
      previous: structuredClone(p),
      cancelled,
      archived,
    });
  }
  async retry() {
    const p = this.pending();
    if (p) await this.apply(p);
  }
  discard() {
    if (this.busy()) return;
    this.pending.set(null);
    this.close();
    this.error.set('');
  }
  private async apply(change: Change) {
    await this.run(async () => {
      const g = this.generation;
      this.pending.set(change);
      if ('input' in change)
        await this.library.save(change.request, change.id, change.input, change.previous);
      else
        await this.library.state(
          change.request,
          change.previous,
          change.cancelled,
          change.archived,
        );
      if (g !== this.generation) return;
      this.pending.set(null);
      this.close();
    });
  }
  async refresh() {
    if (this.pending() || this.busy() || !this.store.workspace()) return;
    await this.run(async () => {
      await this.store.switchWorkspace(this.store.workspace()!);
      if (this.store.error()) throw new Error(this.store.error());
    });
  }
  export() {
    if (this.store.loading() || this.store.error()) return;
    const url = URL.createObjectURL(
      new Blob([insuranceCsv(this.rows(), (id) => this.assetName(id))], {
        type: 'text/csv;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'lifeos-asset-insurance.csv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async run(action: () => Promise<void>) {
    if (this.busy()) return;
    const g = this.generation,
      scope = this.scope();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      if (g === this.generation && scope === this.scope()) this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
