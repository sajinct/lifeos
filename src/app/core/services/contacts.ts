import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Contact, ContactInput, Project } from '../models/domain';
import { validateContact } from '../../shared/utilities/contacts';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class ContactLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly loadedProjects = signal<Project[]>([]);
  readonly projects = computed(() => {
    const c = this.readContext();
    return [
      ...new Map(
        [...this.store.projects(), ...this.loadedProjects()]
          .filter((p) => p.owner_id === c.user && p.workspace_id === c.workspace)
          .map((p) => [p.id, p]),
      ).values(),
    ].sort((a, b) => a.title.localeCompare(b.title));
  });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.loadedProjects.set([]);
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
  private current(c: ReturnType<ContactLibrary['readContext']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private own(row: Contact, c: ReturnType<ContactLibrary['context']>) {
    if (row.owner_id !== c.user || row.workspace_id !== c.workspace)
      throw new Error('Contact is inaccessible.');
  }
  private async reload(c: ReturnType<ContactLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  async loadProjects() {
    const c = this.readContext();
    if (!c.workspace || !c.user || this.store.auth.demo()) return;
    const list: Project[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await this.backend
        .requireClient()
        .from('projects')
        .select('*')
        .eq('workspace_id', c.workspace)
        .eq('owner_id', c.user)
        .order('created_at')
        .order('id')
        .range(offset, offset + 499);
      if (error) throw error;
      if (!this.current(c)) return;
      list.push(...data);
      if (data.length < 500) break;
    }
    if (this.current(c)) this.loadedProjects.set(list);
  }
  async save(id: string, input: ContactInput, previous?: Contact) {
    const c = this.context(),
      v = validateContact(input, this.today());
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_contact', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        contact_name: v.name,
        contact_kind: v.kind,
        contact_organization: v.organization,
        contact_category: v.category,
        contact_email: v.email,
        contact_phone: v.phone,
        contact_website: v.website,
        contact_address: v.address,
        contact_notes: v.notes,
        follow_up: v.next_follow_up || null,
        follow_up_description: v.follow_up_note,
        last_contact: v.last_contacted_on || null,
        projects: v.project_ids,
        loans: v.loan_ids,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.contacts().find((r) => r.id === id);
    if (old && !previous) return;
    if (previous && (!old || old.revision !== previous.revision || old.status !== 'active'))
      throw new Error('Contact changed; refresh and try again.');
    if (
      v.project_ids.some((id) => !this.projects().some((p) => p.id === id)) ||
      v.loan_ids.some(
        (id) =>
          !this.store
            .loans()
            .some((l) => l.id === id && l.owner_id === c.user && l.workspace_id === c.workspace),
      )
    )
      throw new Error('Choose your own projects and loans in this workspace.');
    const time = new Date().toISOString(),
      base = {
        workspace_id: c.workspace,
        owner_id: c.user,
        visibility: 'private' as const,
        created_at: old?.created_at ?? time,
        updated_at: time,
      };
    const row: Contact = {
      ...base,
      id,
      name: v.name,
      kind: v.kind,
      organization: v.organization,
      category: v.category,
      email: v.email,
      phone: v.phone,
      website: v.website,
      address: v.address,
      notes: v.notes,
      next_follow_up: v.next_follow_up || null,
      follow_up_note: v.follow_up_note,
      last_contacted_on: v.last_contacted_on || null,
      status: 'active',
      revision: (old?.revision ?? 0) + 1,
    };
    this.store.contacts.update((rows) => [row, ...rows.filter((r) => r.id !== id)]);
    this.store.contactLinks.update((rows) => [
      ...rows.filter((r) => r.contact_id !== id),
      ...v.project_ids.map((project_id) => ({
        ...base,
        id: crypto.randomUUID(),
        contact_id: id,
        project_id,
        loan_id: null,
      })),
      ...v.loan_ids.map((loan_id) => ({
        ...base,
        id: crypto.randomUUID(),
        contact_id: id,
        loan_id,
        project_id: null,
      })),
    ]);
  }
  async setStatus(row: Contact, target: Contact['status']) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('set_contact_status', { entry: row.id, expected_revision: row.revision, target });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.contacts().find((r) => r.id === row.id);
    if (!old) throw new Error('Contact is inaccessible.');
    if (old.status === target) return;
    if (old.revision !== row.revision) throw new Error('Contact changed; refresh and try again.');
    this.store.contacts.update((rows) =>
      rows.map((r) =>
        r.id === row.id
          ? { ...r, status: target, revision: r.revision + 1, updated_at: new Date().toISOString() }
          : r,
      ),
    );
  }
  async contacted(row: Contact) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('complete_contact_follow_up', { entry: row.id, expected_revision: row.revision });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.contacts().find((r) => r.id === row.id);
    if (!old) throw new Error('Contact is inaccessible.');
    if (!old.next_follow_up && old.last_contacted_on === this.today()) return;
    if (old.status !== 'active' || old.revision !== row.revision)
      throw new Error('Contact changed; refresh and try again.');
    this.store.contacts.update((rows) =>
      rows.map((r) =>
        r.id === row.id
          ? {
              ...r,
              next_follow_up: null,
              follow_up_note: '',
              last_contacted_on: this.today(),
              revision: r.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : r,
      ),
    );
  }
  async openProject(id: string) {
    const c = this.readContext();
    if (!c.workspace || !c.user) return false;
    let row = this.projects().find((p) => p.id === id);
    if (!row && !this.store.auth.demo()) {
      const { data, error } = await this.backend
        .requireClient()
        .from('projects')
        .select('*')
        .eq('id', id)
        .eq('workspace_id', c.workspace)
        .eq('owner_id', c.user)
        .maybeSingle();
      if (error) throw error;
      if (!this.current(c)) return false;
      row = data ?? undefined;
    }
    if (!row) throw new Error('Linked project is unavailable.');
    if (!this.current(c)) return false;
    this.store.projects.update((rows) => [...rows.filter((r) => r.id !== id), row!]);
    return true;
  }
}
