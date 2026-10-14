import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import {
  HouseholdMember,
  HouseholdEntry,
  HouseholdMemberInput,
  HouseholdEntryInput,
} from '../models/domain';
import {
  validateHouseholdMember,
  validateHouseholdEntry,
  householdAnniversary,
} from '../../shared/utilities/household';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class HouseholdLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  occurrence(row: HouseholdMember | HouseholdEntry) {
    if ('birthday' in row)
      return row.birthday ? householdAnniversary('2000-' + row.birthday, this.today()) : null;
    return row.due_on && row.annual ? householdAnniversary(row.due_on, this.today()) : row.due_on;
  }
  private context() {
    const workspace = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !workspace ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { workspace, user, session };
  }
  private current(c: ReturnType<HouseholdLibrary['context']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private authorize(
    row: HouseholdMember | HouseholdEntry,
    c: ReturnType<HouseholdLibrary['context']>,
  ) {
    if (row.workspace_id !== c.workspace || !this.store.canEdit(row))
      throw new Error('Household record is inaccessible.');
  }
  private revision(
    row: HouseholdMember | HouseholdEntry,
    previous: HouseholdMember | HouseholdEntry,
  ) {
    if (row.revision !== previous.revision)
      throw new Error('Household record changed; refresh and try again.');
  }
  private sharing(row: HouseholdMember | HouseholdEntry, visibility: string, user: string) {
    if (row.owner_id !== user && row.visibility !== visibility)
      throw new Error('Only the record creator can change sharing.');
  }
  private async reload(c: ReturnType<HouseholdLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  async saveMember(id: string, input: HouseholdMemberInput, previous?: HouseholdMember) {
    const c = this.context(),
      v = validateHouseholdMember(input);
    if (previous) this.authorize(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_household_member', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        member_name: v.name,
        relation: v.relationship,
        birthday_month_day: v.birthday || null,
        member_notes: v.notes,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.householdMembers().find((r) => r.id === id);
    if (old) {
      this.authorize(old, c);
      if (!previous) {
        if (old.owner_id !== c.user) throw new Error('Household record is inaccessible.');
        return;
      }
      this.revision(old, previous);
      this.sharing(old, v.visibility, c.user);
      if (old.status !== 'active') throw new Error('Restore the household member before editing.');
    } else if (previous) throw new Error('Household record is inaccessible.');
    if (
      v.visibility === 'private' &&
      this.store.householdEntries().some((e) => e.member_id === id && e.visibility === 'workspace')
    )
      throw new Error(
        'Unlink shared responsibilities and dates before making this member private.',
      );
    if (
      v.visibility === 'private' &&
      this.store.educationStudents().some((s) => s.member_id === id && s.visibility === 'workspace')
    )
      throw new Error(
        'Unlink or make linked education records private before making this household member private.',
      );
    const now = new Date().toISOString(),
      row: HouseholdMember = {
        id,
        workspace_id: c.workspace,
        owner_id: old?.owner_id ?? c.user,
        created_at: old?.created_at ?? now,
        updated_at: now,
        ...v,
        birthday: v.birthday || null,
        status: 'active',
        revision: (old?.revision ?? 0) + 1,
      };
    this.store.householdMembers.update((rows) => [...rows.filter((r) => r.id !== id), row]);
  }
  async saveEntry(id: string, input: HouseholdEntryInput, previous?: HouseholdEntry) {
    const c = this.context(),
      v = validateHouseholdEntry(input);
    if (previous) this.authorize(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_household_entry', {
        entry: id,
        w: c.workspace,
        expected_revision: previous?.revision ?? null,
        entry_title: v.title,
        entry_kind: v.kind,
        entry_date: v.due_on || null,
        repeats_annually: v.annual,
        household_member: v.member_id || null,
        entry_notes: v.notes,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.householdEntries().find((r) => r.id === id);
    if (old) {
      this.authorize(old, c);
      if (!previous) {
        if (old.owner_id !== c.user) throw new Error('Household record is inaccessible.');
        return;
      }
      this.revision(old, previous);
      this.sharing(old, v.visibility, c.user);
      if (old.status !== 'active')
        throw new Error('Reopen or restore the household entry before editing.');
      if (old.kind !== v.kind) throw new Error('Entry type cannot change.');
    } else if (previous) throw new Error('Household record is inaccessible.');
    if (v.member_id) {
      const m = this.store
        .householdMembers()
        .find(
          (m) =>
            m.id === v.member_id &&
            m.workspace_id === c.workspace &&
            (m.owner_id === c.user || m.visibility === 'workspace'),
        );
      if (
        !m ||
        (m.status !== 'active' && old?.member_id !== m.id) ||
        (v.visibility === 'workspace' && m.visibility !== 'workspace')
      )
        throw new Error('Choose an accessible member with matching sharing.');
    }
    const now = new Date().toISOString(),
      row: HouseholdEntry = {
        id,
        workspace_id: c.workspace,
        owner_id: old?.owner_id ?? c.user,
        created_at: old?.created_at ?? now,
        updated_at: now,
        ...v,
        due_on: v.due_on || null,
        member_id: v.member_id || null,
        status: 'active',
        revision: (old?.revision ?? 0) + 1,
      };
    this.store.householdEntries.update((rows) => [...rows.filter((r) => r.id !== id), row]);
  }
  async status(row: HouseholdMember | HouseholdEntry, target: HouseholdEntry['status']) {
    const c = this.context();
    this.authorize(row, c);
    const member = 'birthday' in row;
    if (target === 'done' && (member || row.kind !== 'task'))
      throw new Error('Only responsibilities can be completed.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_household_status', {
        record_kind: member ? 'member' : 'entry',
        entry: row.id,
        expected_revision: row.revision,
        target,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (member) {
      const old = this.store.householdMembers().find((r) => r.id === row.id);
      if (!old) throw new Error('Household record is inaccessible.');
      this.authorize(old, c);
      if (old.status === target) return;
      this.revision(old, row);
      this.store.householdMembers.update((rows) =>
        rows.map((r) =>
          r.id === row.id
            ? {
                ...r,
                status: target as HouseholdMember['status'],
                revision: r.revision + 1,
                updated_at: new Date().toISOString(),
              }
            : r,
        ),
      );
    } else {
      const old = this.store.householdEntries().find((r) => r.id === row.id);
      if (!old) throw new Error('Household record is inaccessible.');
      this.authorize(old, c);
      if (old.status === target) return;
      this.revision(old, row);
      this.store.householdEntries.update((rows) =>
        rows.map((r) =>
          r.id === row.id
            ? {
                ...r,
                status: target,
                revision: r.revision + 1,
                updated_at: new Date().toISOString(),
              }
            : r,
        ),
      );
    }
  }
}
