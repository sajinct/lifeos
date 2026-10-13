import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { LifeStore } from '../../core/services/life-store';
import { WealthLibrary } from '../../core/services/wealth';
import { UiService } from '../../core/services/ui';
import {
  Asset,
  InvestmentEntry,
  InvestmentHolding,
  WealthAssetValue,
} from '../../core/models/domain';
import { investmentPerformance, WealthSource, wealthTotals } from '../../shared/utilities/wealth';
import { csv } from '../../shared/utilities/finance';
@Component({
  selector: 'app-wealth',
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './wealth.html',
  styleUrl: './wealth.css',
})
export class WealthPage {
  readonly store = inject(LifeStore);
  readonly library = inject(WealthLibrary);
  readonly ui = inject(UiService);
  readonly tab = signal('overview');
  readonly search = signal('');
  readonly archived = signal(false);
  readonly selectedId = signal('');
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly selected = computed(() =>
    this.store
      .investmentHoldings()
      .find(
        (h) =>
          h.id === (this.selectedId() || this.params()?.get('linked')) &&
          h.owner_id === this.store.profile()?.id,
      ),
  );
  readonly holdings = computed(() =>
    this.store
      .investmentHoldings()
      .filter(
        (h) =>
          h.owner_id === this.store.profile()?.id &&
          h.archived === this.archived() &&
          (h.title + ' ' + h.kind).toLowerCase().includes(this.search().toLowerCase()),
      )
      .sort((a, b) => a.title.localeCompare(b.title)),
  );
  readonly entries = computed(() =>
    this.store
      .investmentEntries()
      .filter((e) => e.holding_id === this.selected()?.id)
      .sort((a, b) => b.sequence - a.sequence),
  );
  readonly latestEntry = computed(() => this.entries().find((e) => !e.voided));
  readonly banks = computed(() =>
    this.store
      .accounts()
      .filter(
        (a) =>
          a.owner_id === this.store.profile()?.id &&
          a.currency === this.selected()?.currency &&
          !this.store.creditCards().some((c) => c.account_id === a.id),
      ),
  );
  readonly sources = computed(() => this.library.sources());
  readonly totalResult = computed(() => {
    try {
      return { totals: wealthTotals(this.sources()), error: '' };
    } catch (e) {
      return { totals: [], error: this.store.message(e) };
    }
  });
  readonly snapshots = computed(() =>
    this.store
      .wealthSnapshots()
      .filter((s) => s.owner_id === this.store.profile()?.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)),
  );
  readonly activeAssets = computed(() =>
    this.store
      .assets()
      .filter((a) => a.owner_id === this.store.profile()?.id && a.status === 'active'),
  );
  readonly performance = computed(() =>
    this.selected()
      ? investmentPerformance(this.selected()!, this.store.investmentEntries())
      : null,
  );
  readonly busy = signal(false);
  readonly error = signal('');
  readonly holdingEditor = signal(false);
  readonly entryEditor = signal(false);
  readonly assetEditor = signal(false);
  readonly snapshotEditor = signal(false);
  readonly previousHolding = signal<InvestmentHolding | undefined>(undefined);
  readonly previousAssetValue = signal<WealthAssetValue | undefined>(undefined);
  readonly selectedAsset = signal<Asset | undefined>(undefined);
  private holdingRequest: string = crypto.randomUUID();
  private entryRequest: string = crypto.randomUUID();
  private assetRequest: string = crypto.randomUUID();
  private snapshotRequest: string = crypto.randomUUID();
  private readonly inclusionRequests = new Map<string, string>();
  private readonly fb = inject(FormBuilder);
  readonly holdingForm = this.fb.nonNullable.group({
    title: '',
    kind: 'fund' as InvestmentHolding['kind'],
    currency: 'INR',
    opened_on: '',
    opening_cost: '0',
    opening_value: '0',
    notes: '',
  });
  readonly entryForm = this.fb.nonNullable.group({
    kind: 'contribution' as InvestmentEntry['kind'],
    amount: '',
    basis_removed: '0',
    occurred_on: '',
    account_id: '',
    notes: '',
  });
  readonly assetForm = this.fb.nonNullable.group({ amount: '', date: '', notes: '' });
  readonly snapshotForm = this.fb.nonNullable.group({ label: '' });
  readonly entryValues = toSignal(this.entryForm.valueChanges, {
    initialValue: this.entryForm.getRawValue(),
  });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.selectedId.set('');
      this.holdingEditor.set(false);
      this.entryEditor.set(false);
      this.assetEditor.set(false);
      this.snapshotEditor.set(false);
      this.error.set('');
      this.inclusionRequests.clear();
      if (this.params()?.get('linked')) this.tab.set('holdings');
    });
  }
  money(n: number, currency: string) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(n);
  }
  pick(h: InvestmentHolding) {
    this.selectedId.set(h.id);
    this.entryEditor.set(false);
    this.error.set('');
    this.tab.set('holdings');
  }
  newHolding(old?: InvestmentHolding) {
    this.previousHolding.set(old);
    this.holdingRequest = old?.id ?? crypto.randomUUID();
    this.holdingForm.reset(
      old
        ? {
            ...old,
            opening_cost: String(old.opening_cost),
            opening_value: String(old.opening_value),
          }
        : {
            title: '',
            kind: 'fund',
            currency: this.store.currency(),
            opened_on: this.library.today(),
            opening_cost: '0',
            opening_value: '0',
            notes: '',
          },
    );
    this.holdingEditor.set(true);
    this.tab.set('holdings');
  }
  newEntry(kind: InvestmentEntry['kind']) {
    const h = this.selected();
    if (!h) return;
    this.entryRequest = crypto.randomUUID();
    this.entryForm.reset({
      kind,
      amount: kind === 'valuation' ? String(h.current_value) : '',
      basis_removed: '0',
      occurred_on: this.library.today(),
      account_id: kind === 'contribution' ? (this.banks()[0]?.id ?? '') : '',
      notes: '',
    });
    this.entryEditor.set(true);
  }
  newAssetValue(a: Asset) {
    const old = this.store.wealthAssetValues().find((v) => v.asset_id === a.id);
    this.selectedAsset.set(a);
    this.previousAssetValue.set(old);
    this.assetRequest = old?.id ?? crypto.randomUUID();
    this.assetForm.reset({
      amount: String(old?.amount ?? a.purchase_price ?? 0),
      date: this.library.today(),
      notes: old?.notes ?? '',
    });
    this.assetEditor.set(true);
  }
  newSnapshot() {
    this.snapshotRequest = crypto.randomUUID();
    this.snapshotForm.reset({ label: 'Wealth review · ' + this.library.today() });
    this.snapshotEditor.set(true);
  }
  private async run(action: () => Promise<void>, done: () => void, message: string) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (w === this.store.workspace()?.id && session === this.store.fileSession()) {
        done();
        this.ui.notify(message);
      }
    } catch (e) {
      if (w === this.store.workspace()?.id && session === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  saveHolding() {
    const id = this.holdingRequest;
    void this.run(
      () => this.library.saveHolding(id, this.holdingForm.getRawValue(), this.previousHolding()),
      () => {
        this.holdingEditor.set(false);
        this.selectedId.set(id);
      },
      'Holding saved',
    );
  }
  append() {
    const h = this.selected();
    if (!h) return;
    void this.run(
      () => this.library.append(this.entryRequest, h, this.entryForm.getRawValue()),
      () => this.entryEditor.set(false),
      'Investment entry recorded',
    );
  }
  undo(e: InvestmentEntry) {
    const h = this.selected();
    if (h)
      void this.run(
        () => this.library.undo(e, h),
        () => {},
        'Investment entry undone',
      );
  }
  archive(h: InvestmentHolding) {
    void this.run(
      () => this.library.archive(h, !h.archived),
      () => {},
      h.archived ? 'Holding restored' : 'Holding archived',
    );
  }
  async toggle(s: WealthSource, event: Event) {
    const checked = (event.target as HTMLInputElement).checked,
      key = s.kind + ':' + s.id;
    if (!this.inclusionRequests.has(key)) this.inclusionRequests.set(key, crypto.randomUUID());
    await this.run(
      () => this.library.exclude(this.inclusionRequests.get(key)!, s.kind, s.id, !checked),
      () => {},
      'Net-worth inclusion updated',
    );
    (event.target as HTMLInputElement).checked =
      this.sources().find((r) => r.kind === s.kind && r.id === s.id)?.included ?? s.included;
  }
  saveAsset() {
    const a = this.selectedAsset();
    if (!a) return;
    const v = this.assetForm.getRawValue();
    void this.run(
      () =>
        this.library.assetValue(
          this.assetRequest,
          a,
          v.amount,
          v.date,
          v.notes,
          this.previousAssetValue(),
        ),
      () => this.assetEditor.set(false),
      'Asset value saved',
    );
  }
  snapshot() {
    void this.run(
      () => this.library.snapshot(this.snapshotRequest, this.snapshotForm.getRawValue().label),
      () => {
        this.snapshotEditor.set(false);
        this.tab.set('snapshots');
      },
      'Net-worth snapshot captured',
    );
  }
  download(text: string, label: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-${label}-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  export() {
    if (this.tab() === 'holdings')
      this.download(
        csv(
          this.holdings().map((h) => ({
            title: h.title,
            type: h.kind,
            currency: h.currency,
            opened_on: h.opened_on,
            cost_basis: h.current_cost,
            value: h.current_value,
            as_of: h.last_entry_on,
            ...investmentPerformance(h, this.store.investmentEntries()),
            archived: h.archived,
            notes: h.notes,
          })),
        ),
        'investments',
      );
    else if (this.tab() === 'snapshots')
      this.download(
        csv(
          this.snapshots().flatMap((s) =>
            s.totals.map((t) => ({
              label: s.label,
              captured_on: s.captured_on,
              captured_at: s.created_at,
              ...t,
            })),
          ),
        ),
        'wealth-history',
      );
    else if (this.tab() === 'sources')
      this.download(
        csv(
          this.sources().map((s) => ({
            type: s.kind,
            title: s.title,
            currency: s.currency,
            value: s.value,
            included: s.included,
            as_of: s.date,
            estimate: s.estimated,
          })),
        ),
        'wealth-sources',
      );
    else this.download(csv(this.totalResult().totals.map((t) => ({ ...t }))), 'net-worth');
  }
  exportEntries() {
    this.download(
      csv(
        this.entries().map((e) => ({
          holding: this.selected()?.title ?? '',
          currency: this.selected()?.currency ?? '',
          sequence: e.sequence,
          type: e.kind,
          date: e.occurred_on,
          amount: e.amount,
          basis_removed: e.basis_removed,
          bank_account:
            this.store.accounts().find((a) => a.id === e.account_id)?.name ??
            'Outside LifeOS / valuation',
          undone: e.voided,
          notes: e.notes,
        })),
      ),
      'investment-history',
    );
  }
}
