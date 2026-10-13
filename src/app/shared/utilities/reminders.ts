import {
  Attachment,
  Bill,
  Task,
  ReminderPreferences,
  Notification,
  Subscription,
  Loan,
  Contact,
  HouseholdMember,
  HouseholdEntry,
  MedicationPlan,
  HealthAppointment,
  CareerRecord,
  Asset,
  MaintenancePlan,
} from '../../core/models/domain';
import { householdAnniversary } from './household';
export interface ReminderSource {
  id: string;
  workspace_id: string;
  owner_id: string;
  kind: Exclude<Notification['source_kind'], null>;
  title: string;
  date: string;
  days: number;
}
export function reminderSources(
  p: ReminderPreferences,
  tasks: Task[],
  bills: Bill[],
  files: Attachment[],
  subscriptions: Subscription[] = [],
  loans: Loan[] = [],
  contacts: Contact[] = [],
  householdMembers: HouseholdMember[] = [],
  householdEntries: HouseholdEntry[] = [],
  now: Date = new Date(),
  assets: Asset[] = [],
  maintenance: MaintenancePlan[] = [],
  career: CareerRecord[] = [],
  health: HealthAppointment[] = [],
  medications: MedicationPlan[] = [],
): ReminderSource[] {
  const today = reminderClock(now, p.reminder_timezone).day;
  return [
    ...medications.flatMap((r) => {
      if (!p.medication_reminders || !r.active || r.archived) return [];
      const clock = reminderClock(now, r.timezone),
        time = new Intl.DateTimeFormat('en-GB', {
          timeZone: r.timezone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(now),
        weekday = new Date(clock.day + 'T00:00:00Z').getUTCDay();
      return clock.day >= r.starts_on &&
        (!r.ends_on || clock.day <= r.ends_on) &&
        r.weekdays.includes(weekday) &&
        time >= r.reminder_time
        ? [{ ...r, kind: 'health_medication' as const, date: clock.day, days: 0 }]
        : [];
    }),
    ...health
      .filter((r) => p.health_reminders && r.status === 'scheduled' && !r.archived)
      .map((r) => ({
        ...r,
        kind: 'health_appointment' as const,
        date: r.appointment_on,
        days: p.health_lead_days,
      })),
    ...career.flatMap((r) => {
      if (!p.career_reminders) return [];
      const dates: [ReminderSource['kind'], string | null, number][] =
        r.kind === 'certification' && r.status === 'active'
          ? [['certification', r.expires_on, p.certification_lead_days]]
          : r.kind === 'application' && ['applied', 'interview', 'offer'].includes(r.status)
            ? [
                ['career_follow_up', r.follow_up_on, p.career_lead_days],
                ['career_interview', r.interview_on, p.career_lead_days],
              ]
            : [];
      return dates
        .filter(([, d]) => d)
        .map(([kind, date, days]) => ({
          ...r,
          title: r.title + ' · ' + r.organization,
          kind,
          date: date!,
          days,
        }));
    }),
    ...assets
      .filter((a) => p.asset_reminders && a.status === 'active' && a.warranty_until)
      .map((a) => ({
        ...a,
        kind: 'warranty' as const,
        title: a.name,
        date: a.warranty_until!,
        days: p.warranty_lead_days,
      })),
    ...maintenance
      .filter(
        (m) =>
          p.asset_reminders &&
          m.status === 'active' &&
          m.next_on &&
          assets.some(
            (a) =>
              a.id === m.asset_id &&
              a.owner_id === m.owner_id &&
              a.workspace_id === m.workspace_id &&
              a.status === 'active',
          ),
      )
      .map((m) => ({
        ...m,
        kind: 'maintenance' as const,
        title: m.title + ' · ' + assets.find((a) => a.id === m.asset_id)!.name,
        date: m.next_on!,
        days: p.maintenance_lead_days,
      })),
    ...householdMembers
      .filter((m) => p.family_reminders && m.status === 'active' && m.birthday)
      .map((m) => ({
        ...m,
        kind: 'family_birthday' as const,
        title: m.name,
        date: householdAnniversary('2000-' + m.birthday, today),
        days: p.family_lead_days,
      })),
    ...householdEntries
      .filter((e) => p.family_reminders && e.status === 'active' && e.due_on)
      .map((e) => ({
        ...e,
        kind: e.kind === 'task' ? ('family_task' as const) : ('family_date' as const),
        date: e.annual ? householdAnniversary(e.due_on!, today) : e.due_on!,
        days: p.family_lead_days,
      })),
    ...contacts
      .filter((c) => p.contact_reminders && c.status === 'active' && c.next_follow_up)
      .map((c) => ({
        ...c,
        title: c.name,
        kind: 'contact' as const,
        date: c.next_follow_up!,
        days: p.contact_lead_days,
      })),
    ...loans
      .filter((l) => p.loan_reminders && l.status === 'active' && l.next_due_on)
      .map((l) => ({ ...l, kind: 'loan' as const, date: l.next_due_on!, days: p.loan_lead_days })),
    ...subscriptions
      .filter((s) => p.subscription_reminders && s.status !== 'cancelled')
      .map((s) => ({
        ...s,
        kind: s.status === 'trial' ? ('trial' as const) : ('subscription' as const),
        date: s.status === 'trial' ? s.trial_ends_on! : s.next_on,
        days: p.subscription_lead_days,
      })),
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
  const label =
    s.kind === 'health_medication'
      ? 'Medication reminder'
      : s.kind === 'health_appointment'
        ? 'Health appointment'
        : s.kind === 'career_follow_up'
          ? 'Application follow-up'
          : s.kind === 'career_interview'
            ? 'Interview'
            : s.kind === 'certification'
              ? 'Certification'
              : s.kind === 'warranty'
                ? 'Asset warranty'
                : s.kind === 'maintenance'
                  ? 'Maintenance'
                  : s.kind === 'family_birthday'
                    ? 'Birthday'
                    : s.kind === 'family_task'
                      ? 'Household task'
                      : s.kind === 'family_date'
                        ? 'Important date'
                        : s.kind === 'task'
                          ? 'Task'
                          : s.kind === 'bill'
                            ? 'Bill'
                            : s.kind === 'document'
                              ? 'Document'
                              : s.kind === 'trial'
                                ? 'Trial'
                                : s.kind === 'loan'
                                  ? 'Loan repayment'
                                  : s.kind === 'contact'
                                    ? 'Contact follow-up'
                                    : 'Subscription';
  const overdue =
    s.kind === 'document' || s.kind === 'warranty' || s.kind === 'certification'
      ? 'expired'
      : s.kind === 'trial'
        ? 'ended'
        : s.kind === 'subscription'
          ? 'renewal overdue'
          : 'overdue';
  const verb =
    s.kind === 'document' || s.kind === 'warranty' || s.kind === 'certification'
      ? 'expires'
      : s.kind === 'trial'
        ? 'ends'
        : s.kind === 'subscription'
          ? 'renews'
          : 'due';
  return `${label} ${phase === 'overdue' ? overdue : `${verb} ${s.date}`}: ${s.title}`;
}
export function notificationVisible(n: Notification, now: number) {
  return !n.dismissed_at && (!n.snoozed_until || Date.parse(n.snoozed_until) <= now);
}
