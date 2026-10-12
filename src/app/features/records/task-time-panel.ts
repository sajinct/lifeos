import { Component, inject, signal, computed, effect, input, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Task, TaskTime } from '../../core/models/domain';
import { LifeStore } from '../../core/services/life-store';
import { TaskWork } from '../../core/services/task-work';
import { duration, timerSeconds, timeSummary, timeCsv } from '../../shared/utilities/task-time';
import { supportedDate } from '../../shared/utilities/habits';
@Component({
  selector: 'app-task-time',
  imports: [ReactiveFormsModule, DatePipe],
  templateUrl: './task-time-panel.html',
})
export class TaskTimePanel {
  readonly store = inject(LifeStore);
  readonly work = inject(TaskWork);
  readonly selectedTask = input<Task>();
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly previous = signal<TaskTime | undefined>(undefined);
  readonly from = signal(this.work.today().slice(0, 7) + '-01');
  readonly until = signal(this.work.today());
  readonly group = signal<'task' | 'project'>('task');
  readonly showVoid = signal(false);
  readonly rangeError = computed(
    () => !supportedDate(this.from()) || !supportedDate(this.until()) || this.from() > this.until(),
  );
  readonly running = computed(() =>
    this.store
      .taskTimes()
      .find((e) => e.owner_id === this.store.profile()?.id && e.status === 'running'),
  );
  readonly history = computed(() =>
    this.store
      .taskTimes()
      .filter(
        (e) =>
          !this.rangeError() &&
          e.owner_id === this.store.profile()?.id &&
          e.status !== 'running' &&
          (this.showVoid() || e.status === 'recorded') &&
          e.logged_on >= this.from() &&
          e.logged_on <= this.until(),
      )
      .sort(
        (a, b) =>
          b.logged_on.localeCompare(a.logged_on) || b.created_at.localeCompare(a.created_at),
      ),
  );
  readonly summaries = computed(() => timeSummary(this.history(), this.group()));
  readonly totals = computed(() =>
    this.history()
      .filter((e) => e.status === 'recorded')
      .reduce((s, e) => s + e.seconds, 0),
  );
  readonly sessions = computed(() => this.history().filter((e) => e.status === 'recorded').length);
  readonly elapsed = computed(() => {
    const r = this.running();
    return r ? duration(timerSeconds(r, this.work.now())) : '00:00:00';
  });
  readonly form = inject(FormBuilder).nonNullable.group({
    task: [''],
    day: [this.work.today()],
    minutes: ['30'],
    notes: [''],
  });
  private manualRequest: string = crypto.randomUUID();
  private timerRequest: string = crypto.randomUUID();
  readonly format = duration;
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => {
        this.reset();
        this.timerRequest = crypto.randomUUID();
        this.from.set(this.work.today().slice(0, 7) + '-01');
        this.until.set(this.work.today());
        this.error.set('');
        this.open.set(false);
      });
    });
    effect(() => {
      const task = this.selectedTask();
      if (task && !this.previous()) {
        this.form.controls.task.setValue(task.id);
        this.open.set(true);
      }
    });
  }
  reset() {
    this.previous.set(undefined);
    this.form.controls.task.enable();
    this.form.reset({
      task: this.selectedTask()?.id ?? '',
      day: this.work.today(),
      minutes: '30',
      notes: '',
    });
    this.manualRequest = crypto.randomUUID();
  }
  edit(entry: TaskTime) {
    this.previous.set(entry);
    this.manualRequest = entry.id;
    this.form.reset({
      task: entry.task_id ?? '',
      day: entry.logged_on,
      minutes: String(entry.seconds / 60),
      notes: entry.notes,
    });
    this.form.controls.task.disable();
    this.open.set(true);
    this.error.set('');
  }
  private async perform(action: () => Promise<void>, after?: () => void) {
    if (this.busy()) return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      if (w === this.store.workspace()?.id && session === this.store.fileSession()) after?.();
    } catch (e) {
      if (w === this.store.workspace()?.id && session === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async record() {
    const v = this.form.getRawValue(),
      task = this.store.tasks().find((t) => t.id === v.task) ?? null;
    await this.perform(
      () => this.work.manual(this.manualRequest, task, v.day, v.minutes, v.notes, this.previous()),
      () => this.reset(),
    );
  }
  async start() {
    const v = this.form.getRawValue(),
      task = this.store.tasks().find((t) => t.id === v.task);
    if (!task) {
      this.error.set('Choose a task.');
      return;
    }
    await this.perform(
      () => this.work.start(this.timerRequest, task, v.notes),
      () => {
        this.timerRequest = crypto.randomUUID();
      },
    );
  }
  async act(entry: TaskTime, action: 'stop' | 'void' | 'restore') {
    await this.perform(() => this.work.action(entry, action));
  }
  export() {
    const text = timeCsv(this.history()),
      url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-time-${this.from()}-${this.until()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
