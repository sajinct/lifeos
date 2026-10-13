import {
  HealthLogInput,
  MedicationInput,
  HealthLog,
  HealthExpense,
  Transaction,
  Account,
} from '../../core/models/domain';
import { supportedDate } from './habits';
import { csv, cents } from './finance';
export function healthValue(value: string) {
  if (!/^\d+(\.\d{1,3})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) >= 1e9)
    throw new Error('Use a non-negative value below one billion, with up to three decimals.');
  return Number(value);
}
export function validateHealthLog(v: HealthLogInput, today: string) {
  const input = { ...v, title: v.title.trim(), unit: v.unit.trim() };
  if (
    !input.title ||
    input.title.length > 200 ||
    !['fitness', 'measurement'].includes(input.kind) ||
    !supportedDate(input.logged_on) ||
    input.logged_on > today ||
    input.notes.length > 2000 ||
    input.unit.length > 40
  )
    throw new Error('Check log title, date and notes.');
  const minutes = input.minutes ? Number(input.minutes) : null,
    value = input.value ? healthValue(input.value) : null;
  if (
    (input.kind === 'fitness' && (!/^\d+$/.test(input.minutes) || !minutes || minutes > 1440)) ||
    (input.kind === 'measurement' && (minutes !== null || value === null)) ||
    (value === null ? !!input.unit : !input.unit)
  )
    throw new Error('Enter fitness minutes (1–1440), or a measurement value and unit.');
  return { ...input, minutes, value };
}
export function validateMedication(v: MedicationInput) {
  const input = { ...v, title: v.title.trim(), timezone: v.timezone.trim() };
  if (
    !input.title ||
    input.title.length > 200 ||
    input.instructions.length > 2000 ||
    !supportedDate(input.starts_on) ||
    (input.ends_on && (!supportedDate(input.ends_on) || input.ends_on < input.starts_on)) ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.reminder_time) ||
    !input.weekdays.length ||
    input.weekdays.length > 7 ||
    new Set(input.weekdays).size !== input.weekdays.length ||
    input.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  )
    throw new Error('Check medication name, dates, weekdays and reminder time.');
  new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  return input;
}
export function measurementHistory(rows: HealthLog[]) {
  const groups = new Map<string, HealthLog[]>();
  for (const r of rows.filter((r) => r.kind === 'measurement' && !r.archived)) {
    const key = JSON.stringify([r.owner_id, r.workspace_id, r.title, r.unit]);
    const values = groups.get(key) ?? [];
    values.push(r);
    groups.set(key, values);
  }
  return [...groups.values()].map((values) => {
    values.sort(
      (a, b) =>
        b.logged_on.localeCompare(a.logged_on) ||
        b.created_at.localeCompare(a.created_at) ||
        b.id.localeCompare(a.id),
    );
    return { latest: values[0], previous: values[1] ?? null };
  });
}
export function medicalTotals(
  links: HealthExpense[],
  transactions: Transaction[],
  accounts: Account[],
  user: string,
  w: string,
) {
  const sums = new Map<string, number>();
  for (const link of links.filter(
    (l) => l.owner_id === user && l.workspace_id === w && !l.archived,
  )) {
    const t = transactions.find(
        (t) =>
          t.id === link.transaction_id &&
          t.owner_id === user &&
          t.workspace_id === w &&
          t.kind === 'expense',
      ),
      a =
        t &&
        accounts.find((a) => a.id === t.account_id && a.owner_id === user && a.workspace_id === w);
    if (!t || !a) continue;
    const total = (sums.get(a.currency) ?? 0) + cents(t.amount);
    if (!Number.isSafeInteger(total))
      throw new Error('Medical expense total is too large to calculate precisely.');
    sums.set(a.currency, total);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, value]) => ({ currency, amount: value / 100 }));
}
export function healthLogsCsv(rows: HealthLog[]) {
  return csv(
    rows.map((r) => ({
      title: r.title,
      kind: r.kind,
      date: r.logged_on,
      minutes: r.minutes,
      value: r.value,
      unit: r.unit,
      notes: r.notes,
      archived: r.archived,
    })),
  );
}
