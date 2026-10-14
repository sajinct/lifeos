import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Note, NoteInput, Attachment } from '../models/domain';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { validateNote } from '../../shared/utilities/notes';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class NotesLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly loadedDocuments = signal<Attachment[]>([]);
  private readonly requests = new Map<
    string,
    { w: string; user: string; session: number; payload: string; done: boolean }
  >();
  private requestSession = -1;
  private syncRequests() {
    const session = this.store.fileSession();
    if (session !== this.requestSession) {
      this.requests.clear();
      this.requestSession = session;
    }
  }
  readonly documents = computed(() =>
    [
      ...new Map(
        [...this.loadedDocuments(), ...this.store.attachments()]
          .filter(
            (f) =>
              f.workspace_id === this.store.workspace()?.id &&
              f.owner_id === this.store.profile()?.id &&
              ['ready', 'archived'].includes(f.status),
          )
          .map((f) => [f.id, f]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name) || b.version_number - a.version_number),
  );
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.syncRequests();
    });
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.loadedDocuments.set([]);
    });
  }
  today() {
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  }
  private stamp() {
    return {
      w: this.store.workspace()?.id,
      user: this.store.profile()?.id,
      session: this.store.fileSession(),
    };
  }
  private current(c: ReturnType<NotesLibrary['stamp']>) {
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
      retry = !this.store.auth.demo() && old && this.current(old) && old.w === c.w;
    if (
      !c.w ||
      !c.user ||
      (!this.store.writable() && !retry) ||
      (!this.store.auth.demo() && c.user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { ...c, w: c.w, user: c.user };
  }
  private remember(request: string, c: ReturnType<NotesLibrary['context']>, payload: unknown) {
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
  private async reload(c: ReturnType<NotesLibrary['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error())
      throw new Error('Note saved, but refresh failed. Retry this change safely.');
  }
  async loadDocuments() {
    const c = this.stamp();
    if (!c.w || !c.user || this.store.auth.demo()) return;
    const docs: Attachment[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await this.backend
        .requireClient()
        .from('attachments')
        .select('*')
        .eq('workspace_id', c.w)
        .eq('owner_id', c.user)
        .in('status', ['ready', 'archived'])
        .order('created_at')
        .order('id')
        .range(offset, offset + 499);
      if (error) throw error;
      if (!this.current(c)) return;
      docs.push(...data);
      if (data.length < 500) break;
    }
    if (this.current(c)) this.loadedDocuments.set(docs);
  }
  private parent(previous: Note, c: ReturnType<NotesLibrary['context']>, retry: boolean) {
    const old = this.store.notes().find((n) => n.id === previous.id);
    if (!this.store.auth.demo() && retry && previous.workspace_id === c.w) return old ?? previous;
    if (!old || old.workspace_id !== c.w || !this.store.canEdit(old))
      throw new Error('Note is inaccessible.');
    return old;
  }
  async save(request: string, id: string, input: NoteInput, previous?: Note) {
    const c = this.context(request),
      v = validateNote(input),
      retry = this.requests.has(request),
      old = previous
        ? this.parent(previous, c, retry)
        : this.store.notes().find((n) => n.id === id);
    const payload = ['save', id, previous?.revision ?? (previous ? 1 : null), v];
    if (this.store.auth.demo() || !retry) {
      if (
        v.project &&
        !this.store
          .projects()
          .some(
            (p) =>
              p.id === v.project &&
              p.workspace_id === c.w &&
              (v.visibility === 'private' || p.visibility === 'workspace'),
          )
      )
        throw new Error('Project is inaccessible or private.');
      if (
        previous &&
        old?.owner_id !== c.user &&
        (v.visibility !== old?.visibility ||
          v.journal_on !== (old?.journal_on ?? '') ||
          v.documents !== null)
      )
        throw new Error('Only the note creator can change sharing, journals or documents.');
      if (v.documents?.some((id) => !this.documents().some((f) => f.id === id)))
        throw new Error('Choose your own completed document in this workspace.');
    }
    const done = this.remember(request, c, payload);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_note', {
        request,
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? (previous ? 1 : null),
        note_title: v.title,
        note_body: v.body,
        linked_project: v.project || null,
        note_tags: v.tags,
        journal_date: v.journal_on || null,
        sharing: v.visibility,
        documents: v.documents,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if (old && (!previous || (old.revision ?? 1) !== (previous.revision ?? 1)))
      throw new Error('Note changed; refresh and try again.');
    if (previous && !old) throw new Error('Note is inaccessible.');
    if (old?.archived) throw new Error('Restore the note before editing.');
    if (
      v.journal_on &&
      this.store
        .notes()
        .some(
          (n) =>
            n.id !== id &&
            n.workspace_id === c.w &&
            n.owner_id === (old?.owner_id ?? c.user) &&
            n.journal_on === v.journal_on,
        )
    )
      throw new Error('A journal for this date already exists, including archived entries.');
    const time = new Date().toISOString(),
      base = {
        workspace_id: c.w,
        owner_id: old?.owner_id ?? c.user,
        visibility: v.visibility,
        created_at: old?.created_at ?? time,
        updated_at: time,
      };
    this.store.notes.update((rows) => [
      {
        ...base,
        id,
        title: v.title,
        body: v.body,
        project_id: v.project || null,
        tags: v.tags,
        journal_on: v.journal_on || null,
        archived: false,
        revision: old ? (old.revision ?? 1) + 1 : 1,
      },
      ...rows.filter((n) => n.id !== id),
    ]);
    if (v.documents !== null)
      this.store.noteDocuments.update((links) => [
        ...links.filter((l) => l.note_id !== id || v.documents!.includes(l.attachment_id)),
        ...v
          .documents!.filter((f) => !links.some((l) => l.note_id === id && l.attachment_id === f))
          .map((attachment_id) => ({
            ...base,
            id: crypto.randomUUID(),
            visibility: 'private' as const,
            note_id: id,
            attachment_id,
          })),
      ]);
    this.finish(request);
  }
  async archive(request: string, note: Note, archived: boolean) {
    const c = this.context(request),
      old = this.parent(note, c, this.requests.has(request)),
      payload = ['archive', note.id, note.revision ?? 1, archived],
      done = this.remember(request, c, payload);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_note_archived', {
        request,
        entry: note.id,
        expected_revision: note.revision ?? 1,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (done) return;
    if ((old.revision ?? 1) !== (note.revision ?? 1))
      throw new Error('Note changed; refresh and try again.');
    this.store.notes.update((rows) =>
      rows.map((n) =>
        n.id === old.id
          ? {
              ...n,
              archived,
              revision: (n.revision ?? 1) + 1,
              updated_at: new Date().toISOString(),
            }
          : n,
      ),
    );
    this.finish(request);
  }
  links(note: Note) {
    return this.store
      .noteDocuments()
      .filter((l) => l.note_id === note.id)
      .map((l) => this.documents().find((f) => f.id === l.attachment_id))
      .filter((f): f is Attachment => !!f);
  }
}
