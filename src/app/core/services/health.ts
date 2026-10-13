import { Injectable, inject, effect, signal, computed } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { HealthAppointment, HealthInput, Attachment, HealthAction } from '../models/domain';
import { validateHealth, healthDetails } from '../../shared/utilities/health';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class HealthLibrary {
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
  private current(c: ReturnType<HealthLibrary['readContext']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private own(row: HealthAppointment, c: ReturnType<HealthLibrary['context']>) {
    if (row.owner_id !== c.user || row.workspace_id !== c.workspace)
      throw new Error('Health appointment is inaccessible.');
  }
  private async reload(c: ReturnType<HealthLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<HealthLibrary['context']>) {
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

  async save(id: string, input: HealthInput, previous?: HealthAppointment) {
    const c = this.context(),
      v = validateHealth(input, this.today());
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_health_appointment', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        details: healthDetails(v),
        documents: v.document_ids,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.healthAppointments().find((r) => r.id === id);
    if (old) {
      this.own(old, c);
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('Health appointment changed; refresh and try again.');
      if (old.archived) throw new Error('Restore the appointment before editing.');
    } else if (previous) throw new Error('Health appointment is inaccessible.');
    if (v.document_ids.some((id) => !this.documents().some((f) => f.id === id)))
      throw new Error('Choose your own completed document in this workspace.');
    const { document_ids, ...fields } = v,
      base = this.base(c);
    const row: HealthAppointment = {
      ...base,
      ...fields,
      id,
      archived: false,
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? base.created_at,
    };
    this.store.healthAppointments.update((rows) => [row, ...rows.filter((r) => r.id !== id)]);
    this.store.healthDocuments.update((rows) => [
      ...rows.filter((l) => l.appointment_id !== id),
      ...document_ids.map((attachment_id) => ({
        ...base,
        id: crypto.randomUUID(),
        appointment_id: id,
        attachment_id,
      })),
    ]);
  }
  async act(row: HealthAppointment, action: HealthAction) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('act_on_health_appointment', {
        entry: row.id,
        expected_revision: row.revision,
        action,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.healthAppointments().find((r) => r.id === row.id);
    if (!old) throw new Error('Health appointment is inaccessible.');
    this.own(old, c);
    const status =
      action === 'complete'
        ? 'completed'
        : action === 'cancel'
          ? 'cancelled'
          : action === 'reopen'
            ? 'scheduled'
            : old.status;
    const archived = action === 'archive' ? true : action === 'restore' ? false : old.archived;
    if (old.status === status && old.archived === archived) return;
    if (old.revision !== row.revision || (old.archived && !['archive', 'restore'].includes(action)))
      throw new Error('Appointment changed; restore or refresh and try again.');
    if (status === 'completed' && old.appointment_on > this.today())
      throw new Error('Completed visits cannot be in the future.');
    this.store.healthAppointments.update((rows) =>
      rows.map((r) =>
        r.id === old.id
          ? {
              ...r,
              status,
              archived,
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
