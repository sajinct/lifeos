import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { financeReports, reportCsv, ReportFilter } from '../../shared/utilities/reports';
import { subscriptionToday } from '../../shared/utilities/subscriptions';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-reports',
  imports: [DatePipe, DecimalPipe, RouterLink, Icon],
  templateUrl: './reports.html',
})
export class ReportsPage {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly from = signal('');
  readonly to = signal('');
  readonly currency = signal('all');
  readonly currencies = computed(() =>
    [
      ...new Set([
        ...this.store.accounts().map((a) => a.currency),
        ...this.store.budgets().map((b) => b.currency),
      ]),
    ].sort(),
  );
  readonly filter = computed<ReportFilter>(() => ({
    workspace: this.store.workspace()?.id ?? '',
    user: this.store.profile()?.id ?? '',
    from: this.from(),
    to: this.to(),
    currency: this.currency(),
  }));
  readonly result = computed(() => {
    try {
      return {
        report: financeReports(
          this.store.transactions(),
          this.store.accounts(),
          this.store.budgets(),
          this.store.subscriptions(),
          this.filter(),
        ),
        error: '',
      };
    } catch (e) {
      return { report: null, error: this.store.message(e) };
    }
  });
  constructor() {
    this.preset(6);
  }
  preset(months: number) {
    const today = subscriptionToday(this.store.profile()?.timezone ?? 'UTC'),
      [year, month] = today.split('-').map(Number),
      date = new Date(Date.UTC(year, month - months, 1));
    this.from.set(date.toISOString().slice(0, 10));
    this.to.set(today);
  }
  money(value: number, currency: string) {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  }
  monthMax(rows: { income: number; expenses: number }[]) {
    return Math.max(1, ...rows.flatMap((r) => [r.income, r.expenses]));
  }
  bar(value: number, max: number) {
    return Math.min(100, Math.max(0, (value / max) * 100));
  }
  exportCsv() {
    const report = this.result().report;
    if (!report || this.store.loading() || this.store.error()) return;
    const url = URL.createObjectURL(
        new Blob(['\ufeff' + reportCsv(report, this.filter())], { type: 'text/csv;charset=utf-8' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-finance-${this.from()}-${this.to()}-${this.currency()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.ui.notify('Filtered financial report exported');
  }
}
