import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Task, TaskList, TaskSeries, TaskChecklist, Frequency } from '../models/domain';
import { supportedDate } from '../../shared/utilities/habits';
@Injectable({ providedIn: 'root' })
export class TaskLibrary {
  async removeItem(item: TaskChecklist) {
    const c = this.context(),
      task = this.store.tasks().find((t) => t.id === item.task_id);
    if (!task || task.workspace_id !== c.w || !this.store.canEdit(task))
      throw new Error('Task is inaccessible.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend
        .requireClient()
        .rpc('remove_task_checklist', { entry: item.id, expected_revision: item.revision });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (task.status === 'done') throw new Error('Reopen the task before editing its checklist.');
    const old = this.store.taskChecklist().find((i) => i.id === item.id);
    if (!old) return;
    if (old.revision !== item.revision)
      throw new Error('Checklist changed; refresh and try again.');
    this.store.taskChecklist.update((rows) => rows.filter((i) => i.id !== item.id));
  }
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
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
  private async reload(c: ReturnType<TaskLibrary['context']>) {
    if (
      c.w !== this.store.workspace()?.id ||
      c.user !== this.store.profile()?.id ||
      c.session !== this.store.fileSession()
    )
      return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<TaskLibrary['context']>) {
    const time = new Date().toISOString();
    return {
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: time,
      updated_at: time,
    };
  }
  async saveList(id: string, name: string, archived = false, previous?: TaskList) {
    const c = this.context();
    name = name.trim();
    if (!name || name.length > 100) throw new Error('Enter a list name of 1–100 characters.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_task_list', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        list_name: name,
        is_archived: archived,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.taskLists().find((l) => l.id === id);
    if (old) {
      if (old.owner_id !== c.user || old.workspace_id !== c.w)
        throw new Error('List is inaccessible.');
      if (!previous) return;
      if (old.revision !== previous.revision)
        throw new Error('List changed; refresh and try again.');
    } else if (previous) throw new Error('List is inaccessible.');
    this.store.taskLists.update((rows) => [
      {
        ...this.base(c),
        id,
        name,
        archived,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? new Date().toISOString(),
      },
      ...rows.filter((l) => l.id !== id),
    ]);
  }
  async configure(task: Task, list: string, frequency: '' | Frequency) {
    const c = this.context();
    if (task.workspace_id !== c.w || task.owner_id !== c.user || task.visibility !== 'private')
      throw new Error('A private task you own is required.');
    if (
      list &&
      !this.store
        .taskLists()
        .some(
          (l) => l.id === list && l.workspace_id === c.w && l.owner_id === c.user && !l.archived,
        )
    )
      throw new Error('Choose an active list you own.');
    if (
      frequency &&
      (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency) ||
        task.series_id ||
        task.status === 'done' ||
        !task.due_date ||
        !supportedDate(task.due_date))
    )
      throw new Error('Use a pending one-off task with a valid due date.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('configure_task', {
        entry: task.id,
        expected_revision: task.revision,
        task_list: list || null,
        repeat_frequency: frequency || null,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.tasks().find((t) => t.id === task.id);
    if (!old || old.revision !== task.revision)
      throw new Error('Task changed; refresh and try again.');
    const id = frequency ? crypto.randomUUID() : null;
    if (id)
      this.store.taskSeries.update((rows) => [
        ...rows,
        {
          ...this.base(c),
          id,
          frequency: frequency as Frequency,
          anchor_on: task.due_date!,
          active: true,
          revision: 1,
        },
      ]);
    this.store.tasks.update((rows) =>
      rows.map((t) =>
        t.id === task.id
          ? {
              ...t,
              list_id: list || null,
              series_id: id ?? t.series_id,
              occurrence_index: id ? 0 : t.occurrence_index,
              revision: t.revision + 1,
            }
          : t,
      ),
    );
  }
  async setRepeat(series: TaskSeries, active: boolean) {
    const c = this.context();
    if (series.workspace_id !== c.w || series.owner_id !== c.user)
      throw new Error('Repeat is inaccessible.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('set_task_series_active', {
        entry: series.id,
        expected_revision: series.revision,
        enabled: active,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.taskSeries().find((s) => s.id === series.id);
    if (!old) throw new Error('Repeat is inaccessible.');
    if (old.active === active) return;
    if (old.revision !== series.revision) throw new Error('Repeat changed; refresh and try again.');
    this.store.taskSeries.update((rows) =>
      rows.map((s) => (s.id === series.id ? { ...s, active, revision: s.revision + 1 } : s)),
    );
    const latest = this.store
      .tasks()
      .filter((t) => t.series_id === series.id)
      .sort((a, b) => (b.occurrence_index ?? 0) - (a.occurrence_index ?? 0))[0];
    if (active && latest) this.store.generateNextTask(latest);
  }
  async saveItem(id: string, task: Task, title: string, done = false, previous?: TaskChecklist) {
    const c = this.context();
    title = title.trim();
    if (task.workspace_id !== c.w || !this.store.canEdit(task))
      throw new Error('Task is inaccessible.');
    if (!title || title.length > 200)
      throw new Error('Enter a checklist title of 1–200 characters.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_task_checklist', {
        entry: id,
        parent: task.id,
        expected_revision: previous?.revision ?? null,
        item_title: title,
        completed: done,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const parent = this.store.tasks().find((t) => t.id === task.id);
    if (!parent || parent.status === 'done')
      throw new Error('Reopen the task before editing its checklist.');
    const old = this.store.taskChecklist().find((i) => i.id === id);
    if (old) {
      if (old.task_id !== task.id || old.workspace_id !== c.w)
        throw new Error('Checklist item is inaccessible.');
      if (!previous || (old.title === title && old.done === done)) return;
      if (old.revision !== previous.revision)
        throw new Error('Checklist changed; refresh and try again.');
    } else if (previous) throw new Error('Checklist item is inaccessible.');
    if (!old && this.store.taskChecklist().filter((i) => i.task_id === task.id).length >= 100)
      throw new Error('A task can have at most 100 checklist items.');
    this.store.taskChecklist.update((rows) => [
      {
        ...this.base(c),
        id,
        owner_id: task.owner_id,
        task_id: task.id,
        title,
        done,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? new Date().toISOString(),
      },
      ...rows.filter((i) => i.id !== id),
    ]);
  }
}
