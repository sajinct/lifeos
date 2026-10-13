import {
  Account,
  Project,
  ProjectBudget,
  ProjectMilestone,
  Task,
  TaskTime,
  Transaction,
  ProjectInput,
} from '../../core/models/domain';
import { cents, csv, parseMoney } from './finance';
import { supportedDate } from './habits';
export function validateProject(input: ProjectInput) {
  const v = { ...input, title: input.title.trim(), description: input.description.trim() };
  if (
    !v.title ||
    v.title.length > 200 ||
    v.description.length > 4000 ||
    !['active', 'paused', 'completed'].includes(v.status) ||
    !['purple', 'green', 'orange', 'blue'].includes(v.color) ||
    !['private', 'workspace'].includes(v.visibility) ||
    (v.due_date && !supportedDate(v.due_date))
  )
    throw new Error(
      'Enter a valid project title, date, status and description up to 4000 characters.',
    );
  return v;
}
export function projectAmount(amount: string) {
  const value = parseMoney(amount);
  if (value >= 1000000000000) throw new Error('Budget must be below one trillion.');
  return value;
}
export function projectTotals(
  project: Project,
  budgets: ProjectBudget[],
  transactions: Transaction[],
  accounts: Account[],
  user: string,
) {
  const plans = budgets.filter(
    (b) =>
      b.project_id === project.id &&
      b.workspace_id === project.workspace_id &&
      b.owner_id === user &&
      !b.archived,
  );
  const currencies = new Map<
    string,
    { currency: string; planned: number | null; spent: number; remaining: number | null }
  >();
  for (const b of plans)
    currencies.set(b.currency, {
      currency: b.currency,
      planned: cents(b.amount),
      spent: 0,
      remaining: null,
    });
  for (const t of transactions) {
    if (
      t.workspace_id !== project.workspace_id ||
      t.owner_id !== user ||
      t.project_id !== project.id ||
      t.kind !== 'expense'
    )
      continue;
    const a = accounts.find(
      (a) =>
        a.id === t.account_id && a.workspace_id === project.workspace_id && a.owner_id === user,
    );
    if (!a) continue;
    const row = currencies.get(a.currency) ?? {
      currency: a.currency,
      planned: null,
      spent: 0,
      remaining: null,
    };
    row.spent += cents(t.amount);
    if (!Number.isSafeInteger(row.spent))
      throw new Error('Expense total is too large to calculate precisely.');
    currencies.set(a.currency, row);
  }
  return [...currencies.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((r) => ({
      ...r,
      planned: r.planned === null ? null : r.planned / 100,
      spent: r.spent / 100,
      remaining: r.planned === null ? null : (r.planned - r.spent) / 100,
    }));
}
export function projectSummary(
  project: Project,
  milestones: ProjectMilestone[],
  tasks: Task[],
  times: TaskTime[],
  user: string,
) {
  const steps = milestones.filter(
      (m) => m.workspace_id === project.workspace_id && m.project_id === project.id && !m.archived,
    ),
    visible = tasks.filter(
      (t) =>
        t.workspace_id === project.workspace_id &&
        t.project_id === project.id &&
        (t.owner_id === user || t.visibility === 'workspace'),
    ),
    work = times.filter(
      (t) =>
        t.workspace_id === project.workspace_id &&
        t.owner_id === user &&
        t.project_id === project.id &&
        t.status === 'recorded',
    );
  return {
    milestones: steps.length,
    achieved: steps.filter((m) => m.done).length,
    tasks: visible.length,
    completed: visible.filter((t) => t.status === 'done').length,
    seconds: work.reduce((sum, t) => sum + t.seconds, 0),
    sessions: work.length,
  };
}
export function projectsCsv(
  projects: Project[],
  milestones: ProjectMilestone[],
  budgets: ProjectBudget[],
  tasks: Task[],
  times: TaskTime[],
  transactions: Transaction[],
  accounts: Account[],
  user: string,
) {
  return csv(
    projects.flatMap((p) => {
      const s = projectSummary(p, milestones, tasks, times, user),
        totals = projectTotals(p, budgets, transactions, accounts, user);
      return (
        totals.length ? totals : [{ currency: '', planned: null, spent: 0, remaining: null }]
      ).map((t) => ({
        project: p.title,
        status: p.status,
        visibility: p.visibility,
        deadline: p.due_date ?? '',
        milestones_completed: s.achieved,
        milestones: s.milestones,
        tasks_completed: s.completed,
        tasks_visible: s.tasks,
        your_recorded_seconds: s.seconds,
        your_sessions: s.sessions,
        currency: t.currency,
        your_budget: t.planned ?? '',
        your_expenses: t.spent,
        your_remaining: t.remaining ?? '',
      }));
    }),
  );
}
export function projectMilestonesCsv(rows: ProjectMilestone[], projects: Project[]) {
  return csv(
    rows
      .filter((m) =>
        projects.some((p) => p.id === m.project_id && p.workspace_id === m.workspace_id),
      )
      .map((m) => ({
        project: projects.find((p) => p.id === m.project_id)?.title,
        title: m.title,
        deadline: m.due_on ?? '',
        done: m.done,
        completed_on: m.completed_on ?? '',
        archived: m.archived,
        notes: m.notes,
      })),
  );
}
