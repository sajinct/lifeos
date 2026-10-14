import { Note, NoteInput } from '../../core/models/domain';
import { supportedDate } from './habits';
export function normalizeNoteTags(tags: string[]) {
  if (
    !Array.isArray(tags) ||
    tags.length > 10 ||
    tags.some(
      (t) =>
        typeof t !== 'string' ||
        !t.trim() ||
        t.trim().length > 30 ||
        Array.from(t).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    )
  )
    throw new Error('Use up to ten tags of 1–30 characters.');
  return [...new Set(tags.map((t) => t.trim().replace(/\s+/gu, ' ').toLowerCase()))].sort();
}
export function noteTags(text: string) {
  return text.trim() ? normalizeNoteTags(text.split(',')) : [];
}
export function validateNote(input: NoteInput): NoteInput {
  if (
    !input.title.trim() ||
    input.title.trim().length > 200 ||
    input.body.length > 100000 ||
    input.body.includes('\0') ||
    !['private', 'workspace'].includes(input.visibility) ||
    (input.journal_on && (!supportedDate(input.journal_on) || input.visibility !== 'private'))
  )
    throw new Error('Enter valid note details; journals must be private.');
  if (
    input.documents !== null &&
    (!Array.isArray(input.documents) ||
      input.documents.length > 50 ||
      input.documents.some((id) => !id))
  )
    throw new Error('Link at most 50 documents.');
  return {
    ...input,
    title: input.title.trim(),
    tags: normalizeNoteTags(input.tags),
    documents: input.documents === null ? null : [...new Set(input.documents)].sort(),
  };
}
export function matchesNoteSearch(note: Note, query: string) {
  const text = [note.title, note.body, note.journal_on ?? '', ...(note.tags ?? [])]
    .join(' ')
    .toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .every((term) => text.includes(term));
}
