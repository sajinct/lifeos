import { TaskTime } from '../../core/models/domain';
import { csv } from './finance';
export function duration(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}
export function manualSeconds(minutes: string) {
  if (!/^\d{1,4}$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 1440)
    throw new Error('Enter whole minutes from 1 to 1440.');
  return Number(minutes) * 60;
}
export function timerSeconds(entry: TaskTime, now: number) {
  return entry.status === 'running' && entry.started_at
    ? Math.max(0, Math.min(86400, Math.floor((now - Date.parse(entry.started_at)) / 1000)))
    : entry.seconds;
}
export function timeSummary(entries: TaskTime[], group: 'task' | 'project') {
  const totals = new Map<string, { label: string; seconds: number; sessions: number }>();
  for (const e of entries.filter((e) => e.status === 'recorded')) {
    const key = group === 'task' ? (e.task_id ?? e.task_title) : (e.project_id ?? ''),
      label = group === 'task' ? e.task_title : e.project_title || 'No project';
    const row = totals.get(key) ?? { label, seconds: 0, sessions: 0 };
    row.seconds += e.seconds;
    row.sessions++;
    totals.set(key, row);
  }
  return [...totals.values()].sort(
    (a, b) => b.seconds - a.seconds || a.label.localeCompare(b.label),
  );
}
export function timeCsv(entries: TaskTime[]) {
  return csv(
    entries.map((e) => ({
      date: e.logged_on,
      task: e.task_title,
      project: e.project_title,
      mode: e.mode,
      status: e.status,
      duration: duration(e.seconds),
      seconds: e.seconds,
      started_at: e.started_at ?? '',
      ended_at: e.ended_at ?? '',
      notes: e.notes,
    })),
  );
}
