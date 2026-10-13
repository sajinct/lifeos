import { Component, inject, signal, computed, effect, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { LifeStore } from '../../core/services/life-store';
import { ProjectPlanning } from '../../core/services/project-planning';
import { UiService } from '../../core/services/ui';
import {
  Project,
  ProjectMilestone,
  ProjectBudget,
  ProjectInput,
  Task,
  Transaction,
} from '../../core/models/domain';
import {
  projectTotals,
  projectSummary,
  projectsCsv,
  projectMilestonesCsv,
} from '../../shared/utilities/project-planning';
import { duration } from '../../shared/utilities/task-time';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-projects',
  imports: [DatePipe, RouterLink, ReactiveFormsModule, Icon],
  templateUrl: './projects.html',
})
export class ProjectsPage {
  readonly store = inject(LifeStore);
  readonly library = inject(ProjectPlanning);
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly params = toSignal(this.route.queryParamMap);
  readonly search = signal(String(history.state?.search ?? ''));
  readonly status = signal('all');
  readonly selectedId = signal('');
  readonly selected = computed(() => this.store.projects().find((p) => p.id === this.selectedId()));
  readonly linked = computed(() => this.params()?.get('linked'));
  readonly projects = computed(() =>
    this.store
      .projects()
      .filter((p) =>
        this.linked()
          ? p.id === this.linked()
          : p.title.toLowerCase().includes(this.search().toLowerCase()) &&
            (this.status() === 'all' || p.status === this.status()),
      ),
  );
  readonly summaries = computed(
    () =>
      new Map(
        this.store
          .projects()
          .map((p) => [
            p.id,
            projectSummary(
              p,
              this.store.projectMilestones(),
              this.store.tasks(),
              this.store.taskTimes(),
              this.store.profile()?.id ?? '',
            ),
          ]),
      ),
  );
  readonly steps = computed(() =>
    this.store
      .projectMilestones()
      .filter((m) => m.project_id === this.selectedId() && (this.showArchived() || !m.archived))
      .sort(
        (a, b) =>
          Number(a.archived) - Number(b.archived) ||
          (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') ||
          a.created_at.localeCompare(b.created_at) ||
          a.id.localeCompare(b.id),
      ),
  );
  readonly budgets = computed(() =>
    this.store
      .projectBudgets()
      .filter((b) => b.project_id === this.selectedId() && b.owner_id === this.store.profile()?.id)
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  );
  readonly selectedTasks = computed(() =>
    this.store.tasks().filter((t) => t.project_id === this.selectedId()),
  );
  readonly ownExpenses = computed(() =>
    this.store
      .transactions()
      .filter(
        (t) =>
          t.workspace_id === this.store.workspace()?.id &&
          t.owner_id === this.store.profile()?.id &&
          t.kind === 'expense',
      ),
  );
  readonly linkedExpenses = computed(() =>
    this.ownExpenses().filter((t) => t.project_id === this.selectedId()),
  );
  readonly unlinkedExpenses = computed(() => this.ownExpenses().filter((t) => !t.project_id));
  readonly totals = computed(() => {
    const p = this.selected();
    try {
      return {
        rows: p
          ? projectTotals(
              p,
              this.store.projectBudgets(),
              this.store.transactions(),
              this.store.accounts(),
              this.store.profile()?.id ?? '',
            )
          : [],
        error: '',
      };
    } catch (e) {
      return { rows: [], error: this.store.message(e) };
    }
  });
  readonly busy = signal(false);
  readonly error = signal('');
  readonly showArchived = signal(false);
  readonly projectEditor = signal(false);
  readonly previousProject = signal<Project | undefined>(undefined);
  readonly milestoneEditor = signal(false);
  readonly previousMilestone = signal<ProjectMilestone | undefined>(undefined);
  readonly budgetEditor = signal(false);
  readonly previousBudget = signal<ProjectBudget | undefined>(undefined);
  private projectRequest: string = crypto.randomUUID();
  private milestoneRequest: string = crypto.randomUUID();
  private budgetRequest: string = crypto.randomUUID();
  readonly projectForm = inject(FormBuilder).nonNullable.group({
    title: [''],
    description: [''],
    status: ['active'],
    color: ['purple'],
    due_date: [''],
    visibility: ['private'],
  });
  readonly milestoneForm = inject(FormBuilder).nonNullable.group({
    title: [''],
    due_on: [''],
    notes: [''],
  });
  readonly budgetForm = inject(FormBuilder).nonNullable.group({
    currency: [this.store.currency()],
    amount: [''],
  });
  readonly expenseForm = inject(FormBuilder).nonNullable.group({ expense: [''] });
  readonly duration = duration;
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => {
        this.selectedId.set(this.linked() ?? '');
        this.projectEditor.set(false);
        this.milestoneEditor.set(false);
        this.budgetEditor.set(false);
        this.error.set('');
        this.showArchived.set(false);
        this.status.set('all');
      });
    });
    effect(() => {
      const id = this.linked();
      if (id) this.selectedId.set(id);
    });
  }
  summary(p: Project) {
    return this.summaries().get(p.id)!;
  }
  money(value: number, currency: string) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  }
  expenseLabel(t: Transaction) {
    const currency =
      this.store.accounts().find((a) => a.id === t.account_id)?.currency ?? this.store.currency();
    return `${t.title} · ${this.money(Number(t.amount), currency)} · ${t.booked_on}`;
  }
  open(p: Project) {
    this.selectedId.set(p.id);
    this.milestoneEditor.set(false);
    this.budgetEditor.set(false);
    this.expenseForm.reset();
    this.error.set('');
  }
  clearLinked() {
    void this.router.navigate([], { queryParams: { linked: null }, queryParamsHandling: 'merge' });
    this.selectedId.set('');
  }
  editProject(p?: Project) {
    this.previousProject.set(p);
    this.projectRequest = p?.id ?? crypto.randomUUID();
    this.projectForm.reset({
      title: p?.title ?? '',
      description: p?.description ?? '',
      status: p?.status ?? 'active',
      color: p?.color ?? 'purple',
      due_date: p?.due_date ?? '',
      visibility: p?.visibility ?? 'private',
    });
    this.projectEditor.set(true);
    this.error.set('');
  }
  editMilestone(m?: ProjectMilestone) {
    this.previousMilestone.set(m);
    this.milestoneRequest = m?.id ?? crypto.randomUUID();
    this.milestoneForm.reset({
      title: m?.title ?? '',
      due_on: m?.due_on ?? '',
      notes: m?.notes ?? '',
    });
    this.milestoneEditor.set(true);
    this.error.set('');
  }
  editBudget(b?: ProjectBudget) {
    this.previousBudget.set(b);
    this.budgetRequest = b?.id ?? crypto.randomUUID();
    this.budgetForm.controls.currency.enable();
    this.budgetForm.reset({
      currency: b?.currency ?? this.store.currency(),
      amount: b ? String(b.amount) : '',
    });
    if (b) this.budgetForm.controls.currency.disable();
    this.budgetEditor.set(true);
    this.error.set('');
  }
  private async perform(action: () => Promise<void>, message: string, after?: () => void) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (w === this.store.workspace()?.id && session === this.store.fileSession()) {
        after?.();
        this.ui.notify(message);
      }
    } catch (e) {
      if (w === this.store.workspace()?.id && session === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async saveProject() {
    await this.perform(
      () =>
        this.library.saveProject(
          this.projectRequest,
          this.projectForm.getRawValue() as ProjectInput,
          this.previousProject(),
        ),
      'Project saved',
      () => {
        this.projectEditor.set(false);
        this.selectedId.set(this.projectRequest);
      },
    );
  }
  async saveMilestone() {
    const p = this.selected();
    if (!p) return;
    const v = this.milestoneForm.getRawValue();
    await this.perform(
      () =>
        this.library.saveMilestone(
          this.milestoneRequest,
          p,
          v.title,
          v.due_on,
          v.notes,
          this.previousMilestone(),
        ),
      'Milestone saved',
      () => this.milestoneEditor.set(false),
    );
  }
  async milestoneAction(
    m: ProjectMilestone,
    action: 'complete' | 'reopen' | 'archive' | 'restore',
  ) {
    await this.perform(() => this.library.milestoneAction(m, action), 'Milestone updated');
  }
  async saveBudget() {
    const p = this.selected();
    if (!p) return;
    const v = this.budgetForm.getRawValue();
    await this.perform(
      () =>
        this.library.saveBudget(this.budgetRequest, p, v.currency, v.amount, this.previousBudget()),
      'Budget saved',
      () => this.budgetEditor.set(false),
    );
  }
  async archiveBudget(b: ProjectBudget) {
    await this.perform(() => this.library.archiveBudget(b, !b.archived), 'Budget updated');
  }
  async linkExpense() {
    const p = this.selected(),
      t = this.unlinkedExpenses().find((t) => t.id === this.expenseForm.getRawValue().expense);
    if (!p || !t) {
      this.error.set('Choose a recorded expense.');
      return;
    }
    await this.perform(
      () => this.library.linkExpense(t, p),
      'Expense linked',
      () => this.expenseForm.reset(),
    );
  }
  async unlinkExpense(t: Transaction) {
    await this.perform(() => this.library.linkExpense(t, null), 'Expense link removed');
  }
  async toggleTask(t: Task) {
    await this.perform(() => this.store.toggleTask(t), 'Task updated');
  }
  export(kind: 'projects' | 'milestones') {
    try {
      const rows = this.selected() ? [this.selected()!] : this.projects(),
        user = this.store.profile()?.id ?? '',
        text =
          kind === 'projects'
            ? projectsCsv(
                rows,
                this.store.projectMilestones(),
                this.store.projectBudgets(),
                this.store.tasks(),
                this.store.taskTimes(),
                this.store.transactions(),
                this.store.accounts(),
                user,
              )
            : projectMilestonesCsv(
                this.store.projectMilestones().filter((m) => this.showArchived() || !m.archived),
                rows,
              );
      const url = URL.createObjectURL(
          new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
        ),
        a = document.createElement('a');
      a.href = url;
      a.download = `lifeos-${kind}-${this.library.today()}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
}
