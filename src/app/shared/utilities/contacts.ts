import { Contact, ContactInput, ContactLink, Loan, Project } from '../../core/models/domain';
import { validLoanDate } from './loans';
import { csv } from './finance';
export function validateContact(v: ContactInput, today: string): ContactInput {
  const r = {
    ...v,
    name: v.name.trim(),
    organization: v.organization.trim(),
    category: v.category.trim(),
    email: v.email.trim(),
    phone: v.phone.trim(),
    website: v.website.trim(),
    project_ids: [...new Set(v.project_ids)],
    loan_ids: [...new Set(v.loan_ids)],
  };
  if (
    !r.name ||
    r.name.length > 200 ||
    !['person', 'organization'].includes(r.kind) ||
    !r.category ||
    r.category.length > 100 ||
    r.organization.length > 200
  )
    throw new Error('Enter a name, contact type and category.');
  if (r.email && (r.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)))
    throw new Error('Enter a valid email address.');
  if (r.phone.length > 50 || (r.phone && !/^[+0-9(). xX-]+$/.test(r.phone)))
    throw new Error('Use a phone number with digits, country code and optional extension.');
  if (r.website) {
    let url: URL;
    try {
      url = new URL(r.website);
    } catch {
      throw new Error('Use a valid HTTPS website.');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      /\s/.test(r.website) ||
      !/^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][^\s]*)?$/.test(
        r.website,
      )
    )
      throw new Error('Use an HTTPS website without credentials.');
  }
  if (
    r.website.length > 500 ||
    r.address.length > 500 ||
    r.notes.length > 4000 ||
    r.follow_up_note.length > 500 ||
    r.project_ids.length > 50 ||
    r.loan_ids.length > 50
  )
    throw new Error('Shorten the contact details or choose at most 50 links of each type.');
  for (const date of [r.next_follow_up, r.last_contacted_on])
    if (date && (!validLoanDate(date) || date < '1900-01-01' || date > '2100-12-31'))
      throw new Error('Choose valid contact dates between 1900 and 2100.');
  if (r.last_contacted_on > today) throw new Error('Last contacted date must be today or earlier.');
  return r;
}
export function contactsCsv(
  rows: Contact[],
  links: ContactLink[],
  projects: Project[],
  loans: Loan[],
) {
  return csv(
    rows.map((c) => ({
      id: c.id,
      type: c.kind,
      name: c.name,
      organization: c.organization,
      category: c.category,
      email: c.email,
      phone: c.phone,
      website: c.website,
      address: c.address,
      notes: c.notes,
      status: c.status,
      next_follow_up: c.next_follow_up,
      follow_up_note: c.follow_up_note,
      last_contacted_on: c.last_contacted_on,
      projects: links
        .filter((l) => l.contact_id === c.id && l.project_id)
        .map((l) => projects.find((p) => p.id === l.project_id)?.title ?? l.project_id)
        .join(' | '),
      loans: links
        .filter((l) => l.contact_id === c.id && l.loan_id)
        .map((l) => loans.find((p) => p.id === l.loan_id)?.title ?? l.loan_id)
        .join(' | '),
    })),
  );
}
