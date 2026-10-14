import { LearningInput, LearningItem, LearningUnit } from '../../core/models/domain';
import { supportedDate } from './habits';
import { csv } from './finance';
export function validateLearning(input: LearningInput): LearningInput {
  const v = {
    ...input,
    title: input.title.trim(),
    provider: input.provider.trim(),
    url: input.url.trim(),
  };
  if (
    !['course', 'book', 'resource'].includes(v.kind) ||
    !v.title ||
    v.title.length > 200 ||
    v.provider.length > 200 ||
    v.title.includes('\0') ||
    v.provider.includes('\0') ||
    v.goal.length > 1000 ||
    v.notes.length > 4000 ||
    v.notes.includes('\0') ||
    v.goal.includes('\0') ||
    (v.due_on && !supportedDate(v.due_on))
  )
    throw new Error('Enter valid learning details and a supported deadline.');
  if (v.url) {
    try {
      const url = new URL(v.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !url.hostname ||
        /\s/u.test(v.url) ||
        Array.from(v.url).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        url.href.length > 2000
      )
        throw new Error();
      v.url = url.href;
    } catch {
      throw new Error('Use an HTTP/HTTPS resource link without credentials.');
    }
  }
  if (
    v.note_ids.length > 50 ||
    v.document_ids.length + v.certificate_ids.length > 50 ||
    [...v.note_ids, ...v.document_ids, ...v.certificate_ids].some((id) => !id) ||
    v.document_ids.some((id) => v.certificate_ids.includes(id))
  )
    throw new Error('Link up to 50 notes and 50 distinct files with one purpose per file.');
  return {
    ...v,
    note_ids: [...new Set(v.note_ids)].sort(),
    document_ids: [...new Set(v.document_ids)].sort(),
    certificate_ids: [...new Set(v.certificate_ids)].sort(),
  };
}
export function learningProgress(item: LearningItem, units: LearningUnit[]) {
  const active = units.filter((u) => u.item_id === item.id && !u.archived),
    done = active.filter((u) => u.done).length;
  return {
    total: active.length,
    done,
    percent: active.length
      ? Math.round((done / active.length) * 100)
      : item.status === 'completed'
        ? 100
        : 0,
  };
}
export function learningCsv(items: LearningItem[], units: LearningUnit[]) {
  return csv(
    items.map((i) => {
      const p = learningProgress(i, units);
      return {
        title: i.title,
        kind: i.kind,
        provider: i.provider,
        url: i.url,
        goal: i.goal,
        deadline: i.due_on ?? '',
        status: i.status,
        completed_on: i.completed_on ?? '',
        lessons_done: p.done,
        lessons_total: p.total,
        progress_percent: p.percent,
        archived: i.archived,
      };
    }),
  );
}
