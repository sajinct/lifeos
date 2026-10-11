import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { CaptureKind, Goal, Note, Task } from '../../core/models/domain';
import { Icon } from '../../shared/components/icon';
import { accountBalance, localDate } from '../../shared/utilities/finance';
@Component({
  selector: 'app-records',
  imports: [Icon, DatePipe, DecimalPipe, NgTemplateOutlet, ReactiveFormsModule],
  templateUrl: './records.html',
})
export class Records {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly route = inject(ActivatedRoute);
  readonly router = inject(Router);
  readonly page = this.route.snapshot.url[0]?.path ?? 'tasks';
  readonly names: Record<string, string> = {
    tasks: 'Tasks',
    inbox: 'Your inbox',
    calendar: 'Calendar',
    finance: 'Finance',
    projects: 'Projects',
    goals: 'Goals',
    notes: 'Notes & knowledge',
    reports: 'Reports & exports',
  };
  readonly descriptions: Record<string, string> = {
    tasks: 'A little focus goes a long way.',
    inbox: 'Capture it now. Make room in your head.',
    calendar: 'Make time for what matters.',
    finance: 'A clearer picture of your everyday money.',
    projects: 'Turn your ideas into a little progress.',
    goals: 'Small steps toward the life you want.',
    notes: 'A home for your ideas, big and small.',
    reports: 'Your records. Your perspective. Your data.',
  };
  readonly kinds: Record<string, CaptureKind> = {
    tasks: 'task',
    inbox: 'task',
    calendar: 'event',
    finance: 'expense',
    projects: 'project',
    goals: 'goal',
    notes: 'note',
  };
  readonly search = signal(String(history.state?.search ?? ''));
  readonly filter = signal('all');
  readonly view = signal('list');
  readonly selectedDate = signal(localDate());
  readonly month = signal(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  readonly tasks = computed(() =>
    this.store
      .tasks()
      .filter(
        (t) => this.matches(t.title) && (this.filter() === 'all' || t.status === this.filter()),
      ),
  );
  readonly projects = computed(() => this.store.projects().filter((p) => this.matches(p.title)));
  readonly notes = computed(() =>
    this.store.notes().filter((n) => this.matches(n.title + ' ' + n.body)),
  );
  readonly goals = computed(() => this.store.goals().filter((g) => this.matches(g.title)));
  readonly events = computed(() =>
    this.store
      .events()
      .filter(
        (e) => localDate(new Date(e.starts_at)) === this.selectedDate() && this.matches(e.title),
      ),
  );
  readonly transactions = computed(() =>
    [...this.store.transactions()]
      .reverse()
      .filter((t) => this.matches(t.title + ' ' + t.category)),
  );
  readonly days = computed(() => {
    const m = this.month();
    const start = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const key = localDate(d);
      return {
        date: key,
        day: d.getDate(),
        current: d.getMonth() === m.getMonth(),
        today: key === localDate(),
        events: this.store.events().filter((e) => localDate(new Date(e.starts_at)) === key).length,
      };
    });
  });
  readonly transferOpen = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  private transferId = crypto.randomUUID();
  readonly transferForm = inject(FormBuilder).nonNullable.group({
    source: ['', Validators.required],
    destination: ['', Validators.required],
    amount: ['', Validators.required],
  });
  readonly statuses: Task['status'][] = ['todo', 'in_progress', 'done'];
  matches(title: string) {
    return title.toLowerCase().includes(this.search().toLowerCase());
  }
  column(status: Task['status']) {
    return this.tasks().filter((t) => t.status === status);
  }
  async toggle(task: Task) {
    try {
      await this.store.toggleTask(task);
    } catch (e) {
      this.ui.notify(this.store.message(e));
    }
  }
  async status(task: Task, event: Event) {
    try {
      await this.store.setTaskStatus(
        task,
        (event.target as HTMLSelectElement).value as Task['status'],
      );
    } catch (e) {
      this.ui.notify(this.store.message(e));
    }
  }
  async goalProgress(goal: Goal, event: Event) {
    try {
      await this.store.updateGoal(goal, (event.target as HTMLInputElement).value);
      this.ui.notify('Progress updated');
    } catch (e) {
      this.ui.notify(this.store.message(e));
    }
  }
  async delete(note: Note) {
    try {
      await this.store.deleteNote(note);
      this.ui.notify('Note deleted');
    } catch (e) {
      this.ui.notify(this.store.message(e));
    }
  }
  balance(account: Parameters<typeof accountBalance>[0]) {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: account.currency }).format(
      accountBalance(account, this.store.transactions()),
    );
  }
  accountCurrency(id: string) {
    return this.store.accounts().find((a) => a.id === id)?.currency ?? '';
  }
  shift(offset: number) {
    const m = this.month();
    this.month.set(new Date(m.getFullYear(), m.getMonth() + offset, 1));
  }
  async transfer() {
    if (this.transferForm.invalid) {
      this.error.set('Choose two accounts and enter an amount.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const v = this.transferForm.getRawValue();
      await this.store.transfer(v.source, v.destination, v.amount, this.transferId);
      this.ui.notify('Transfer recorded');
      this.transferOpen.set(false);
      this.transferForm.reset();
      this.transferId = crypto.randomUUID();
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
