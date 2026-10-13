import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { ProjectPlanning } from './project-planning';
import { TaskWork } from './task-work';
import { ProjectInput } from '../models/domain';
import {
  projectAmount,
  projectTotals,
  projectSummary,
  projectsCsv,
  projectMilestonesCsv,
} from '../../shared/utilities/project-planning';
describe('Project planning and personal finances', () => {
  let store: LifeStore, planning: ProjectPlanning;
  const input: ProjectInput = {
    title: 'Launch',
    description: 'Plan',
    status: 'active',
    color: 'green',
    due_date: '2026-12-31',
    visibility: 'private',
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    planning = TestBed.inject(ProjectPlanning);
  });
  it('replays project creation, protects revisions and validates dates', async () => {
    await planning.saveProject('launch', input);
    const p = store.projects()[0];
    await planning.saveProject('launch', { ...input, title: 'Ignored' });
    expect(store.projects()[0].title).toBe('Launch');
    await planning.saveProject('launch', { ...input, title: 'Changed' }, p);
    await expect(planning.saveProject('launch', input, p)).rejects.toThrow(/changed/);
    await expect(planning.saveProject('bad', { ...input, due_date: '2026-02-30' })).rejects.toThrow(
      /valid/,
    );
  });
  it('preserves independent milestone completion through edits, archives and retry', async () => {
    const p = store.projects()[0],
      tasks = store.tasks();
    await planning.saveMilestone('step', p, 'Design', '', 'Notes');
    const initial = store.projectMilestones()[0];
    await planning.saveMilestone('step', p, 'Ignored', '', '');
    await planning.milestoneAction(initial, 'complete');
    await planning.milestoneAction(initial, 'complete');
    expect(store.projectMilestones()[0]).toMatchObject({
      revision: 2,
      done: true,
      completed_on: planning.today(),
    });
    await expect(planning.milestoneAction(initial, 'reopen')).rejects.toThrow(/changed/);
    await planning.saveMilestone('step', p, 'Design revised', '', '', store.projectMilestones()[0]);
    expect(store.projectMilestones()[0].done).toBe(true);
    await planning.milestoneAction(store.projectMilestones()[0], 'archive');
    await expect(
      planning.saveMilestone('step', p, 'Design', '', '', store.projectMilestones()[0]),
    ).rejects.toThrow(/restore/);
    await planning.milestoneAction(store.projectMilestones()[0], 'restore');
    await planning.milestoneAction(store.projectMilestones()[0], 'reopen');
    expect(store.projectMilestones()[0].completed_on).toBeNull();
    expect(store.tasks()).toEqual(tasks);
    expect(store.projects()[0].status).toBe(p.status);
  });
  it('requires reopening completed projects before changing milestones', async () => {
    await planning.saveProject('launch', { ...input, status: 'completed' });
    await expect(
      planning.saveMilestone('step', store.projects()[0], 'Design', '', ''),
    ).rejects.toThrow(/Reopen/);
    await planning.saveBudget('plan', store.projects()[0], 'INR', '100');
    expect(store.projectBudgets()[0].amount).toBe(100);
  });
  it('keeps a shared project readable while shared children link to it', async () => {
    await planning.saveProject('launch', { ...input, visibility: 'workspace' });
    store.tasks.update((rows) => [
      { ...rows[0], id: 'linked', project_id: 'launch', visibility: 'workspace' },
      ...rows,
    ]);
    await expect(planning.saveProject('launch', input, store.projects()[0])).rejects.toThrow(
      /Keep this project shared/,
    );
  });
  it('protects currency identity, duplicate plans, archive history and stale edits', async () => {
    const p = store.projects()[0];
    await planning.saveBudget('plan', p, 'INR', '100.25');
    const b = store.projectBudgets()[0];
    await planning.saveBudget('plan', p, 'INR', '900');
    expect(store.projectBudgets()[0].amount).toBe(100.25);
    await expect(planning.saveBudget('other', p, 'INR', '10')).rejects.toThrow(/already exists/);
    await expect(planning.saveBudget('plan', p, 'USD', '10', b)).rejects.toThrow(/currency/);
    await planning.saveBudget('plan', p, 'INR', '200', b);
    await expect(planning.archiveBudget(b, true)).rejects.toThrow(/changed/);
    await planning.archiveBudget(store.projectBudgets()[0], true);
    await expect(planning.saveBudget('other', p, 'INR', '10')).rejects.toThrow(/restore/);
    await planning.archiveBudget(store.projectBudgets()[0], false);
    expect(store.projectBudgets()[0].amount).toBe(200);
    for (const value of ['0', '-1', '1.001', 'NaN', 'Infinity', '1000000000000'])
      expect(() => projectAmount(value)).toThrow();
  });
  it('links only owned expenses without changing ledger amounts or balances', async () => {
    const p = store.projects()[0],
      expense = store.transactions().find((t) => t.kind === 'expense')!,
      accounts = store.accounts();
    await planning.linkExpense(expense, p);
    await planning.linkExpense(expense, p);
    const linked = store.transactions().find((t) => t.id === expense.id)!;
    expect(linked).toEqual({ ...expense, project_id: p.id });
    await expect(planning.linkExpense(expense, null)).rejects.toThrow(/changed/);
    await expect(planning.linkExpense({ ...linked, owner_id: 'other' }, null)).rejects.toThrow(
      /inaccessible/,
    );
    await expect(planning.linkExpense({ ...linked, kind: 'income' }, null)).rejects.toThrow(
      /inaccessible/,
    );
    await planning.linkExpense(linked, null);
    expect(store.accounts()).toEqual(accounts);
  });
  it('separates currencies, uses cents and excludes other owners and non-expenses', async () => {
    const p = store.projects()[0],
      user = store.profile()!.id,
      account = store.accounts()[0],
      expense = store.transactions().find((t) => t.kind === 'expense')!;
    await planning.saveBudget('inr', p, 'INR', '1');
    await planning.saveBudget('usd', p, 'USD', '5');
    const tx = { ...expense, account_id: account.id, project_id: p.id, amount: 0.1 };
    const totals = projectTotals(
      p,
      store.projectBudgets(),
      [
        tx,
        { ...tx, id: 'two', amount: 0.2 },
        { ...tx, id: 'income', kind: 'income', amount: 100 },
        { ...tx, id: 'transfer', kind: 'transfer_out', amount: 100 },
        { ...tx, id: 'other', owner_id: 'other', amount: 100 },
      ],
      [{ ...account, currency: 'INR' }],
      user,
    );
    expect(totals).toEqual([
      { currency: 'INR', planned: 1, spent: 0.3, remaining: 0.7 },
      { currency: 'USD', planned: 5, spent: 0, remaining: 5 },
    ]);
    const b = store.projectBudgets().find((b) => b.currency === 'INR')!;
    await planning.archiveBudget(b, true);
    expect(
      projectTotals(p, store.projectBudgets(), [tx], [{ ...account, currency: 'INR' }], user)[0]
        .planned,
    ).toBeNull();
  });
  it('summarizes visible tasks and personal recorded time and neutralizes CSV formulas', async () => {
    const work = TestBed.inject(TaskWork),
      task = store.tasks().find((t) => t.project_id)!,
      p = store.projects().find((p) => p.id === task.project_id)!;
    await work.manual('time', task, work.today(), '30', '');
    await work.start('running', task, '');
    const recorded = store.taskTimes().find((t) => t.id === 'time')!;
    const summary = projectSummary(
      p,
      [],
      store.tasks(),
      [...store.taskTimes(), { ...recorded, id: 'other', owner_id: 'other', seconds: 5000 }],
      store.profile()!.id,
    );
    expect(summary).toMatchObject({ seconds: 1800, sessions: 1 });
    await planning.saveMilestone('step', p, '=formula', '', '+notes');
    expect(projectMilestonesCsv(store.projectMilestones(), [p])).toContain("'=formula");
    expect(projectMilestonesCsv(store.projectMilestones(), [])).not.toContain('formula');
    expect(
      projectsCsv(
        [{ ...p, title: '@formula' }],
        [],
        [],
        store.tasks(),
        store.taskTimes(),
        [],
        [],
        store.profile()!.id,
      ),
    ).toContain("'@formula");
  });
  it('isolates workspace caches and clears project planning on sign-out', async () => {
    const p = store.projects()[0],
      original = store.workspace()!;
    await planning.saveMilestone('step', p, 'Design', '', '');
    await planning.saveBudget('plan', p, 'INR', '100');
    await store.createWorkspace('Other', 'professional');
    expect(store.projectMilestones()).toHaveLength(0);
    expect(store.projectBudgets()).toHaveLength(0);
    await expect(planning.saveBudget('wrong', p, 'INR', '100')).rejects.toThrow(/inaccessible/);
    await store.switchWorkspace(original);
    expect(store.projectMilestones()).toHaveLength(1);
    expect(store.projectBudgets()).toHaveLength(1);
    store.clear();
    expect(store.projectBudgets()).toHaveLength(0);
    expect(store.projectMilestones()).toHaveLength(0);
  });
  it('does not reload late project writes after sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'demo-user' } as User);
    auth.demo.set(false);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace'),
      pending = planning.saveProject('pending', input);
    store.clear();
    auth.user.set(null);
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.projects()).toHaveLength(0);
  });
});
