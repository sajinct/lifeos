import { Injectable, inject, effect, signal, computed } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { CareerRecord, CareerInput, Attachment } from '../models/domain';
import { validateCareer, careerDetails } from '../../shared/utilities/career';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class CareerLibrary {
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
  private current(c: ReturnType<CareerLibrary['readContext']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private own(row: CareerRecord, c: ReturnType<CareerLibrary['context']>) {
    if (row.owner_id !== c.user || row.workspace_id !== c.workspace)
      throw new Error('Career record is inaccessible.');
  }
  private async reload(c: ReturnType<CareerLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<CareerLibrary['context']>) {
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

  async save(id: string, input: CareerInput, previous?: CareerRecord) {
    const c = this.context(),
      v = validateCareer(input, this.today());
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_career_record', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        details: careerDetails(v),
        documents: v.document_ids,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.careerRecords().find((r) => r.id === id);
    if (old) {
      this.own(old, c);
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('Career record changed; refresh and try again.');
      if (old.kind !== v.kind) throw new Error('Career section cannot change.');
    } else if (previous) throw new Error('Career record is inaccessible.');
    if (v.document_ids.some((id) => !this.documents().some((f) => f.id === id)))
      throw new Error('Choose your own completed document in this workspace.');
    const { document_ids, ...fields } = v,
      base = this.base(c);
    const row: CareerRecord = {
      ...base,
      ...fields,
      id,
      starts_on: v.starts_on || null,
      ends_on: v.ends_on || null,
      applied_on: v.applied_on || null,
      interview_on: v.interview_on || null,
      follow_up_on: v.follow_up_on || null,
      expires_on: v.expires_on || null,
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? base.created_at,
    };
    this.store.careerRecords.update((rows) => [row, ...rows.filter((r) => r.id !== id)]);
    this.store.careerDocuments.update((rows) => [
      ...rows.filter((l) => l.record_id !== id),
      ...document_ids.map((attachment_id) => ({
        ...base,
        id: crypto.randomUUID(),
        record_id: id,
        attachment_id,
      })),
    ]);
  }
  async act(row: CareerRecord, action: 'archive' | 'restore' | 'follow_up' | 'interview') {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('act_on_career_record', { entry: row.id, expected_revision: row.revision, action });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.careerRecords().find((r) => r.id === row.id);
    if (!old) throw new Error('Career record is inaccessible.');
    if (
      ['follow_up', 'interview'].includes(action) &&
      (old.kind !== 'application' || !['applied', 'interview', 'offer'].includes(old.status))
    )
      throw new Error('Application is closed.');
    if (
      (action === 'archive' && old.status === 'archived') ||
      (action === 'restore' && old.status !== 'archived') ||
      (action === 'follow_up' && !old.follow_up_on) ||
      (action === 'interview' && !old.interview_on)
    )
      return;
    if (old.revision !== row.revision)
      throw new Error('Career record changed; refresh and try again.');
    this.store.careerRecords.update((rows) =>
      rows.map((r) =>
        r.id === old.id
          ? {
              ...r,
              status:
                action === 'archive'
                  ? 'archived'
                  : action === 'restore'
                    ? r.kind === 'application'
                      ? 'applied'
                      : 'active'
                    : r.status,
              follow_up_on: action === 'follow_up' ? null : r.follow_up_on,
              interview_on: action === 'interview' ? null : r.interview_on,
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
