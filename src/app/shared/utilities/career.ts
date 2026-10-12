import { CareerInput, CareerRecord, CareerDocument, Attachment } from '../../core/models/domain';
import { validLoanDate } from './loans';
import { csv } from './finance';
export const CAREER_STATUSES: Record<CareerRecord['kind'], CareerRecord['status'][]> = {
  employment: ['active', 'archived'],
  application: ['applied', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'archived'],
  certification: ['active', 'archived'],
};
export const CAREER_DATES = [
  'starts_on',
  'ends_on',
  'applied_on',
  'interview_on',
  'follow_up_on',
  'expires_on',
] as const;
export function emptyCareer(kind: CareerRecord['kind'], today: string): CareerInput {
  return {
    kind,
    title: '',
    organization: '',
    location: '',
    skills: '',
    url: '',
    notes: '',
    status: kind === 'application' ? 'applied' : 'active',
    starts_on: kind === 'employment' ? today : '',
    ends_on: '',
    applied_on: kind === 'application' ? today : '',
    interview_on: '',
    follow_up_on: '',
    expires_on: '',
    document_ids: [],
  };
}
export function validateCareer(input: CareerInput, today: string) {
  const v = {
    ...input,
    title: input.title.trim(),
    organization: input.organization.trim(),
    location: input.location.trim(),
    skills: input.skills.trim(),
    url: input.url.trim(),
    document_ids: [...new Set(input.document_ids)],
  };
  if (
    !CAREER_STATUSES[v.kind]?.includes(v.status) ||
    !v.title ||
    v.title.length > 200 ||
    !v.organization ||
    v.organization.length > 200 ||
    v.location.length > 200 ||
    v.skills.length > 2000 ||
    v.notes.length > 4000 ||
    v.url.length > 2000 ||
    (v.url && !/^https?:\/\/[^\s]+$/.test(v.url)) ||
    v.document_ids.length > 50
  )
    throw new Error(
      'Check the title, organization, status and details. Use an HTTP or HTTPS link and up to 50 documents.',
    );
  for (const key of CAREER_DATES)
    if (v[key] && (!validLoanDate(v[key]) || v[key] < '1900-01-01' || v[key] > '2100-12-31'))
      throw new Error('Use valid dates between 1900 and 2100.');
  if (
    v.kind === 'employment' &&
    (!v.starts_on ||
      v.starts_on > today ||
      (v.ends_on && (v.ends_on < v.starts_on || v.ends_on > today)) ||
      v.applied_on ||
      v.interview_on ||
      v.follow_up_on ||
      v.expires_on)
  )
    throw new Error(
      'Employment needs a start date today or earlier; its end date must follow the start and be today or earlier.',
    );
  if (
    v.kind === 'application' &&
    (!v.applied_on ||
      v.applied_on > today ||
      (v.interview_on && v.interview_on < v.applied_on) ||
      (v.follow_up_on && v.follow_up_on < v.applied_on) ||
      v.starts_on ||
      v.ends_on ||
      v.expires_on)
  )
    throw new Error(
      'Application date must be today or earlier. Interviews and follow-ups must follow the application date.',
    );
  if (
    v.kind === 'certification' &&
    ((v.starts_on && v.starts_on > today) ||
      (v.starts_on && v.expires_on && v.expires_on < v.starts_on) ||
      v.ends_on ||
      v.applied_on ||
      v.interview_on ||
      v.follow_up_on)
  )
    throw new Error('Issue date must be today or earlier, and expiry must follow issue.');
  return v;
}
export function careerDetails(v: CareerInput): { [key: string]: string | null } {
  const { document_ids, ...fields } = v;
  void document_ids;
  return { ...fields, ...Object.fromEntries(CAREER_DATES.map((k) => [k, v[k] || null])) };
}
export function careerCsv(rows: CareerRecord[], links: CareerDocument[], files: Attachment[]) {
  return csv(
    rows.map((r) => ({
      id: r.id,
      section: r.kind,
      title: r.title,
      organization: r.organization,
      location: r.location,
      skills: r.skills,
      status: r.status,
      starts_on: r.starts_on,
      ends_on: r.ends_on,
      applied_on: r.applied_on,
      interview_on: r.interview_on,
      follow_up_on: r.follow_up_on,
      expires_on: r.expires_on,
      url: r.url,
      notes: r.notes,
      documents: links
        .filter((l) => l.record_id === r.id)
        .map((l) => files.find((f) => f.id === l.attachment_id)?.name ?? l.attachment_id)
        .join('; '),
    })),
  );
}
