import { CalendarEvent, Note, Project, Task } from '../../core/models/domain';
import { validLoanDate } from './loans';
export const recordJsonMaxBytes = 5 * 1024 * 1024;
export interface RecordImportRow {
  kind: 'task' | 'note' | 'event';
  source_id: string;
  project_source: string | null;
  title: string;
  status: Task['status'] | null;
  priority: Task['priority'] | null;
  due_date: string | null;
  body: string | null;
  starts_at?: string;
  ends_at?: string;
  location?: string;
  color?: string;
}
export interface RecordImportCandidate {
  index: number;
  row: RecordImportRow | null;
  kind: RecordImportRow['kind'];
  title: string;
  error: string;
  warnings: string[];
}
export interface RecordSourceProject {
  source_id: string;
  title: string;
}
export interface RecordImportSource {
  projects: RecordSourceProject[];
  rows: RecordImportCandidate[];
  omitted: string[];
}
export interface RecordImportPayload {
  projects: { source_id: string; target_id: string | null }[];
  rows: RecordImportRow[];
}
export interface RecordImportResult {
  tasks_imported: number;
  notes_imported: number;
  skipped: number;
  events_imported?: number;
}
export interface RecordImportLink {
  id: string;
  workspace_id: string;
  owner_id: string;
  record_kind: 'project' | RecordImportRow['kind'];
  source_id: string;
  project_id: string | null;
  task_id: string | null;
  note_id: string | null;
  event_id?: string | null;
  details: Record<string, unknown>;
  created_at: string;
}
export interface RecordReview extends RecordImportCandidate {
  state: 'ready' | 'duplicate' | 'invalid' | 'unmapped';
  message: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function eventImportTime(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(
      value,
    ) ||
    !validLoanDate(value.slice(0, 10))
  )
    throw new Error('Use a real ISO timestamp with seconds and an explicit Z or timezone offset.');
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) throw new Error('Invalid event time.');
  const canonical = time.toISOString();
  if (canonical < '1900-01-01T00:00:00.000Z' || canonical > '2100-12-31T23:59:59.999Z')
    throw new Error('Event times must be from 1900–2100.');
  return canonical;
}
export function recordSourceId(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 200 || v.includes('\0'))
    throw new Error('Use a unique source ID of 1–200 characters.');
  return v.trim();
}
export function validateRecordRow(row: RecordImportRow) {
  recordSourceId(row.source_id);
  if (row.project_source !== null) recordSourceId(row.project_source);
  if (
    typeof row.title !== 'string' ||
    !row.title.trim() ||
    row.title.trim().length > 200 ||
    row.title.includes('\0')
  )
    throw new Error('Title must contain 1–200 characters.');
  if (row.kind === 'task') {
    if (
      !['todo', 'in_progress', 'done'].includes(row.status ?? '') ||
      !['low', 'medium', 'high'].includes(row.priority ?? '') ||
      row.body !== null
    )
      throw new Error('Check task status and priority.');
    if (
      row.due_date !== null &&
      (!validLoanDate(row.due_date) || row.due_date < '1900-01-01' || row.due_date > '2100-12-31')
    )
      throw new Error('Use a real YYYY-MM-DD due date from 1900–2100 or null.');
  } else if (row.kind === 'note') {
    if (
      typeof row.body !== 'string' ||
      row.body.length > 100000 ||
      row.body.includes('\0') ||
      row.status !== null ||
      row.priority !== null ||
      row.due_date !== null
    )
      throw new Error('Note content must be text of at most 100,000 characters.');
  } else if (row.kind === 'event') {
    const start = eventImportTime(row.starts_at),
      end = eventImportTime(row.ends_at);
    if (end <= start) throw new Error('Event end must be later than its start.');
    if (
      typeof row.location !== 'string' ||
      row.location.length > 2000 ||
      row.location.includes('\0')
    )
      throw new Error('Location must be text of at most 2,000 characters.');
    if (
      !['purple', 'green', 'orange', 'blue'].includes(row.color ?? '') ||
      [row.status, row.priority, row.due_date, row.body].some((v) => v !== null)
    )
      throw new Error('Check event color and fields.');
  } else throw new Error('Choose task, note or event.');
}
export function parseRecordJson(text: string, calendar = false): RecordImportSource {
  if (new TextEncoder().encode(text).length > recordJsonMaxBytes)
    throw new Error('Choose a UTF-8 JSON file no larger than 5 MiB.');
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (
    !object(root) ||
    (calendar
      ? !Array.isArray(root['events'])
      : !Array.isArray(root['tasks']) && !Array.isArray(root['notes']))
  )
    throw new Error(
      calendar
        ? 'Use a LifeOS export with an events array.'
        : 'Use a LifeOS export with tasks or notes arrays.',
    );
  for (const key of calendar ? ['events', 'projects'] : ['tasks', 'notes', 'projects'])
    if (root[key] !== undefined && !Array.isArray(root[key]))
      throw new Error(`${key} must be an array.`);
  const tasks = (root['tasks'] ?? []) as unknown[],
    notes = (root['notes'] ?? []) as unknown[];
  const events = (root['events'] ?? []) as unknown[];
  const count = calendar ? events.length : tasks.length + notes.length;
  if (count < 1 || count > 500)
    throw new Error(
      calendar ? 'Import 1–500 calendar events.' : 'Import 1–500 tasks and notes combined.',
    );
  const sourceProjects = (root['projects'] ?? []) as unknown[];
  const projects = new Map<string, RecordSourceProject>(),
    ids = new Set<string>();
  const rows: RecordImportCandidate[] = [];
  const groups: [RecordImportRow['kind'], unknown[]][] = calendar
    ? [['event', events]]
    : [
        ['task', tasks],
        ['note', notes],
      ];
  for (const [kind, records] of groups)
    for (const v of records) {
      if (!object(v)) throw new Error('Each record must be an object.');
      const id = recordSourceId(v['id']),
        key = kind + ':' + id;
      if (ids.has(key)) throw new Error(`Duplicate ${kind} source ID; correct the file.`);
      ids.add(key);
      const candidate: RecordImportCandidate = {
        index: rows.length,
        row: null,
        kind,
        title: typeof v['title'] === 'string' ? v['title'].trim() : '',
        error: '',
        warnings: [],
      };
      try {
        const source =
          v['project_id'] == null || v['project_id'] === ''
            ? null
            : recordSourceId(v['project_id']);
        if (source) {
          const matches = sourceProjects.filter((p) => object(p) && p['id'] === source);
          if (matches.length > 1) throw new Error('Duplicate referenced project source ID.');
          const raw = matches[0],
            title =
              object(raw) && typeof raw['title'] === 'string'
                ? raw['title'].trim().slice(0, 200)
                : `Project ${source}`;
          projects.set(source, { source_id: source, title });
        }
        const row: RecordImportRow = {
          kind,
          source_id: id,
          project_source: source,
          title: candidate.title,
          status: kind === 'task' ? (v['status'] as Task['status']) : null,
          priority: kind === 'task' ? (v['priority'] as Task['priority']) : null,
          due_date:
            kind === 'task'
              ? v['due_date'] == null || v['due_date'] === ''
                ? null
                : (v['due_date'] as string)
              : null,
          body: kind === 'note' ? (v['body'] as string) : null,
        };
        if (kind === 'event') {
          row.starts_at = eventImportTime(v['starts_at']);
          row.ends_at = eventImportTime(v['ends_at']);
          row.location = v['location'] === undefined ? '' : (v['location'] as string);
          row.color = v['color'] === undefined ? 'purple' : (v['color'] as string);
          if (
            ['recurrence', 'rrule', 'series_id', 'attendees', 'task_ids', 'expense_ids'].some(
              (k) => v[k] != null && v[k] !== '',
            )
          )
            candidate.warnings.push(
              'Imported as a single event; recurrence, guests and task/expense links are not restored.',
            );
        }
        validateRecordRow(row);
        candidate.row = row;
        if (v['visibility'] === 'workspace')
          candidate.warnings.push('Imported as private; sharing is not restored.');
        if (
          kind === 'task' &&
          ['list_id', 'series_id', 'assignee_id'].some((k) => v[k] != null && v[k] !== '')
        )
          candidate.warnings.push(
            'Imported as standalone and unassigned; list and recurrence links are omitted.',
          );
      } catch (e) {
        candidate.error = (e as Error).message;
      }
      rows.push(candidate);
    }
  if (projects.size > 50) throw new Error('Map at most 50 referenced projects per file.');
  const omitted = Object.entries(root)
    .filter(
      ([key, value]) =>
        !(
          calendar
            ? ['events', 'projects', 'workspace']
            : ['tasks', 'notes', 'projects', 'workspace']
        ).includes(key) &&
        ((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value != null)),
    )
    .map(([key]) => key);
  return { projects: [...projects.values()], rows, omitted };
}
export function recordDetails(
  row: RecordImportRow,
  project: string | null,
): Record<string, unknown> {
  if (row.kind === 'event')
    return {
      project_source: row.project_source,
      project_id: project,
      title: row.title,
      starts_at: eventImportTime(row.starts_at),
      ends_at: eventImportTime(row.ends_at),
      location: row.location,
      color: row.color,
    };
  return {
    project_source: row.project_source,
    project_id: project,
    title: row.title,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    body: row.body,
  };
}
export function matchesTask(t: Task, row: RecordImportRow, project: string | null) {
  return (
    t.visibility === 'private' &&
    t.list_id == null &&
    t.series_id == null &&
    t.assignee_id == null &&
    t.title.trim() === row.title &&
    t.status === row.status &&
    t.priority === row.priority &&
    t.due_date === row.due_date &&
    t.project_id === project
  );
}
export function matchesNote(n: Note, row: RecordImportRow, project: string | null) {
  return (
    n.visibility === 'private' &&
    n.title.trim() === row.title &&
    n.body === row.body &&
    n.project_id === project
  );
}
export function matchesEvent(e: CalendarEvent, row: RecordImportRow, project: string | null) {
  return (
    e.visibility === 'private' &&
    e.title.trim() === row.title &&
    new Date(e.starts_at).toISOString() === row.starts_at &&
    new Date(e.ends_at).toISOString() === row.ends_at &&
    e.location === row.location &&
    e.color === row.color &&
    e.project_id === project
  );
}
export function reviewRecordJson(
  source: RecordImportSource,
  mapping: Record<string, string>,
  projects: Project[],
  tasks: Task[],
  notes: Note[],
  links: RecordImportLink[],
  workspace: string,
  user: string,
  events: CalendarEvent[] = [],
): RecordReview[] {
  const seen = new Set<string>();
  return source.rows.map((candidate): RecordReview => {
    if (!candidate.row) return { ...candidate, state: 'invalid', message: candidate.error };
    const r = candidate.row,
      target = r.project_source ? mapping[r.project_source] : 'none';
    if (!target || target === 'choose')
      return {
        ...candidate,
        state: 'unmapped',
        message: 'Choose an accessible project or explicitly leave unlinked.',
      };
    const project = target === 'none' ? null : target;
    if (
      project &&
      !projects.some(
        (p) =>
          p.id === project &&
          p.workspace_id === workspace &&
          (p.owner_id === user || p.visibility === 'workspace'),
      )
    )
      return { ...candidate, state: 'invalid', message: 'Destination project is inaccessible.' };
    const bound = r.project_source
      ? links.find((l) => l.record_kind === 'project' && l.source_id === r.project_source)
      : null;
    if (bound && (bound.details['target_id'] ?? null) !== project)
      return {
        ...candidate,
        state: 'invalid',
        message: 'This project source already has a saved mapping.',
      };
    const details = recordDetails(r, project),
      prior = links.find((l) => l.record_kind === r.kind && l.source_id === r.source_id);
    if (prior) {
      const same = Object.keys(details).every((k) => details[k] === prior.details[k]);
      return {
        ...candidate,
        state: same ? 'duplicate' : 'invalid',
        message: same
          ? 'Previously imported; existing edits or deletions are kept.'
          : 'Source ID contents changed; edit the destination separately.',
      };
    }
    const ownedTasks = tasks.filter(
        (t) => t.workspace_id === workspace && t.owner_id === user && t.visibility === 'private',
      ),
      ownedNotes = notes.filter(
        (n) => n.workspace_id === workspace && n.owner_id === user && n.visibility === 'private',
      ),
      ownedEvents = events.filter(
        (e) => e.workspace_id === workspace && e.owner_id === user && e.visibility === 'private',
      );
    const original =
      r.kind === 'task'
        ? ownedTasks.find((t) => t.id === r.source_id)
        : r.kind === 'note'
          ? ownedNotes.find((n) => n.id === r.source_id)
          : ownedEvents.find((e) => e.id === r.source_id);
    if (
      original &&
      !(r.kind === 'task'
        ? matchesTask(original as Task, r, project)
        : r.kind === 'note'
          ? matchesNote(original as Note, r, project)
          : matchesEvent(original as CalendarEvent, r, project))
    )
      return {
        ...candidate,
        state: 'invalid',
        message: 'Existing source ID identifies different content or task structure.',
      };
    const key = JSON.stringify([r.kind, details]);
    const duplicate =
      seen.has(key) ||
      (r.kind === 'task'
        ? ownedTasks.some((t) => matchesTask(t, r, project))
        : r.kind === 'note'
          ? ownedNotes.some((n) => matchesNote(n, r, project))
          : ownedEvents.some((e) => matchesEvent(e, r, project)));
    seen.add(key);
    return {
      ...candidate,
      state: duplicate ? 'duplicate' : 'ready',
      message: duplicate ? 'Matching private record; skipped.' : '',
    };
  });
}
