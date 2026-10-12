import { Injectable, inject, effect, signal, computed } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  Asset,
  AssetInput,
  Attachment,
  MaintenancePlan,
  MaintenanceInput,
  ServiceInput,
  MaintenanceLog,
} from '../models/domain';
import {
  assetMoney,
  validateAsset,
  validateMaintenance,
  validateService,
  nextService,
} from '../../shared/utilities/assets';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class AssetLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly loadedDocuments = signal<Attachment[]>([]);
  readonly documents = computed(() =>
    [
      ...new Map(
        [...this.loadedDocuments(), ...this.store.attachments()]
          .filter(
            (f) =>
              f.owner_id === this.store.profile()?.id &&
              f.workspace_id === this.store.workspace()?.id &&
              ['ready', 'archived'].includes(f.status),
          )
          .map((f) => [f.id, f]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  );
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.loadedDocuments.set([]);
    });
  }
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  private readContext() {
    return {
      workspace: this.store.workspace()?.id,
      user: this.store.profile()?.id,
      session: this.store.fileSession(),
    };
  }
  private context() {
    const c = this.readContext();
    if (
      !c.workspace ||
      !c.user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && c.user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { ...c, workspace: c.workspace, user: c.user };
  }
  private current(c: ReturnType<AssetLibrary['readContext']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private own(
    row: Asset | MaintenancePlan | MaintenanceLog,
    c: ReturnType<AssetLibrary['context']>,
  ) {
    if (row.owner_id !== c.user || row.workspace_id !== c.workspace)
      throw new Error('Asset record is inaccessible.');
  }
  private async reload(c: ReturnType<AssetLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<AssetLibrary['context']>) {
    const time = new Date().toISOString();
    return {
      workspace_id: c.workspace,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: time,
      updated_at: time,
    };
  }
  async loadDocuments() {
    const c = this.readContext();
    if (!c.workspace || !c.user || this.store.auth.demo()) return;
    const list: Attachment[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await this.backend
        .requireClient()
        .from('attachments')
        .select('*')
        .eq('workspace_id', c.workspace)
        .eq('owner_id', c.user)
        .in('status', ['ready', 'archived'])
        .order('created_at')
        .order('id')
        .range(offset, offset + 499);
      if (error) throw error;
      if (!this.current(c)) return;
      list.push(...data);
      if (data.length < 500) break;
    }
    if (this.current(c)) this.loadedDocuments.set(list);
  }
  async save(id: string, input: AssetInput, previous?: Asset) {
    const c = this.context(),
      v = validateAsset(input, this.today());
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_asset', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        asset_name: v.name,
        asset_category: v.category,
        asset_manufacturer: v.manufacturer,
        asset_model: v.model,
        asset_serial: v.serial_number,
        asset_location: v.location,
        purchased: v.purchased_on || null,
        price: assetMoney(v.purchase_price),
        price_currency: v.currency,
        warranty: v.warranty_until || null,
        asset_notes: v.notes,
        documents: v.document_ids,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.assets().find((a) => a.id === id);
    if (old) {
      this.own(old, c);
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('Asset changed; refresh and try again.');
      if (old.status !== 'active') throw new Error('Restore the asset before editing.');
    } else if (previous) throw new Error('Asset is inaccessible.');
    if (v.document_ids.some((id) => !this.documents().some((f) => f.id === id)))
      throw new Error('Choose your own completed document in this workspace.');
    const base = this.base(c),
      row: Asset = {
        ...base,
        id,
        name: v.name,
        category: v.category,
        manufacturer: v.manufacturer,
        model: v.model,
        serial_number: v.serial_number,
        location: v.location,
        purchased_on: v.purchased_on || null,
        purchase_price: assetMoney(v.purchase_price),
        currency: v.currency,
        warranty_until: v.warranty_until || null,
        notes: v.notes,
        status: 'active',
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? base.created_at,
      };
    this.store.assets.update((rows) => [row, ...rows.filter((a) => a.id !== id)]);
    this.store.assetDocuments.update((rows) => [
      ...rows.filter((l) => l.asset_id !== id),
      ...v.document_ids.map((attachment_id) => ({
        ...base,
        id: crypto.randomUUID(),
        asset_id: id,
        attachment_id,
      })),
    ]);
  }
  async setStatus(row: Asset, target: Asset['status']) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('set_asset_status', { entry: row.id, expected_revision: row.revision, target });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.assets().find((a) => a.id === row.id);
    if (!old) throw new Error('Asset is inaccessible.');
    if (old.status === target) return;
    if (old.revision !== row.revision) throw new Error('Asset changed; refresh and try again.');
    this.store.assets.update((rows) =>
      rows.map((a) =>
        a.id === row.id
          ? { ...a, status: target, revision: a.revision + 1, updated_at: new Date().toISOString() }
          : a,
      ),
    );
  }
  private asset(id: string, c: ReturnType<AssetLibrary['context']>) {
    const a = this.store.assets().find((a) => a.id === id);
    if (!a || a.owner_id !== c.user || a.workspace_id !== c.workspace || a.status !== 'active')
      throw new Error('Choose your own active asset in this workspace.');
    return a;
  }
  async savePlan(id: string, input: MaintenanceInput, previous?: MaintenancePlan) {
    const c = this.context(),
      v = validateMaintenance(input);
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_maintenance_plan', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        asset: v.asset_id,
        plan_title: v.title,
        first_due: v.next_on,
        repeat_frequency: v.frequency,
        plan_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    this.asset(v.asset_id, c);
    const old = this.store.maintenancePlans().find((p) => p.id === id);
    if (old) {
      this.own(old, c);
      if (old.asset_id !== v.asset_id) throw new Error('Maintenance plan is inaccessible.');
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('Maintenance plan changed; refresh and try again.');
      if (old.status === 'completed')
        throw new Error('Add a new plan for a completed one-time service.');
    } else if (previous) throw new Error('Maintenance plan is inaccessible.');
    const changed = !old || old.next_on !== v.next_on || old.frequency !== v.frequency;
    if (
      changed &&
      this.store.maintenanceLogs().some((l) => l.plan_id === id && l.scheduled_on === v.next_on)
    )
      throw new Error('This scheduled date was already completed; choose a new date.');
    const row: MaintenancePlan = {
      ...this.base(c),
      id,
      asset_id: v.asset_id,
      title: v.title,
      anchor_on: changed ? v.next_on : old!.anchor_on,
      next_on: v.next_on,
      frequency: v.frequency,
      occurrence_count: changed ? 0 : old!.occurrence_count,
      status: old?.status ?? 'active',
      notes: v.notes,
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? new Date().toISOString(),
    };
    this.store.maintenancePlans.update((rows) => [row, ...rows.filter((p) => p.id !== id)]);
  }
  async pause(row: MaintenancePlan) {
    const c = this.context();
    this.own(row, c);
    const target = row.status === 'paused' ? 'active' : 'paused';
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('set_maintenance_status', { entry: row.id, expected_revision: row.revision, target });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    this.asset(row.asset_id, c);
    const old = this.store.maintenancePlans().find((p) => p.id === row.id);
    if (!old || old.status === 'completed')
      throw new Error('Completed one-time plans cannot resume.');
    if (old.status === target) return;
    if (old.revision !== row.revision)
      throw new Error('Maintenance plan changed; refresh and try again.');
    this.store.maintenancePlans.update((rows) =>
      rows.map((p) =>
        p.id === row.id
          ? { ...p, status: target, revision: p.revision + 1, updated_at: new Date().toISOString() }
          : p,
      ),
    );
  }
  async record(id: string, row: MaintenancePlan, v: ServiceInput) {
    const c = this.context();
    this.own(row, c);
    const cost = validateService(v, this.today());
    if (!row.next_on) throw new Error('Maintenance plan is completed.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('record_maintenance', {
        entry: id,
        plan: row.id,
        expected_revision: row.revision,
        expected_date: row.next_on,
        performed: v.performed_on,
        service_cost: cost,
        service_notes: v.notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const prior = this.store.maintenanceLogs().find((l) => l.id === id);
    if (prior) {
      this.own(prior, c);
      if (prior.plan_id !== row.id) throw new Error('Service record is inaccessible.');
      return;
    }
    const a = this.asset(row.asset_id, c),
      p = this.store.maintenancePlans().find((p) => p.id === row.id);
    if (!p || p.status !== 'active' || p.revision !== row.revision || p.next_on !== row.next_on)
      throw new Error('Maintenance plan changed or inactive; refresh and try again.');
    const next = nextService(p);
    if (
      this.store
        .maintenanceLogs()
        .some(
          (l) => l.plan_id === p.id && (l.scheduled_on === p.next_on || l.scheduled_on === next),
        )
    )
      throw new Error('Scheduled date already completed; edit the plan to a new date.');
    const log: MaintenanceLog = {
      ...this.base(c),
      id,
      asset_id: a.id,
      plan_id: p.id,
      scheduled_on: p.next_on!,
      performed_on: v.performed_on,
      title: p.title,
      cost,
      currency: a.currency,
      notes: v.notes,
    };
    this.store.maintenanceLogs.update((rows) => [log, ...rows]);
    this.store.maintenancePlans.update((rows) =>
      rows.map((r) =>
        r.id === p.id
          ? {
              ...r,
              next_on: next,
              status: next ? 'active' : 'completed',
              occurrence_count: r.occurrence_count + 1,
              revision: r.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : r,
      ),
    );
  }
  async openDocument(id: string) {
    const c = this.readContext();
    if (!c.workspace || !c.user) return null;
    let row = this.documents().find((f) => f.id === id);
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend
        .requireClient()
        .from('attachments')
        .select('*')
        .eq('id', id)
        .eq('workspace_id', c.workspace)
        .eq('owner_id', c.user)
        .maybeSingle();
      if (error) throw error;
      if (!this.current(c)) return null;
      row = data ?? undefined;
    }
    if (!row || !['ready', 'archived'].includes(row.status))
      throw new Error('Linked document is unavailable.');
    if (!this.current(c)) return null;
    this.store.attachments.update((rows) => [row!, ...rows.filter((f) => f.id !== id)]);
    return row;
  }
}
