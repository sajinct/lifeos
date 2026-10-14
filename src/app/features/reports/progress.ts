import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LifeStore } from '../../core/services/life-store';
import {
  progressCsv,
  progressReport,
  ProgressFilter,
} from '../../shared/utilities/progress-reports';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
@Component({
  selector: 'app-progress-reports',
  imports: [DatePipe, DecimalPipe, RouterLink],
  templateUrl: './progress.html',
  styleUrl: './progress.css',
})
export class ProgressReportsPage {
  readonly store = inject(LifeStore);
  readonly from = signal('');
  readonly to = signal('');
  readonly filter = computed<ProgressFilter>(() => ({
    workspace: this.store.workspace()?.id ?? '',
    user: this.store.profile()?.id ?? '',
    from: this.from(),
    to: this.to(),
    today: subscriptionToday(this.store.profile()?.timezone ?? 'UTC'),
  }));
  readonly result = computed(() => {
    try {
      return {
        report: progressReport(
          {
            tasks: this.store.tasks(),
            projects: this.store.projects(),
            goals: this.store.goals(),
            times: this.store.taskTimes(),
            learning: this.store.learningItems(),
            units: this.store.learningUnits(),
          },
          this.filter(),
        ),
        error: '',
      };
    } catch (e) {
      return { report: null, error: this.store.message(e) };
    }
  });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => this.preset(6));
    });
  }
  preset(months: number) {
    const today = subscriptionToday(this.store.profile()?.timezone ?? 'UTC'),
      [y, m] = today.split('-').map(Number);
    this.from.set(new Date(Date.UTC(y, m - months, 1)).toISOString().slice(0, 10));
    this.to.set(today);
  }
  exportCsv() {
    const r = this.result().report;
    if (!r || this.store.loading() || this.store.error()) return;
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + progressCsv(r, this.filter())], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-progress-${this.from()}-${this.to()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  maxTime() {
    return Math.max(1, ...(this.result().report?.months.map((m) => m.seconds) ?? []));
  }
}
