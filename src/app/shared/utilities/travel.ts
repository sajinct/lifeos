import {
  TravelPlan,
  TravelPlanInput,
  TravelEntry,
  TravelEntryInput,
  TravelBudget,
  TravelExpense,
  Transaction,
  Account,
} from '../../core/models/domain';
import { supportedDate } from './habits';
import { csv, cents } from './finance';
export const TRAVEL_STATUSES = {
  itinerary: ['scheduled', 'done', 'cancelled'],
  booking: ['planned', 'confirmed', 'cancelled'],
  checklist: ['todo', 'done'],
  guest: ['invited', 'accepted', 'declined', 'tentative'],
} as const;
export function travelAmount(value: string, allowZero = false) {
  if (
    !/^\d+(\.\d{1,2})?$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) >= 1e12 ||
    Number(value) < 0 ||
    (!allowZero && Number(value) === 0)
  )
    throw new Error('Use an amount below one trillion with up to two decimals.');
  return Number(value);
}
export function validateTravelPlan(input: TravelPlanInput) {
  const v = {
    ...input,
    title: input.title.trim(),
    location: input.location.trim(),
    timezone: input.timezone.trim(),
  };
  if (
    !['trip', 'event'].includes(v.kind) ||
    !v.title ||
    v.title.length > 200 ||
    v.location.length > 300 ||
    v.notes.length > 4000 ||
    !supportedDate(v.starts_on) ||
    !supportedDate(v.ends_on) ||
    v.ends_on < v.starts_on ||
    !['planning', 'active', 'completed', 'cancelled'].includes(v.status)
  )
    throw new Error('Check plan name, dates, status and notes.');
  new Intl.DateTimeFormat('en', { timeZone: v.timezone }).format();
  return v;
}
export function emptyTravelEntry(kind: TravelEntry['kind'], p: TravelPlan): TravelEntryInput {
  return {
    kind,
    title: '',
    date_on: ['itinerary', 'booking'].includes(kind) ? p.starts_on : '',
    end_on: '',
    time_at: '',
    end_time: '',
    location: '',
    reference: '',
    cost: '',
    currency: '',
    email: '',
    phone: '',
    guest_count: kind === 'guest' ? '1' : '',
    status: TRAVEL_STATUSES[kind][0],
    notes: '',
  };
}
export function validateTravelEntry(input: TravelEntryInput, p: TravelPlan) {
  const v = {
    ...input,
    title: input.title.trim(),
    location: input.location.trim(),
    reference: input.reference.trim(),
    email: input.email.trim(),
    phone: input.phone.trim(),
  };
  if (
    !TRAVEL_STATUSES[v.kind]?.includes(v.status as never) ||
    !v.title ||
    v.title.length > 200 ||
    v.location.length > 300 ||
    v.reference.length > 200 ||
    v.email.length > 200 ||
    (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) ||
    v.phone.length > 50 ||
    v.notes.length > 2000
  )
    throw new Error('Check planning title, status and details.');
  for (const time of [v.time_at, v.end_time])
    if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Use valid local times.');
  if (['itinerary', 'booking'].includes(v.kind)) {
    if (
      !supportedDate(v.date_on) ||
      v.date_on < p.starts_on ||
      v.date_on > p.ends_on ||
      (v.end_on && (!supportedDate(v.end_on) || v.end_on < v.date_on || v.end_on > p.ends_on)) ||
      (v.end_time &&
        (!v.time_at || ((v.end_on || v.date_on) === v.date_on && v.end_time < v.time_at))) ||
      v.email ||
      v.phone ||
      v.guest_count
    )
      throw new Error('Keep itinerary and booking dates/times within the plan.');
  } else if (v.date_on || v.end_on || v.time_at || v.end_time || v.location || v.reference)
    throw new Error('Date and booking fields do not belong to this entry.');
  const cost = v.cost ? travelAmount(v.cost, true) : null,
    guest_count = v.guest_count ? Number(v.guest_count) : null;
  if (
    (v.kind !== 'booking' && (cost !== null || v.currency)) ||
    (cost === null ? !!v.currency : !/^[A-Z]{3}$/.test(v.currency))
  )
    throw new Error('Booking costs need a three-letter currency.');
  if (v.kind === 'guest') {
    if (!/^\d+$/.test(v.guest_count) || !guest_count || guest_count > 100000)
      throw new Error('Use a guest count between 1 and 100000.');
  } else if (guest_count !== null || v.email || v.phone)
    throw new Error('Guest contact fields apply to guests.');
  return { ...v, date_on: v.date_on || null, end_on: v.end_on || null, cost, guest_count };
}
export function travelTotals(
  p: TravelPlan,
  budgets: TravelBudget[],
  links: TravelExpense[],
  transactions: Transaction[],
  accounts: Account[],
  user: string,
) {
  const sums = new Map<string, { currency: string; planned: number | null; spent: number }>();
  for (const b of budgets.filter(
    (b) =>
      b.plan_id === p.id && b.owner_id === user && b.workspace_id === p.workspace_id && !b.archived,
  ))
    sums.set(b.currency, { currency: b.currency, planned: cents(b.amount), spent: 0 });
  for (const l of links.filter(
    (l) =>
      l.plan_id === p.id && l.owner_id === user && l.workspace_id === p.workspace_id && !l.archived,
  )) {
    const t = transactions.find(
        (t) =>
          t.id === l.transaction_id &&
          t.kind === 'expense' &&
          t.owner_id === user &&
          t.workspace_id === p.workspace_id,
      ),
      a =
        t &&
        accounts.find(
          (a) => a.id === t.account_id && a.owner_id === user && a.workspace_id === p.workspace_id,
        );
    if (!t || !a) continue;
    const row = sums.get(a.currency) ?? { currency: a.currency, planned: null, spent: 0 };
    row.spent += cents(t.amount);
    if (!Number.isSafeInteger(row.spent))
      throw new Error('Expense total is too large to calculate precisely.');
    sums.set(a.currency, row);
  }
  return [...sums.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((r) => ({
      ...r,
      planned: r.planned === null ? null : r.planned / 100,
      spent: r.spent / 100,
      remaining: r.planned === null ? null : (r.planned - r.spent) / 100,
    }));
}
export function travelEntriesCsv(rows: TravelEntry[]) {
  return csv(
    rows.map((r) => ({
      kind: r.kind,
      title: r.title,
      date: r.date_on,
      end_date: r.end_on,
      time: r.time_at,
      end_time: r.end_time,
      location: r.location,
      reference: r.reference,
      booking_cost: r.cost,
      currency: r.currency,
      email: r.email,
      phone: r.phone,
      guests: r.guest_count,
      status: r.status,
      notes: r.notes,
      archived: r.archived,
    })),
  );
}
