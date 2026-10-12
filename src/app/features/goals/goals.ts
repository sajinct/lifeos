import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe, TitleCasePipe } from '@angular/common';
import { FormBuilder, FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { HabitLibrary } from '../../core/services/habits';
import { UiService } from '../../core/services/ui';
import { Goal, GoalMilestone, Habit, Visibility } from '../../core/models/domain';
import {
  WEEKDAYS,
  habitDue,
  habitStats,
  shiftDay,
  goalsCsv,
  habitsCsv,
  checkinsCsv,
} from '../../shared/utilities/habits';
@Component({
  selector: 'app-goals',
  imports: [DatePipe, TitleCasePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './goals.html',
})
export class GoalsPage {
  readonly library = inject(HabitLibrary);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  private readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly selectedId = computed(
    () => this.params()?.get('record') ?? this.params()?.get('reminder'),
  );
  readonly tab = signal<'goals' | 'habits'>('goals');
  readonly search = signal('');
  readonly statusFilter = signal('active');
  readonly periodFilter = signal('all');
  readonly routineFilter = signal('all');
  readonly day = signal(this.library.today());
  private observedDay = this.library.today();
  readonly weekdays = WEEKDAYS;
  readonly ownedHabits = computed(() =>
    this.store
      .habits()
      .filter(
        (h) =>
          h.owner_id === this.store.profile()?.id && h.workspace_id === this.store.workspace()?.id,
      ),
  );
  readonly goalRows = computed(() =>
    this.store
      .goals()
      .filter((g) =>
        this.selectedId()
          ? g.id === this.selectedId()
          : (this.statusFilter() === 'all' || g.status === this.statusFilter()) &&
            (this.periodFilter() === 'all' || g.period === this.periodFilter()) &&
            [g.title, g.notes, g.unit]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort(
        (a, b) =>
          (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') ||
          a.title.localeCompare(b.title),
      ),
  );
  readonly habitRows = computed(() =>
    this.ownedHabits()
      .filter((h) =>
        this.selectedId()
          ? h.id === this.selectedId()
          : (this.statusFilter() === 'all' || h.status === this.statusFilter()) &&
            (this.routineFilter() === 'all' ||
              (h.routine || 'Ungrouped') === this.routineFilter()) &&
            [h.title, h.routine, h.notes]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => a.title.localeCompare(b.title)),
  );
  readonly routines = computed(() =>
    [...new Set(this.ownedHabits().map((h) => h.routine || 'Ungrouped'))].sort(),
  );
  readonly habitStatistics = computed(
    () =>
      new Map(
        this.ownedHabits().map((h) => [
          h.id,
          habitStats(
            h,
            this.store.habitPeriods(),
            this.store.habitCheckins(),
            this.library.today(),
          ),
        ]),
      ),
  );
  readonly groups = computed(() =>
    [...new Set(this.habitRows().map((h) => h.routine || 'Ungrouped'))].sort().map((name) => ({
      name,
      habits: this.habitRows().filter((h) => (h.routine || 'Ungrouped') === name),
    })),
  );
  readonly summary = computed(() => {
    const goals = this.store
        .goals()
        .filter((g) => g.owner_id === this.store.profile()?.id && g.status === 'active'),
      habits = this.ownedHabits().filter((h) => h.status !== 'archived');
    const stats = habits.map((h) => this.stats(h)),
      scheduled = stats.reduce((s, r) => s + r.scheduled, 0),
      done = stats.reduce((s, r) => s + r.done, 0);
    return {
      goals: goals.length,
      achieved: goals.filter((g) => Number(g.current) >= Number(g.target)).length,
      habits: habits.filter((h) => h.status === 'active').length,
      rate: scheduled ? Math.round((done / scheduled) * 100) : 0,
      scheduled,
    };
  });
  readonly busy = signal(false);
  readonly error = signal('');
  readonly formKind = signal<'goal' | 'habit' | 'milestone' | null>(null);
  readonly editingGoal = signal<Goal | null>(null);
  readonly editingHabit = signal<Habit | null>(null);
  readonly editingMilestone = signal<GoalMilestone | null>(null);
  private request: string = crypto.randomUUID();
  private readonly fb = inject(FormBuilder);
  readonly goalForm = this.fb.nonNullable.group({
    title: '',
    target: '1',
    current: '0',
    unit: '',
    due_date: '',
    period: 'long_term' as Goal['period'],
    color: 'purple',
    notes: '',
    visibility: 'private' as Visibility,
  });
  readonly habitForm = this.fb.nonNullable.group({
    title: '',
    routine: 'Morning',
    notes: '',
    starts_on: this.library.today(),
    weekdays: new FormControl<number[]>([1, 2, 3, 4, 5, 6, 7], { nonNullable: true }),
  });
  readonly milestoneForm = this.fb.nonNullable.group({
    goal_id: '',
    title: '',
    due_on: '',
    notes: '',
  });
  constructor() {
    effect(() => {
      const today = this.library.today();
      if (this.day() === this.observedDay) this.day.set(today);
      this.observedDay = today;
    });
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.close();
      this.error.set('');
      this.day.set(this.library.today());
    });
    effect(() => {
      const id = this.selectedId();
      if (id) this.tab.set(this.ownedHabits().some((h) => h.id === id) ? 'habits' : 'goals');
    });
  }
  select(tab: 'goals' | 'habits') {
    this.tab.set(tab);
    this.statusFilter.set('active');
    this.close();
    void this.router.navigate(['/goals']);
  }
  close() {
    this.formKind.set(null);
    this.editingGoal.set(null);
    this.editingHabit.set(null);
    this.editingMilestone.set(null);
  }
  minDay() {
    return shiftDay(this.library.today(), -365);
  }
  scheduled(h: Habit) {
    return habitDue(h, this.store.habitPeriods(), this.day());
  }
  check(h: Habit) {
    return this.store
      .habitCheckins()
      .find((c) => c.habit_id === h.id && c.completed_on === this.day());
  }
  stats(h: Habit) {
    return this.habitStatistics().get(h.id)!;
  }
  schedule(h: Habit) {
    return h.weekdays.length === 7
      ? 'Every day'
      : h.weekdays.map((d) => WEEKDAYS[d - 1]).join(', ');
  }
  milestones(g: Goal) {
    return this.store
      .goalMilestones()
      .filter((m) => m.goal_id === g.id && m.owner_id === this.store.profile()?.id)
      .sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') ||
          a.title.localeCompare(b.title),
      );
  }
  own(g: Goal) {
    return g.owner_id === this.store.profile()?.id;
  }
  addGoal(g?: Goal) {
    this.close();
    this.editingGoal.set(g ?? null);
    this.request = g?.id ?? crypto.randomUUID();
    this.goalForm.reset(
      g
        ? { ...g, target: String(g.target), current: String(g.current), due_date: g.due_date ?? '' }
        : {
            title: '',
            target: '1',
            current: '0',
            unit: '',
            due_date: '',
            period: 'long_term',
            color: 'purple',
            notes: '',
            visibility: 'private',
          },
    );
    this.formKind.set('goal');
  }
  addHabit(h?: Habit) {
    this.close();
    this.editingHabit.set(h ?? null);
    this.request = h?.id ?? crypto.randomUUID();
    this.habitForm.reset(
      h ?? {
        title: '',
        routine: 'Morning',
        notes: '',
        starts_on: this.library.today(),
        weekdays: [1, 2, 3, 4, 5, 6, 7],
      },
    );
    this.formKind.set('habit');
  }
  weekday(day: number, checked: boolean) {
    const c = this.habitForm.controls.weekdays;
    c.setValue(
      checked
        ? [...new Set([...c.value, day])].sort((a, b) => a - b)
        : c.value.filter((d) => d !== day),
    );
  }
  addMilestone(g: Goal, m?: GoalMilestone) {
    this.close();
    this.editingMilestone.set(m ?? null);
    this.request = m?.id ?? crypto.randomUUID();
    this.milestoneForm.reset(
      m ? { ...m, due_on: m.due_on ?? '' } : { goal_id: g.id, title: '', due_on: '', notes: '' },
    );
    this.formKind.set('milestone');
  }
  goalTitle(id: string) {
    return this.store.goals().find((g) => g.id === id)?.title ?? 'Goal';
  }
  async save() {
    await this.run(async () => {
      if (this.formKind() === 'goal')
        await this.library.saveGoal(
          this.request,
          this.goalForm.getRawValue(),
          this.editingGoal() ?? undefined,
        );
      else if (this.formKind() === 'habit')
        await this.library.saveHabit(
          this.request,
          this.habitForm.getRawValue(),
          this.editingHabit() ?? undefined,
        );
      else
        await this.library.saveMilestone(
          this.request,
          this.milestoneForm.getRawValue(),
          this.editingMilestone() ?? undefined,
        );
      this.close();
      this.ui.notify('Record saved');
    });
  }
  async progress(g: Goal, value: string) {
    await this.run(async () => {
      await this.store.updateGoal(g, value);
      this.ui.notify('Goal progress updated');
    });
  }
  async archiveGoal(g: Goal) {
    await this.run(async () => {
      await this.library.archiveGoal(g);
      this.ui.notify(g.status === 'active' ? 'Goal archived' : 'Goal restored');
    });
  }
  async status(h: Habit, target: Habit['status']) {
    await this.run(async () => {
      await this.library.status(h, target);
      this.ui.notify('Habit status updated');
    });
  }
  async toggle(h: Habit) {
    await this.run(async () => {
      const previous = this.check(h);
      await this.library.checkin(h, this.day(), !previous?.done, previous);
      this.ui.notify(previous?.done ? 'Check-in undone' : 'Habit completed');
    });
  }
  async milestoneDone(m: GoalMilestone) {
    await this.run(async () => {
      await this.library.milestoneDone(m, !m.done);
      this.ui.notify(m.done ? 'Milestone reopened' : 'Milestone completed');
    });
  }
  export(history = false) {
    if (this.store.loading() || this.store.error()) return;
    const text =
      this.tab() === 'goals'
        ? goalsCsv(this.goalRows(), this.store.goalMilestones())
        : history
          ? checkinsCsv(this.habitRows(), this.store.habitCheckins())
          : habitsCsv(
              this.habitRows(),
              this.store.habitPeriods(),
              this.store.habitCheckins(),
              this.library.today(),
            );
    if (!text) return;
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-${history ? 'checkins' : this.tab()}-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  private async run(action: () => Promise<void>) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      if (w === this.store.workspace()?.id && s === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
