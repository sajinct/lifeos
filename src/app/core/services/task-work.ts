import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Task, TaskTime } from '../models/domain';
import { manualSeconds, timerSeconds } from '../../shared/utilities/task-time';
import { supportedDate } from '../../shared/utilities/habits';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Injectable({ providedIn: 'root' })
export class TaskWork {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  readonly now = signal(Date.now());
  readonly today = computed(() => {
    this.now();
    return subscriptionToday(this.store.profile()?.timezone ?? 'UTC');
  });
  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
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
  private async reload(c: ReturnType<TaskWork['context']>) {
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
  private base(c: ReturnType<TaskWork['context']>) {
    const time = new Date().toISOString();
    return {
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: time,
      updated_at: time,
    };
  }
  private readTask(task: Task, c: ReturnType<TaskWork['context']>) {
    if (
      task.workspace_id !== c.w ||
      !this.store
        .tasks()
        .some((t) => t.id === task.id && (t.owner_id === c.user || t.visibility === 'workspace'))
    )
      throw new Error('Task is inaccessible.');
  }
  async assign(task: Task, assignee: string) {
    const c = this.context();
    if (task.workspace_id !== c.w || task.visibility !== 'workspace' || !this.store.canEdit(task))
      throw new Error('An editable shared task is required.');
    if (
      assignee &&
      !this.store.members().some((m) => m.workspace_id === c.w && m.user_id === assignee)
    )
      throw new Error('Choose a current workspace member.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('assign_workspace_task', {
        entry: task.id,
        expected_revision: task.revision,
        assignee: assignee || null,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.tasks().find((t) => t.id === task.id);
    if (!old) throw new Error('Task is inaccessible.');
    if (old.assignee_id === (assignee || null)) return;
    if (old.revision !== task.revision) throw new Error('Task changed; refresh and try again.');
    this.store.tasks.update((rows) =>
      rows.map((t) =>
        t.id === task.id ? { ...t, assignee_id: assignee || null, revision: t.revision + 1 } : t,
      ),
    );
  }
  async manual(
    id: string,
    task: Task | null,
    day: string,
    minutes: string,
    notes: string,
    previous?: TaskTime,
  ) {
    const c = this.context(),
      seconds = manualSeconds(minutes);
    if (!supportedDate(day) || day > this.today() || notes.length > 2000)
      throw new Error('Choose a past or current date and notes up to 2000 characters.');
    if (previous) {
      if (
        previous.workspace_id !== c.w ||
        previous.owner_id !== c.user ||
        previous.mode !== 'manual'
      )
        throw new Error('Time entry is inaccessible.');
    } else {
      if (!task) throw new Error('Choose a task.');
      this.readTask(task, c);
    }
    const parent = previous ? previous.task_id : (task?.id ?? null);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_manual_task_time', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        parent,
        work_day: day,
        duration_seconds: seconds,
        entry_notes: notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.taskTimes().find((e) => e.id === id);
    if (old) {
      if (
        old.owner_id !== c.user ||
        old.workspace_id !== c.w ||
        old.mode !== 'manual' ||
        old.task_id !== parent
      )
        throw new Error('Time entry is inaccessible.');
      if (!previous) return;
      if (old.status !== 'recorded' || old.revision !== previous.revision)
        throw new Error('Time entry changed; refresh and try again.');
    } else if (previous) throw new Error('Time entry is inaccessible.');
    const project = this.store.projects().find((p) => p.id === task?.project_id);
    const row: TaskTime = {
      ...this.base(c),
      id,
      task_id: parent,
      task_title: old?.task_title ?? task!.title,
      project_id: old ? old.project_id : (project?.id ?? null),
      project_title: old ? old.project_title : (project?.title ?? ''),
      mode: 'manual',
      status: 'recorded',
      logged_on: day,
      seconds,
      started_at: null,
      ended_at: null,
      notes: notes.trim(),
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? new Date().toISOString(),
    };
    this.store.taskTimes.update((rows) => [row, ...rows.filter((e) => e.id !== id)]);
  }
  async start(id: string, task: Task, notes: string) {
    const c = this.context();
    this.readTask(task, c);
    if (notes.length > 2000) throw new Error('Notes must be at most 2000 characters.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('start_task_timer', { entry: id, w: c.w, parent: task.id, entry_notes: notes });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.taskTimes().find((e) => e.id === id);
    if (old) {
      if (
        old.workspace_id !== c.w ||
        old.owner_id !== c.user ||
        old.task_id !== task.id ||
        old.mode !== 'timer'
      )
        throw new Error('Time entry is inaccessible.');
      return;
    }
    if (this.store.taskTimes().some((e) => e.owner_id === c.user && e.status === 'running'))
      throw new Error('Stop the running timer in this workspace first.');
    const project = this.store.projects().find((p) => p.id === task.project_id),
      time = new Date().toISOString();
    this.store.taskTimes.update((rows) => [
      ...rows,
      {
        ...this.base(c),
        id,
        task_id: task.id,
        task_title: task.title,
        project_id: project?.id ?? null,
        project_title: project?.title ?? '',
        mode: 'timer',
        status: 'running',
        logged_on: this.today(),
        seconds: 0,
        started_at: time,
        ended_at: null,
        notes: notes.trim(),
        revision: 1,
      },
    ]);
  }
  async action(entry: TaskTime, action: 'stop' | 'void' | 'restore') {
    const c = this.context();
    if (entry.workspace_id !== c.w || entry.owner_id !== c.user)
      throw new Error('Time entry is inaccessible.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('act_on_task_time', { entry: entry.id, expected_revision: entry.revision, action });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.taskTimes().find((e) => e.id === entry.id);
    if (!old) throw new Error('Time entry is inaccessible.');
    const target = action === 'void' ? 'void' : 'recorded';
    if (action === 'stop' && old.mode !== 'timer') throw new Error('Choose stop, void or restore.');
    if (old.status === target) return;
    if (
      old.revision !== entry.revision ||
      (action === 'stop' && old.status !== 'running') ||
      (action === 'restore' && old.status !== 'void')
    )
      throw new Error('Time entry changed; refresh and try again.');
    const seconds =
      old.status === 'running' ? Math.max(1, timerSeconds(old, Date.now())) : old.seconds;
    this.store.taskTimes.update((rows) =>
      rows.map((e) =>
        e.id === old.id
          ? {
              ...e,
              status: target,
              seconds,
              ended_at:
                e.status === 'running'
                  ? new Date(Date.parse(e.started_at!) + seconds * 1000).toISOString()
                  : e.ended_at,
              revision: e.revision + 1,
            }
          : e,
      ),
    );
  }
}
