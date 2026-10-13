import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Note, Task } from '../models/domain';
import {
  RecordImportLink,
  RecordImportPayload,
  RecordImportResult,
  RecordImportSource,
  matchesNote,
  matchesTask,
  parseRecordJson,
  recordDetails,
  reviewRecordJson,
  validateRecordRow,
} from '../../shared/utilities/record-json-import';
export interface RecordImportRequest {
  id: string;
  workspace: string;
  user: string;
  session: number;
  payload: RecordImportPayload;
}
@Injectable({ providedIn: 'root' })
export class RecordJsonImporter {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private demoLinks: RecordImportLink[] = [];
  private demoBatches = new Map<string, { payload: string; result: RecordImportResult }>();
  private stamp = '';
  context() {
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
  current(c: ReturnType<RecordJsonImporter['context']>) {
    return (
      c.workspace === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  private reset(c: ReturnType<RecordJsonImporter['context']>) {
    const stamp = `${c.user}:${c.session}`;
    if (stamp !== this.stamp) {
      this.demoLinks = [];
      this.demoBatches.clear();
      this.stamp = stamp;
    }
  }
  projects() {
    return this.store
      .projects()
      .filter(
        (p) =>
          p.workspace_id === this.store.workspace()?.id &&
          (p.owner_id === this.store.profile()?.id || p.visibility === 'workspace'),
      );
  }
  async preview(text: string) {
    const c = this.context(),
      source = parseRecordJson(text);
    let links: RecordImportLink[] = [];
    if (this.store.auth.demo()) {
      this.reset(c);
      links = this.demoLinks.filter((l) => l.workspace_id === c.workspace && l.owner_id === c.user);
    } else
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await this.backend
          .requireClient()
          .from('record_json_links')
          .select('*')
          .eq('workspace_id', c.workspace)
          .eq('owner_id', c.user)
          .order('created_at')
          .order('id')
          .range(offset, offset + 499);
        if (error) throw error;
        if (!this.current(c)) throw new Error('Workspace changed; preview again.');
        links.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
    const mapping: Record<string, string> = {};
    for (const p of source.projects) {
      const bound = links.find((l) => l.record_kind === 'project' && l.source_id === p.source_id),
        visible = this.projects(),
        exact = visible.find((t) => t.id === p.source_id),
        named = visible.filter((t) => t.title === p.title);
      mapping[p.source_id] = bound
        ? String(bound.details['target_id'] ?? 'none')
        : (exact?.id ?? (named.length === 1 ? named[0].id : 'choose'));
    }
    return { source, links, mapping, context: c };
  }
  review(source: RecordImportSource, mapping: Record<string, string>, links: RecordImportLink[]) {
    const c = this.context();
    return reviewRecordJson(
      source,
      mapping,
      this.projects(),
      this.store.tasks(),
      this.store.notes(),
      links,
      c.workspace,
      c.user,
    );
  }
  prepare(
    source: RecordImportSource,
    mapping: Record<string, string>,
    links: RecordImportLink[],
    selected: Set<number>,
  ): RecordImportRequest {
    const c = this.context(),
      review = this.review(source, mapping, links),
      rows = review
        .filter((r) => r.state === 'ready' && selected.has(r.index))
        .map((r) => ({ ...r.row! }));
    if (!rows.length) throw new Error('Select at least one valid task or note.');
    const needed = new Set(
      rows.map((r) => r.project_source).filter((v): v is string => v !== null),
    );
    const projects = [...needed].map((source_id) => ({
      source_id,
      target_id: mapping[source_id] === 'none' ? null : mapping[source_id],
    }));
    return { id: crypto.randomUUID(), ...c, payload: { projects, rows } };
  }
  async save(request: RecordImportRequest): Promise<RecordImportResult> {
    if (!this.current(request)) throw new Error('Workspace changed; preview again.');
    if (!this.store.auth.demo()) {
      const { data, error } = await this.backend.requireClient().rpc('import_record_json', {
        entry: request.id,
        w: request.workspace,
        payload: {
          projects: request.payload.projects.map((p) => ({ ...p })),
          rows: request.payload.rows.map((r) => ({ ...r })),
        },
      });
      if (error) throw error;
      if (!data) throw new Error('Import result unavailable; retry this batch.');
      if (this.current(request)) {
        await this.store.switchWorkspace(this.store.workspace()!);
        if (this.current(request) && this.store.error())
          throw new Error('Import saved, but refresh failed. Retry this batch safely.');
      }
      return data;
    }
    this.context();
    this.reset(request);
    const payload = JSON.stringify([request.workspace, request.user, request.payload]),
      old = this.demoBatches.get(request.id);
    if (old) {
      if (old.payload !== payload) throw new Error('Record import request reused.');
      return old.result;
    }
    const { projects, rows } = request.payload;
    if (
      !rows.length ||
      rows.length > 500 ||
      projects.length > 50 ||
      new Set(projects.map((p) => p.source_id)).size !== projects.length ||
      new Set(rows.map((r) => r.kind + ':' + r.source_id)).size !== rows.length
    )
      throw new Error('Check source IDs and batch size.');
    const links = this.demoLinks.filter(
        (l) => l.workspace_id === request.workspace && l.owner_id === request.user,
      ),
      tasks = [...this.store.tasks()],
      notes = [...this.store.notes()],
      targets = new Map<string, string | null>();
    const result = { tasks_imported: 0, notes_imported: 0, skipped: 0 },
      now = new Date().toISOString();
    const base = () => ({
      id: crypto.randomUUID(),
      workspace_id: request.workspace,
      owner_id: request.user,
      created_at: now,
      updated_at: now,
      visibility: 'private' as const,
    });
    for (const p of projects) {
      if (p.target_id && !this.projects().some((t) => t.id === p.target_id))
        throw new Error('Project is inaccessible.');
      const bound = links.find((l) => l.record_kind === 'project' && l.source_id === p.source_id);
      if (bound && (bound.details['target_id'] ?? null) !== p.target_id)
        throw new Error('Project source already has a saved mapping.');
      if (!bound)
        links.push({
          ...base(),
          record_kind: 'project',
          source_id: p.source_id,
          project_id: p.target_id,
          task_id: null,
          note_id: null,
          details: { target_id: p.target_id },
        });
      targets.set(p.source_id, p.target_id);
    }
    for (const r of rows) {
      validateRecordRow(r);
      if (r.project_source && !targets.has(r.project_source))
        throw new Error('Choose a project mapping or explicitly unlink.');
      const project = r.project_source ? targets.get(r.project_source)! : null,
        details = recordDetails(r, project),
        prior = links.find((l) => l.record_kind === r.kind && l.source_id === r.source_id);
      if (prior) {
        if (Object.keys(details).some((k) => details[k] !== prior.details[k]))
          throw new Error('Record source ID contents changed.');
        result.skipped++;
        continue;
      }
      let destination: string;
      if (r.kind === 'task') {
        const owned = tasks.filter(
            (t) =>
              t.workspace_id === request.workspace &&
              t.owner_id === request.user &&
              t.visibility === 'private',
          ),
          original = owned.find((t) => t.id === r.source_id);
        if (original && !matchesTask(original, r, project))
          throw new Error('Existing task source ID identifies different content or structure.');
        const match = owned.find((t) => matchesTask(t, r, project));
        if (match) {
          destination = match.id;
          result.skipped++;
        } else {
          const task: Task = {
            ...base(),
            title: r.title,
            status: r.status!,
            priority: r.priority!,
            due_date: r.due_date,
            project_id: project,
            revision: 1,
            list_id: null,
            series_id: null,
            occurrence_index: null,
            assignee_id: null,
          };
          tasks.push(task);
          destination = task.id;
          result.tasks_imported++;
        }
      } else {
        const owned = notes.filter(
            (n) =>
              n.workspace_id === request.workspace &&
              n.owner_id === request.user &&
              n.visibility === 'private',
          ),
          original = owned.find((n) => n.id === r.source_id);
        if (original && !matchesNote(original, r, project))
          throw new Error('Existing note source ID identifies different content.');
        const match = owned.find((n) => matchesNote(n, r, project));
        if (match) {
          destination = match.id;
          result.skipped++;
        } else {
          const note: Note = { ...base(), title: r.title, body: r.body!, project_id: project };
          notes.push(note);
          destination = note.id;
          result.notes_imported++;
        }
      }
      links.push({
        ...base(),
        record_kind: r.kind,
        source_id: r.source_id,
        project_id: null,
        task_id: r.kind === 'task' ? destination : null,
        note_id: r.kind === 'note' ? destination : null,
        details,
      });
    }
    this.store.tasks.set(tasks);
    this.store.notes.set(notes);
    this.demoLinks = [
      ...this.demoLinks.filter(
        (l) => l.workspace_id !== request.workspace || l.owner_id !== request.user,
      ),
      ...links,
    ];
    this.demoBatches.set(request.id, { payload, result });
    return result;
  }
}
