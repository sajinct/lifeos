import { scheduledEvent } from '../../shared/utilities/calendar';
import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Icon } from '../../shared/components/icon';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { Task } from '../../core/models/domain';
import { localDate } from '../../shared/utilities/finance';
@Component({
  selector: 'app-dashboard',
  imports: [Icon, RouterLink, DatePipe],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  readonly store = inject(LifeStore);
  readonly activeGoals = computed(() => this.store.goals().filter((g) => g.status === 'active'));
  readonly ui = inject(UiService);
  readonly now = new Date();
  readonly today = localDate();
  readonly taskFilter = signal('today');
  readonly greeting =
    this.now.getHours() < 12
      ? 'Good morning'
      : this.now.getHours() < 17
        ? 'Good afternoon'
        : 'Good evening';
  readonly todayTasks = computed(() =>
    this.store
      .tasks()
      .filter((t) => this.taskFilter() === 'all' || t.due_date === this.today)
      .slice(0, 5),
  );
  readonly dayEvents = computed(() =>
    this.store
      .events()
      .filter(scheduledEvent)
      .filter((e) => localDate(new Date(e.starts_at)) === this.today)
      .slice(0, 3),
  );
  readonly completedToday = computed(
    () => this.store.tasks().filter((t) => t.status === 'done' && t.due_date === this.today).length,
  );
  readonly totalToday = computed(
    () => this.store.tasks().filter((t) => t.due_date === this.today).length,
  );
  readonly activeProjects = computed(() =>
    this.store.projects().filter((p) => p.status === 'active'),
  );
  readonly categories = computed(() => {
    const map = new Map<string, number>();
    for (const t of this.store.monthlyEntries().filter((t) => t.kind === 'expense'))
      map.set(t.category, (map.get(t.category) ?? 0) + Number(t.amount));
    return Array.from(map, ([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 4);
  });
  readonly monthDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - d.getDay() + i);
    return {
      name: d.toLocaleDateString('en', { weekday: 'short' }).slice(0, 1),
      date: d.getDate(),
      today: localDate(d) === this.today,
    };
  });
  shown(widget: string) {
    return this.store.widgets().includes(widget);
  }
  async toggle(task: Task) {
    try {
      await this.store.toggleTask(task);
    } catch (e) {
      this.ui.notify(this.store.message(e));
    }
  }
}
