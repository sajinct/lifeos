import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { TaskWork } from './task-work';
import {
  Project,
  ProjectBudget,
  ProjectMilestone,
  ProjectInput,
  Transaction,
} from '../models/domain';
import { validateProject, projectAmount } from '../../shared/utilities/project-planning';
import { supportedDate } from '../../shared/utilities/habits';
@Injectable({ providedIn: 'root' })
export class ProjectPlanning {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  readonly today = inject(TaskWork).today;
  private context() {
    const w = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !w ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { w, user, session };
  }
  private async reload(c: ReturnType<ProjectPlanning['context']>) {
    if (
      c.w !== this.store.workspace()?.id ||
      c.user !== this.store.profile()?.id ||
      c.session !== this.store.fileSession() ||
      (!this.store.auth.demo() && c.user !== this.store.auth.user()?.id)
    )
      return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<ProjectPlanning['context']>) {
    const time = new Date().toISOString();
    return {
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: time,
      updated_at: time,
    };
  }
  private parent(project: Project, c: ReturnType<ProjectPlanning['context']>, edit = false) {
    const p = this.store
      .projects()
      .find(
        (p) =>
          p.id === project.id &&
          p.workspace_id === c.w &&
          (p.owner_id === c.user || p.visibility === 'workspace'),
      );
    if (!p || (edit && !this.store.canEdit(p))) throw new Error('Project is inaccessible.');
    return p;
  }
  async saveProject(id: string, input: ProjectInput, previous?: Project) {
    const c = this.context(),
      v = validateProject(input);
    if (previous) this.parent(previous, c, true);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_planned_project', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        project_title: v.title,
        project_description: v.description,
        project_status: v.status,
        project_color: v.color,
        deadline: v.due_date || null,
        sharing: v.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.projects().find((p) => p.id === id);
    if (old) {
      this.parent(old, c, true);
      if (!previous) {
        if (old.owner_id !== c.user) throw new Error('Project is inaccessible.');
        return;
      }
      if (old.revision !== previous.revision)
        throw new Error('Project changed; refresh and try again.');
    } else if (previous) throw new Error('Project is inaccessible.');
    if (
      old?.visibility === 'workspace' &&
      v.visibility === 'private' &&
      [...this.store.tasks(), ...this.store.events(), ...this.store.notes()].some(
        (r) => r.project_id === id && r.visibility === 'workspace',
      )
    )
      throw new Error('Keep this project shared while shared tasks, events or notes link to it.');
    this.store.projects.update((rows) => [
      {
        ...this.base(c),
        ...v,
        id,
        owner_id: old?.owner_id ?? c.user,
        due_date: v.due_date || null,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? new Date().toISOString(),
      },
      ...rows.filter((p) => p.id !== id),
    ]);
  }
  async saveMilestone(
    id: string,
    project: Project,
    title: string,
    due: string,
    notes: string,
    previous?: ProjectMilestone,
  ) {
    const c = this.context(),
      p = this.parent(project, c, true);
    title = title.trim();
    if (!title || title.length > 200 || notes.length > 2000 || (due && !supportedDate(due)))
      throw new Error('Enter a title, valid date and notes up to 2000 characters.');
    if (p.status === 'completed') throw new Error('Reopen the project before editing milestones.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_project_milestone', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        parent: p.id,
        milestone_title: title,
        deadline: due || null,
        milestone_notes: notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.projectMilestones().find((m) => m.id === id);
    if (old) {
      if (old.project_id !== p.id || old.workspace_id !== c.w)
        throw new Error('Milestone is inaccessible.');
      if (!previous) return;
      if (old.revision !== previous.revision || old.archived)
        throw new Error('Milestone changed; restore or refresh and try again.');
    } else if (previous) throw new Error('Milestone is inaccessible.');
    this.store.projectMilestones.update((rows) => [
      {
        ...this.base(c),
        id,
        owner_id: p.owner_id,
        project_id: p.id,
        title,
        due_on: due || null,
        notes: notes.trim(),
        done: old?.done ?? false,
        completed_on: old?.completed_on ?? null,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? new Date().toISOString(),
      },
      ...rows.filter((m) => m.id !== id),
    ]);
  }
  async milestoneAction(
    milestone: ProjectMilestone,
    action: 'complete' | 'reopen' | 'archive' | 'restore',
  ) {
    const c = this.context(),
      p = this.store.projects().find((p) => p.id === milestone.project_id);
    if (!p) throw new Error('Project is inaccessible.');
    this.parent(p, c, true);
    if (p.status === 'completed') throw new Error('Reopen the project before editing milestones.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('act_on_project_milestone', {
        entry: milestone.id,
        expected_revision: milestone.revision,
        action,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.projectMilestones().find((m) => m.id === milestone.id);
    if (!old || old.workspace_id !== c.w) throw new Error('Milestone is inaccessible.');
    const done = action === 'complete' ? true : action === 'reopen' ? false : old.done,
      archived = action === 'archive' ? true : action === 'restore' ? false : old.archived;
    if (done === old.done && archived === old.archived) return;
    if (
      old.revision !== milestone.revision ||
      (old.archived && ['complete', 'reopen'].includes(action))
    )
      throw new Error('Milestone changed; restore or refresh and try again.');
    this.store.projectMilestones.update((rows) =>
      rows.map((m) =>
        m.id === old.id
          ? {
              ...m,
              done,
              archived,
              completed_on: done ? (old.done ? old.completed_on : this.today()) : null,
              revision: m.revision + 1,
            }
          : m,
      ),
    );
  }
  async saveBudget(
    id: string,
    project: Project,
    currency: string,
    amount: string,
    previous?: ProjectBudget,
  ) {
    const c = this.context(),
      p = this.parent(project, c),
      value = projectAmount(amount);
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Enter a three-letter currency.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_project_budget', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        parent: p.id,
        budget_currency: currency,
        budget_amount: value,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.projectBudgets().find((b) => b.id === id);
    if (old) {
      if (
        old.owner_id !== c.user ||
        old.workspace_id !== c.w ||
        old.project_id !== p.id ||
        old.currency !== currency
      )
        throw new Error('Budget is inaccessible or currency changed.');
      if (!previous) return;
      if (old.revision !== previous.revision || old.archived)
        throw new Error('Budget changed; restore or refresh and try again.');
    } else if (previous) throw new Error('Budget is inaccessible.');
    if (
      !old &&
      this.store
        .projectBudgets()
        .some((b) => b.project_id === p.id && b.owner_id === c.user && b.currency === currency)
    )
      throw new Error('Budget already exists for this currency; edit or restore it.');
    this.store.projectBudgets.update((rows) => [
      {
        ...this.base(c),
        id,
        project_id: p.id,
        currency,
        amount: value,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? new Date().toISOString(),
      },
      ...rows.filter((b) => b.id !== id),
    ]);
  }
  async archiveBudget(budget: ProjectBudget, archived: boolean) {
    const c = this.context(),
      p = this.store.projects().find((p) => p.id === budget.project_id);
    if (!p) throw new Error('Project is inaccessible.');
    this.parent(p, c);
    if (budget.owner_id !== c.user || budget.workspace_id !== c.w)
      throw new Error('Budget is inaccessible.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_project_budget_archive', {
        entry: budget.id,
        expected_revision: budget.revision,
        archived_value: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.projectBudgets().find((b) => b.id === budget.id);
    if (!old) throw new Error('Budget is inaccessible.');
    if (old.archived === archived) return;
    if (old.revision !== budget.revision) throw new Error('Budget changed; refresh and try again.');
    this.store.projectBudgets.update((rows) =>
      rows.map((b) => (b.id === old.id ? { ...b, archived, revision: b.revision + 1 } : b)),
    );
  }
  async linkExpense(expense: Transaction, project: Project | null) {
    const c = this.context();
    if (expense.owner_id !== c.user || expense.workspace_id !== c.w || expense.kind !== 'expense')
      throw new Error('Expense is inaccessible.');
    if (project) this.parent(project, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('link_project_expense', {
        entry: expense.id,
        expected_project: expense.project_id,
        parent: project?.id ?? null,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.transactions().find((t) => t.id === expense.id);
    if (!old) throw new Error('Expense is inaccessible.');
    const parent = project?.id ?? null;
    if (old.project_id === parent) return;
    if (old.project_id !== expense.project_id)
      throw new Error('Expense link changed; refresh and try again.');
    this.store.transactions.update((rows) =>
      rows.map((t) => (t.id === old.id ? { ...t, project_id: parent } : t)),
    );
  }
}
