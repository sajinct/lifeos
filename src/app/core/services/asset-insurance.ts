import { computed, effect, inject, Injectable } from '@angular/core';
import { AssetInsurance, AssetInsuranceInput } from '../models/domain';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { AssetLibrary } from './assets';
import { validateInsurance } from '../../shared/utilities/asset-insurance';
@Injectable({ providedIn: 'root' })
export class AssetInsuranceLibrary {
  readonly store = inject(LifeStore);
  readonly assets = inject(AssetLibrary);
  private readonly backend = inject(Backend);
  private session = -1;
  private readonly requests = new Map<
    string,
    { w: string; user: string; session: number; payload: string; done: boolean }
  >();
  readonly rows = computed(() =>
    this.store
      .assetInsurance()
      .filter(
        (p) =>
          p.workspace_id === this.store.workspace()?.id && p.owner_id === this.store.profile()?.id,
      ),
  );
  readonly choices = computed(() =>
    this.store
      .assets()
      .filter(
        (a) =>
          a.workspace_id === this.store.workspace()?.id && a.owner_id === this.store.profile()?.id,
      ),
  );
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.sync();
    });
  }
  private sync() {
    const s = this.store.fileSession();
    if (s !== this.session) {
      this.requests.clear();
      this.session = s;
    }
  }
  private stamp() {
    return {
      w: this.store.workspace()?.id,
      user: this.store.profile()?.id,
      session: this.store.fileSession(),
    };
  }
  private current(c: ReturnType<AssetInsuranceLibrary['stamp']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private context(request: string) {
    this.sync();
    const c = this.stamp(),
      old = this.requests.get(request),
      retry = !this.store.auth.demo() && old && this.current(old);
    if (
      !c.w ||
      !c.user ||
      (!this.store.writable() && !retry) ||
      (!this.store.auth.demo() && c.user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { ...c, w: c.w, user: c.user };
  }
  private remember(
    request: string,
    c: ReturnType<AssetInsuranceLibrary['context']>,
    payload: unknown,
  ) {
    const text = JSON.stringify(payload),
      old = this.requests.get(request);
    if (
      old &&
      (old.w !== c.w || old.user !== c.user || old.session !== c.session || old.payload !== text)
    )
      throw new Error('Insurance request was already used for another change.');
    this.requests.set(request, { ...c, payload: text, done: old?.done ?? false });
    return old?.done ?? false;
  }
  private finish(request: string) {
    const r = this.requests.get(request)!;
    this.requests.set(request, { ...r, done: true });
  }
  private async reload(c: ReturnType<AssetInsuranceLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error())
      throw new Error('Insurance saved, but refresh failed. Retry this change safely.');
  }
  documents(policy: AssetInsurance) {
    return this.store
      .assetInsuranceDocuments()
      .filter(
        (l) =>
          l.insurance_id === policy.id &&
          l.workspace_id === this.store.workspace()?.id &&
          l.owner_id === this.store.profile()?.id,
      );
  }
  async save(request: string, id: string, input: AssetInsuranceInput, previous?: AssetInsurance) {
    const c = this.context(request),
      v = validateInsurance(input),
      retry = this.requests.has(request),
      old = this.rows().find((p) => p.id === id);
    const asset = this.choices().find((a) => a.id === v.asset_id);
    if (
      (!asset && !(retry && !this.store.auth.demo())) ||
      (previous &&
        (previous.owner_id !== c.user ||
          previous.workspace_id !== c.w ||
          previous.asset_id !== v.asset_id ||
          previous.id !== id))
    )
      throw new Error('Choose your own asset in this workspace.');
    const { asset_id, document_ids, ...details } = v;
    const done = this.remember(request, c, ['save', id, previous?.revision ?? null, v]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_asset_insurance', {
        request,
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        asset: asset_id,
        details,
        documents: document_ids,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (asset?.status !== 'active')
      throw new Error('Restore the asset before recording or editing insurance.');
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Insurance changed; refresh and try again.');
    if (previous && !old) throw new Error('Insurance record is inaccessible.');
    if (old && (old.archived || old.cancelled))
      throw new Error('Restore or reopen the policy record before editing.');
    if (!old && this.rows().filter((p) => p.asset_id === asset_id).length >= 200)
      throw new Error('An asset supports up to 200 policy records, including archives.');
    if (document_ids.some((id) => !this.assets.documents().some((f) => f.id === id)))
      throw new Error('Choose your own completed document version in this workspace.');
    const now = new Date().toISOString(),
      base = {
        workspace_id: c.w,
        owner_id: c.user,
        visibility: 'private' as const,
        created_at: now,
        updated_at: now,
      };
    this.store.assetInsurance.update((rows) => [
      {
        ...base,
        ...details,
        id,
        asset_id,
        revision: (old?.revision ?? 0) + 1,
        cancelled: false,
        archived: false,
        created_at: old?.created_at ?? now,
      },
      ...rows.filter((p) => p.id !== id),
    ]);
    this.store.assetInsuranceDocuments.update((rows) => [
      ...rows.filter((l) => l.insurance_id !== id),
      ...document_ids.map((attachment_id) => ({
        ...base,
        id: crypto.randomUUID(),
        insurance_id: id,
        attachment_id,
      })),
    ]);
    this.finish(request);
  }
  async state(request: string, previous: AssetInsurance, cancelled: boolean, archived: boolean) {
    const c = this.context(request),
      old = this.rows().find((p) => p.id === previous.id);
    if (
      previous.owner_id !== c.user ||
      previous.workspace_id !== c.w ||
      (!old && !(this.requests.has(request) && !this.store.auth.demo()))
    )
      throw new Error('Insurance record is inaccessible.');
    const done = this.remember(request, c, [
      'state',
      previous.id,
      previous.revision,
      cancelled,
      archived,
    ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_asset_insurance_state', {
        request,
        entry: previous.id,
        expected_revision: previous.revision,
        is_cancelled: cancelled,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (!old || old.revision !== previous.revision)
      throw new Error('Insurance changed; refresh and try again.');
    this.store.assetInsurance.update((rows) =>
      rows.map((p) =>
        p.id === old.id
          ? {
              ...p,
              cancelled,
              archived,
              revision: p.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : p,
      ),
    );
    this.finish(request);
  }
}
