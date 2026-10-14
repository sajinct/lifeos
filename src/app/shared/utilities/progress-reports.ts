import {
  Goal,
  LearningItem,
  LearningUnit,
  Project,
  Task,
  TaskTime,
} from '../../core/models/domain';
import { reportPeriod } from './reports';
import { learningProgress } from './learning';
import { csv } from './finance';
export interface ProgressData {
  tasks: Task[];
  projects: Project[];
  goals: Goal[];
  times: TaskTime[];
  learning: LearningItem[];
  units: LearningUnit[];
}
export interface ProgressFilter {
  workspace: string;
  user: string;
  from: string;
  to: string;
  today: string;
}
export function progressReport(data: ProgressData, f: ProgressFilter) {
  const period = reportPeriod(f.from, f.to),
    own = (r: { workspace_id: string; owner_id: string }) =>
      !!f.workspace && !!f.user && r.workspace_id === f.workspace && r.owner_id === f.user,
    inPeriod = (d: string | null) => !!d && d >= f.from && d <= f.to;
  const tasks = data.tasks.filter(own),
    projects = data.projects.filter(own),
    goals = data.goals.filter(own),
    learning = data.learning.filter(own),
    units = data.units.filter(own),
    current = learning.filter((i) => !i.archived),
    time = data.times.filter((t) => own(t) && t.status === 'recorded' && inPeriod(t.logged_on)),
    completed = learning.filter((i) => i.status === 'completed' && inPeriod(i.completed_on));
  const currentProjects = projects
    .filter((p) => p.status !== 'completed')
    .map((p) => {
      const child = tasks.filter((t) => t.project_id === p.id);
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        due: p.due_date,
        total: child.length,
        done: child.filter((t) => t.status === 'done').length,
      };
    });
  const currentGoals = goals
    .filter((g) => g.status !== 'archived')
    .map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      current: g.current,
      target: g.target,
      unit: g.unit,
      due: g.due_date,
      percent:
        g.target > 0 ? Math.min(100, Math.max(0, Math.round((g.current / g.target) * 100))) : 0,
    }));
  const currentLearning = current.map((i) => ({ ...i, progress: learningProgress(i, units) }));
  const timeGroups = new Map<string, { id: string | null; title: string; seconds: number }>();
  for (const t of time) {
    const key = t.project_id ?? 'none',
      old = timeGroups.get(key);
    timeGroups.set(key, {
      id: t.project_id,
      title: old?.title ?? (t.project_title || 'Personal / no project'),
      seconds: (old?.seconds ?? 0) + t.seconds,
    });
  }
  return {
    snapshot: {
      tasks: tasks.length,
      open: tasks.filter((t) => t.status !== 'done').length,
      done: tasks.filter((t) => t.status === 'done').length,
      overdue: tasks.filter((t) => t.status !== 'done' && t.due_date && t.due_date < f.today)
        .length,
      projects: projects.filter((p) => p.status === 'active').length,
      learning: current.filter((i) => i.status === 'active').length,
      paused: current.filter((i) => i.status === 'paused').length,
    },
    period: {
      seconds: time.reduce((n, t) => n + t.seconds, 0),
      entries: time.length,
      completed: completed.length,
    },
    months: period.months.map((month) => ({
      month,
      seconds: time.filter((t) => t.logged_on.startsWith(month)).reduce((n, t) => n + t.seconds, 0),
      completed: completed.filter((i) => i.completed_on!.startsWith(month)).length,
    })),
    projects: currentProjects,
    goals: currentGoals,
    learning: currentLearning,
    timeGroups: [...timeGroups.values()].sort(
      (a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title),
    ),
    time,
    completed,
  };
}
export function progressCsv(r: ReturnType<typeof progressReport>, f: ProgressFilter) {
  const base = {
    section: '',
    title: '',
    kind: '',
    status: '',
    date: '',
    done: '',
    total: '',
    value: '',
    unit: '',
    archived: '',
  };
  return csv([
    {
      ...base,
      section: 'period',
      title: `${f.from} to ${f.to}`,
      value: String(r.period.seconds),
      unit: 'recorded seconds',
    },
    ...Object.entries(r.snapshot).map(([title, value]) => ({
      ...base,
      section: 'current snapshot',
      title,
      value: String(value),
      unit: 'records',
    })),
    ...r.months.map((m) => ({
      ...base,
      section: 'monthly time',
      title: m.month,
      value: String(m.seconds),
      unit: 'recorded seconds',
    })),
    ...r.months.map((m) => ({
      ...base,
      section: 'monthly learning completions',
      title: m.month,
      value: String(m.completed),
      unit: 'items',
    })),
    ...r.projects.map((p) => ({
      ...base,
      section: 'current projects',
      title: p.title,
      status: p.status,
      date: p.due ?? '',
      done: String(p.done),
      total: String(p.total),
    })),
    ...r.goals.map((g) => ({
      ...base,
      section: 'current goals',
      title: g.title,
      status: g.status,
      date: g.due ?? '',
      value: String(g.current),
      total: String(g.target),
      unit: g.unit,
    })),
    ...r.learning.map((i) => ({
      ...base,
      section: 'current learning',
      title: i.title,
      kind: i.kind,
      status: i.status,
      date: i.due_on ?? '',
      done: String(i.progress.done),
      total: String(i.progress.total),
    })),
    ...r.completed.map((i) => ({
      ...base,
      section: 'learning completed in period',
      title: i.title,
      kind: i.kind,
      status: i.status,
      date: i.completed_on!,
      archived: String(i.archived),
    })),
    ...r.time.map((t) => ({
      ...base,
      section: 'time recorded in period',
      title: t.task_title,
      kind: t.mode,
      status: t.status,
      date: t.logged_on,
      value: String(t.seconds),
      unit: 'seconds',
    })),
  ]);
}
