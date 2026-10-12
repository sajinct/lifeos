import {
  Attachment,
  Bill,
  Task,
  ReminderPreferences,
  Notification,
} from '../../core/models/domain';
export interface ReminderSource {
  id: string;
  workspace_id: string;
  owner_id: string;
  kind: 'task' | 'bill' | 'document';
  title: string;
  date: string;
  days: number;
}
export function reminderSources(
  p: ReminderPreferences,
  tasks: Task[],
  bills: Bill[],
  files: Attachment[],
): ReminderSource[] {
  return [
    ...tasks
      .filter((t) => p.task_reminders && t.status !== 'done' && t.due_date)
      .map((t) => ({ ...t, kind: 'task' as const, date: t.due_date!, days: p.task_lead_days })),
    ...bills
      .filter((b) => p.bill_reminders && b.status === 'pending')
      .map((b) => ({ ...b, kind: 'bill' as const, date: b.due_on, days: p.bill_lead_days })),
    ...files
      .filter(
        (f) =>
          p.document_reminders &&
          f.status === 'ready' &&
          f.expires_on &&
          f.bucket_id === 'personal-documents',
      )
      .map((f) => ({
        ...f,
        title: f.name,
        kind: 'document' as const,
        date: f.expires_on!,
        days: p.document_lead_days,
      })),
  ];
}
export function reminderClock(now: Date, zone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (key: string) => parts.find((p) => p.type === key)!.value;
  return { day: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}
export function reminderPhase(source: ReminderSource, day: string): Notification['phase'] {
  const difference =
    (Date.parse(source.date + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000;
  return difference < 0 ? 'overdue' : difference <= source.days ? 'upcoming' : null;
}
export function reminderTitle(s: ReminderSource, phase: Notification['phase']) {
  const label = s.kind === 'task' ? 'Task' : s.kind === 'bill' ? 'Bill' : 'Document';
  return `${label} ${phase === 'overdue' ? (s.kind === 'document' ? 'expired' : 'overdue') : `${s.kind === 'document' ? 'expires' : 'due'} ${s.date}`}: ${s.title}`;
}
export function notificationVisible(n: Notification, now: number) {
  return !n.dismissed_at && (!n.snoozed_until || Date.parse(n.snoozed_until) <= now);
}
