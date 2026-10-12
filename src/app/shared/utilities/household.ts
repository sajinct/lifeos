import {
  HouseholdMemberInput,
  HouseholdEntryInput,
  HouseholdMember,
  HouseholdEntry,
} from '../../core/models/domain';
import { validLoanDate } from './loans';
import { csv } from './finance';
export function householdAnniversary(anchor: string, today: string) {
  const month = Number(anchor.slice(5, 7)),
    day = Number(anchor.slice(8, 10));
  const occurrence = (year: number) =>
    `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, new Date(Date.UTC(year, month, 0)).getUTCDate())).padStart(2, '0')}`;
  const year = Number(today.slice(0, 4)),
    current = occurrence(year);
  return current < today ? occurrence(year + 1) : current;
}
export function validateHouseholdMember(v: HouseholdMemberInput): HouseholdMemberInput {
  const r = { ...v, name: v.name.trim(), relationship: v.relationship.trim() };
  if (
    !r.name ||
    r.name.length > 200 ||
    !r.relationship ||
    r.relationship.length > 100 ||
    r.notes.length > 4000 ||
    !['private', 'workspace'].includes(r.visibility)
  )
    throw new Error(
      'Enter a name, relationship and valid sharing choice. Notes support up to 4,000 characters.',
    );
  if (r.birthday && (!/^\d{2}-\d{2}$/.test(r.birthday) || !validLoanDate('2000-' + r.birthday)))
    throw new Error('Choose a valid birthday month and day.');
  return r;
}
export function validateHouseholdEntry(v: HouseholdEntryInput): HouseholdEntryInput {
  const r = { ...v, title: v.title.trim() };
  if (
    !r.title ||
    r.title.length > 200 ||
    r.notes.length > 4000 ||
    !['task', 'date'].includes(r.kind) ||
    !['private', 'workspace'].includes(r.visibility)
  )
    throw new Error(
      'Enter a title and valid sharing choice. Notes support up to 4,000 characters.',
    );
  if (
    (r.kind === 'date' && !r.due_on) ||
    (r.due_on && !validLoanDate(r.due_on)) ||
    (r.annual && (r.kind !== 'date' || !r.due_on))
  )
    throw new Error('Choose a valid date. Only important dates can repeat yearly.');
  return r;
}
export function householdCsv(
  members: HouseholdMember[],
  entries: HouseholdEntry[],
  names: HouseholdMember[],
) {
  return csv([
    ...members.map((m) => ({
      id: m.id,
      type: 'Member',
      title: m.name,
      relationship: m.relationship,
      birthday: m.birthday ?? '',
      date: '',
      yearly: !!m.birthday,
      member: '',
      notes: m.notes,
      status: m.status,
      visibility: m.visibility,
    })),
    ...entries.map((e) => ({
      id: e.id,
      type: e.kind === 'task' ? 'Responsibility' : 'Important date',
      title: e.title,
      relationship: '',
      birthday: '',
      date: e.due_on ?? '',
      yearly: e.annual,
      member: names.find((m) => m.id === e.member_id)?.name ?? e.member_id ?? '',
      notes: e.notes,
      status: e.status,
      visibility: e.visibility,
    })),
  ]);
}
