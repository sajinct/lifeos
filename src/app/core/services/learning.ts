import { computed, effect, inject, Injectable } from '@angular/core';
import { LearningInput, LearningItem, LearningUnit } from '../models/domain';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { NotesLibrary } from './notes';
import { learningProgress, validateLearning } from '../../shared/utilities/learning';

@Injectable({ providedIn: 'root' })
export class LearningLibrary {
  readonly store = inject(LifeStore);
  readonly notes = inject(NotesLibrary);
  private readonly backend = inject(Backend);
  private readonly requests = new Map<
    string,
    { w: string; user: string; session: number; payload: string; done: boolean }
  >();
  private requestSession = -1;
  readonly items = computed(() =>
    this.store
      .learningItems()
      .filter(
        (i) =>
          i.workspace_id === this.store.workspace()?.id && i.owner_id === this.store.profile()?.id,
      ),
  );
  readonly noteChoices = computed(() =>
    this.store
      .notes()
      .filter(
        (n) =>
          n.workspace_id === this.store.workspace()?.id && n.owner_id === this.store.profile()?.id,
      ),
  );
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.syncRequests();
    });
  }
  private syncRequests() {
    const s = this.store.fileSession();
    if (s !== this.requestSession) {
      this.requests.clear();
      this.requestSession = s;
    }
  }
  private stamp() {
    return {
      w: this.store.workspace()?.id,
      user: this.store.profile()?.id,
      session: this.store.fileSession(),
    };
  }
  private current(c: ReturnType<LearningLibrary['stamp']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private context(request: string) {
    this.syncRequests();
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
  private remember(request: string, c: ReturnType<LearningLibrary['context']>, payload: unknown) {
    const p = JSON.stringify(payload),
      old = this.requests.get(request);
    if (
      old &&
      (old.w !== c.w || old.user !== c.user || old.session !== c.session || old.payload !== p)
    )
      throw new Error('Request was already used for another change.');
    this.requests.set(request, { ...c, payload: p, done: old?.done ?? false });
    return !!old?.done;
  }
  private finish(request: string) {
    const r = this.requests.get(request)!;
    this.requests.set(request, { ...r, done: true });
  }
  private async reload(c: ReturnType<LearningLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error())
      throw new Error('Learning change saved, but refresh failed. Retry this change safely.');
  }
  private parent(
    previous: LearningItem,
    c: ReturnType<LearningLibrary['context']>,
    retry: boolean,
  ) {
    const old = this.items().find((i) => i.id === previous.id);
    if (
      !this.store.auth.demo() &&
      retry &&
      previous.workspace_id === c.w &&
      previous.owner_id === c.user
    )
      return old ?? previous;
    if (!old) throw new Error('Learning item is inaccessible.');
    return old;
  }
  units(item: LearningItem) {
    return this.store
      .learningUnits()
      .filter(
        (u) =>
          u.workspace_id === item.workspace_id &&
          u.owner_id === item.owner_id &&
          u.item_id === item.id,
      )
      .sort((a, b) => a.position - b.position);
  }
  progress(item: LearningItem) {
    return learningProgress(item, this.units(item));
  }
  linkedNotes(item: LearningItem) {
    return this.store
      .learningNotes()
      .filter((l) => l.item_id === item.id && l.owner_id === this.store.profile()?.id)
      .map((l) => this.noteChoices().find((n) => n.id === l.note_id))
      .filter((n) => !!n);
  }
  linkedFiles(item: LearningItem) {
    return this.store
      .learningDocuments()
      .filter((l) => l.item_id === item.id && l.owner_id === this.store.profile()?.id)
      .map((l) => ({
        file: this.notes.documents().find((f) => f.id === l.attachment_id),
        purpose: l.purpose,
      }))
      .filter(
        (l): l is { file: NonNullable<typeof l.file>; purpose: typeof l.purpose } => !!l.file,
      );
  }
  async save(request: string, id: string, input: LearningInput, previous?: LearningItem) {
    const c = this.context(request),
      v = validateLearning(input),
      retry = this.requests.has(request),
      old = previous ? this.parent(previous, c, retry) : this.items().find((i) => i.id === id);
    if (this.store.auth.demo() || !retry) {
      if (v.note_ids.some((id) => !this.noteChoices().some((n) => n.id === id)))
        throw new Error('Choose notes you own in this workspace.');
      if (
        [...v.document_ids, ...v.certificate_ids].some(
          (id) => !this.notes.documents().some((f) => f.id === id),
        )
      )
        throw new Error('Choose your own completed documents in this workspace.');
    }
    const done = this.remember(request, c, ['save', id, previous?.revision ?? null, v]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_learning_item', {
        request,
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        item_kind: v.kind,
        item_title: v.title,
        provider_name: v.provider,
        resource_url: v.url,
        learning_goal: v.goal,
        deadline: v.due_on || null,
        item_notes: v.notes,
        note_ids: v.note_ids,
        document_ids: v.document_ids,
        certificate_ids: v.certificate_ids,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Learning item changed; refresh and try again.');
    if (previous && !old) throw new Error('Learning item is inaccessible.');
    if (old?.archived) throw new Error('Restore the learning item before editing.');
    const now = new Date().toISOString(),
      base = {
        workspace_id: c.w,
        owner_id: c.user,
        visibility: 'private' as const,
        created_at: old?.created_at ?? now,
        updated_at: now,
      };
    this.store.learningItems.update((rows) => [
      {
        ...base,
        id,
        kind: v.kind,
        title: v.title,
        provider: v.provider,
        url: v.url,
        goal: v.goal,
        due_on: v.due_on || null,
        notes: v.notes,
        status: old?.status ?? 'active',
        completed_on: old?.completed_on ?? null,
        archived: false,
        revision: old ? old.revision + 1 : 1,
      },
      ...rows.filter((i) => i.id !== id),
    ]);
    this.store.learningNotes.update((rows) => [
      ...rows.filter((l) => l.item_id !== id),
      ...v.note_ids.map((note_id) => ({ ...base, id: crypto.randomUUID(), item_id: id, note_id })),
    ]);
    this.store.learningDocuments.update((rows) => [
      ...rows.filter((l) => l.item_id !== id),
      ...v.document_ids.map((attachment_id) => ({
        ...base,
        id: crypto.randomUUID(),
        item_id: id,
        attachment_id,
        purpose: 'reference' as const,
      })),
      ...v.certificate_ids.map((attachment_id) => ({
        ...base,
        id: crypto.randomUUID(),
        item_id: id,
        attachment_id,
        purpose: 'certificate' as const,
      })),
    ]);
    this.finish(request);
  }
  async unit(
    request: string,
    id: string,
    item: LearningItem,
    title: string,
    notes: string,
    done: boolean,
    archived = false,
    previous?: LearningUnit,
  ) {
    const c = this.context(request),
      parent = this.parent(item, c, this.requests.has(request)),
      old = this.store.learningUnits().find((u) => u.id === id),
      isDone = this.remember(request, c, [
        'unit',
        id,
        item.id,
        item.revision,
        previous?.revision ?? null,
        title,
        notes,
        done,
        archived,
      ]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_learning_unit', {
        request,
        entry: id,
        parent: item.id,
        expected_revision: previous?.revision ?? null,
        expected_parent_revision: item.revision,
        unit_title: title,
        unit_notes: notes,
        is_done: done,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (isDone) return;
    if (parent.archived || parent.status === 'paused')
      throw new Error('Restore or resume the learning item before changing lessons.');
    if (parent.revision !== item.revision)
      throw new Error('Learning item changed; refresh and try again.');
    if (old && (old.item_id !== item.id || old.owner_id !== c.user || old.workspace_id !== c.w))
      throw new Error('Lesson is inaccessible.');
    if (old && (!previous || old.revision !== previous.revision))
      throw new Error('Lesson changed; refresh and try again.');
    if (previous && !old) throw new Error('Lesson is inaccessible.');
    if (
      !title.trim() ||
      title.trim().length > 200 ||
      notes.length > 2000 ||
      notes.includes('\0') ||
      typeof done !== 'boolean' ||
      typeof archived !== 'boolean'
    )
      throw new Error('Enter valid lesson details.');
    const position = old?.position ?? Math.max(0, ...this.units(parent).map((u) => u.position)) + 1;
    if (position > 200)
      throw new Error('A learning item supports up to 200 lessons, including archived lessons.');
    const now = new Date().toISOString();
    this.store.learningUnits.update((rows) => [
      {
        id,
        workspace_id: c.w,
        owner_id: c.user,
        visibility: 'private',
        item_id: item.id,
        title: title.trim(),
        notes,
        position,
        done,
        archived,
        revision: old ? old.revision + 1 : 1,
        created_at: old?.created_at ?? now,
        updated_at: now,
      },
      ...rows.filter((u) => u.id !== id),
    ]);
    const p = this.progress(parent),
      status =
        p.total && p.done === p.total
          ? 'completed'
          : p.total > p.done && parent.status === 'completed'
            ? 'active'
            : parent.status;
    this.store.learningItems.update((rows) =>
      rows.map((i) =>
        i.id === item.id
          ? {
              ...i,
              status,
              completed_on: status === 'completed' ? (i.completed_on ?? this.notes.today()) : null,
              revision: i.revision + 1,
              updated_at: now,
            }
          : i,
      ),
    );
    this.finish(request);
  }
  async state(
    request: string,
    item: LearningItem,
    status: LearningItem['status'],
    archived = item.archived,
  ) {
    const c = this.context(request),
      old = this.parent(item, c, this.requests.has(request)),
      done = this.remember(request, c, ['state', item.id, item.revision, status, archived]);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_learning_state', {
        request,
        entry: item.id,
        expected_revision: item.revision,
        target: status,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (old.revision !== item.revision)
      throw new Error('Learning item changed; refresh and try again.');
    if (!['active', 'paused', 'completed'].includes(status) || typeof archived !== 'boolean')
      throw new Error('Choose a valid learning state.');
    if (old.archived && status !== old.status)
      throw new Error('Restore the learning item before changing its state.');
    const p = this.progress(old);
    if (status === 'completed' && p.done < p.total)
      throw new Error('Complete the remaining lessons first.');
    this.store.learningItems.update((rows) =>
      rows.map((i) =>
        i.id === item.id
          ? {
              ...i,
              status,
              archived,
              completed_on: status === 'completed' ? (i.completed_on ?? this.notes.today()) : null,
              revision: i.revision + 1,
              updated_at: new Date().toISOString(),
            }
          : i,
      ),
    );
    this.finish(request);
  }
}
