import { LearningItem, LearningUnit } from '../../core/models/domain';
import { validateLearning } from './learning';
import { supportedDate } from './habits';
import { recordSourceId } from './record-json-import';
export const learningImportMaxBytes = 5 * 1024 * 1024;
export interface LearningImportRow {
  source_id: string;
  kind: LearningItem['kind'];
  title: string;
  provider: string;
  url: string;
  goal: string;
  due_on: string | null;
  notes: string;
  status: LearningItem['status'];
  completed_on: string | null;
  archived: boolean;
  units: Pick<LearningUnit, 'position' | 'title' | 'notes' | 'done' | 'archived'>[];
}
export interface LearningImportCandidate {
  index: number;
  title: string;
  row: LearningImportRow | null;
  error: string;
}
export interface LearningImportReview {
  source_id: string;
  state: 'ready' | 'duplicate' | 'invalid';
  message: string;
}
export interface LearningImportResult {
  items_imported: number;
  lessons_imported: number;
  skipped: number;
}
export interface LearningImportSource {
  rows: LearningImportCandidate[];
  omitted: string[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, optional = false) {
  if (optional && (v === null || v === undefined)) return '';
  if (typeof v !== 'string' || v.includes('\0')) throw new Error('Use plain text fields.');
  return v;
}
export function validateLearningImportRow(
  row: LearningImportRow,
  today: string,
): LearningImportRow {
  const source_id = recordSourceId(row.source_id),
    v = validateLearning({
      ...row,
      due_on: row.due_on ?? '',
      note_ids: [],
      document_ids: [],
      certificate_ids: [],
    });
  if (
    !['active', 'paused', 'completed'].includes(row.status) ||
    typeof row.archived !== 'boolean' ||
    (row.status === 'completed'
      ? !row.completed_on || !supportedDate(row.completed_on) || row.completed_on > today
      : row.completed_on !== null)
  )
    throw new Error(
      'Completed learning needs a real completion date no later than today; other statuses must have no completion date.',
    );
  if (
    !Array.isArray(row.units) ||
    row.units.length > 200 ||
    new Set(row.units.map((u) => u.position)).size !== row.units.length
  )
    throw new Error('Use up to 200 lessons with unique positions.');
  const units = row.units
    .map((u) => {
      if (
        !Number.isInteger(u.position) ||
        u.position < 1 ||
        u.position > 200 ||
        typeof u.title !== 'string' ||
        !u.title.trim() ||
        u.title.trim().length > 200 ||
        u.title.includes('\0') ||
        typeof u.notes !== 'string' ||
        u.notes.length > 2000 ||
        u.notes.includes('\0') ||
        typeof u.done !== 'boolean' ||
        typeof u.archived !== 'boolean'
      )
        throw new Error('Check lesson titles, notes, positions and completion/archive flags.');
      return {
        position: u.position,
        title: u.title.trim(),
        notes: u.notes,
        done: u.done,
        archived: u.archived,
      };
    })
    .sort((a, b) => a.position - b.position);
  if (row.status === 'completed' && units.some((u) => !u.archived && !u.done))
    throw new Error('Completed learning cannot contain unfinished current lessons.');
  return {
    source_id,
    kind: v.kind,
    title: v.title,
    provider: v.provider,
    url: v.url,
    goal: v.goal,
    due_on: v.due_on || null,
    notes: v.notes,
    status: row.status,
    completed_on: row.completed_on,
    archived: row.archived,
    units,
  };
}
export function parseLearningImport(textValue: string, today: string): LearningImportSource {
  if (new TextEncoder().encode(textValue).length > learningImportMaxBytes)
    throw new Error('Choose a UTF-8 JSON file no larger than 5 MiB.');
  let root: unknown;
  try {
    root = JSON.parse(textValue.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (
    !object(root) ||
    !Array.isArray(root['learningItems']) ||
    root['learningItems'].length < 1 ||
    root['learningItems'].length > 200
  )
    throw new Error('Use a learningItems array with 1–200 records.');
  if (root['learningUnits'] !== undefined && !Array.isArray(root['learningUnits']))
    throw new Error('learningUnits must be an array.');
  const allUnits = (root['learningUnits'] ?? []) as unknown[];
  if (allUnits.length > 500) throw new Error('Import up to 500 lessons in total.');
  const ids = new Map<string, number>();
  const referenced = new Set<string>();
  for (const item of root['learningItems']) {
    if (object(item) && typeof item['id'] === 'string' && item['id'].trim()) {
      const id = item['id'].trim();
      referenced.add(id);
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
  }
  const rows = root['learningItems'].map((item, index) => {
    let title = `Learning item ${index + 1}`;
    try {
      if (!object(item)) throw new Error('Learning item must be an object.');
      title = text(item['title']);
      const source_id = recordSourceId(item['id']);
      if ((ids.get(source_id) ?? 0) > 1) throw new Error('Source learning IDs must be unique.');
      const units = allUnits
        .filter(
          (u) => object(u) && typeof u['item_id'] === 'string' && u['item_id'].trim() === source_id,
        )
        .map((u) => {
          if (!object(u)) throw new Error('Lesson must be an object.');
          return {
            position: u['position'] as number,
            title: text(u['title']),
            notes: text(u['notes'], true),
            done: u['done'] as boolean,
            archived: (u['archived'] ?? false) as boolean,
          };
        });
      const row = validateLearningImportRow(
        {
          source_id,
          kind: item['kind'] as LearningItem['kind'],
          title,
          provider: text(item['provider'], true),
          url: text(item['url'], true),
          goal: text(item['goal'], true),
          due_on: (item['due_on'] ?? null) as string | null,
          notes: text(item['notes'], true),
          status: (item['status'] ?? 'active') as LearningItem['status'],
          completed_on: (item['completed_on'] ?? null) as string | null,
          archived: (item['archived'] ?? false) as boolean,
          units,
        },
        today,
      );
      return { index, title: row.title, row, error: '' };
    } catch (e) {
      return {
        index,
        title,
        row: null,
        error: e instanceof Error ? e.message : 'Invalid learning item.',
      };
    }
  });
  if (
    allUnits.some(
      (u) => !object(u) || typeof u['item_id'] !== 'string' || !referenced.has(u['item_id'].trim()),
    )
  )
    throw new Error('Every lesson must refer to an included learning item ID.');
  return {
    rows,
    omitted: Object.keys(root).filter((k) => !['learningItems', 'learningUnits'].includes(k)),
  };
}
export function learningImportTemplate() {
  return JSON.stringify(
    {
      learningItems: [
        {
          id: 'example-course',
          kind: 'course',
          title: 'Replace this course',
          provider: '',
          url: '',
          goal: 'Your learning goal',
          due_on: null,
          notes: '',
          status: 'active',
          completed_on: null,
          archived: false,
        },
      ],
      learningUnits: [
        {
          item_id: 'example-course',
          position: 1,
          title: 'Replace this lesson',
          notes: '',
          done: false,
          archived: false,
        },
      ],
    },
    null,
    2,
  );
}
