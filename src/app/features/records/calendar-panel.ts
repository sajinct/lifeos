import { Component, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { CalendarEvent, CalendarInput, CalendarSeries } from '../../core/models/domain';
import { LifeStore } from '../../core/services/life-store';
import { CalendarLibrary } from '../../core/services/calendar';
import { UiService } from '../../core/services/ui';
import {
  calendarDates,
  calendarInstant,
  calendarSeriesInput,
  wallParts,
} from '../../shared/utilities/calendar';
import { localDate } from '../../shared/utilities/finance';

@Component({
  selector: 'app-calendar-panel',
  imports: [ReactiveFormsModule],
  templateUrl: './calendar-panel.html',
})
export class CalendarPanel {
  readonly store = inject(LifeStore);
  readonly library = inject(CalendarLibrary);
  private readonly ui = inject(UiService);
  readonly eventDate = output<string>();
  readonly open = signal(false);
  readonly previous = signal<CalendarEvent | undefined>(undefined);
  readonly previousSeries = signal<CalendarSeries | undefined>(undefined);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly preview = signal<ReturnType<typeof calendarDates>>([]);
  readonly repeats = computed(() =>
    [...this.store.calendarSeries()].sort((a, b) => b.created_at.localeCompare(a.created_at)),
  );
  readonly form = inject(FormBuilder).nonNullable.group({
    title: [''],
    date: [localDate()],
    time: ['09:00'],
    duration: [60],
    timezone: [Intl.DateTimeFormat().resolvedOptions().timeZone],
    frequency: ['monthly' as CalendarInput['frequency']],
    count: [12],
    location: [''],
    color: ['purple'],
    project: [''],
    visibility: ['private' as CalendarInput['visibility']],
    scope: ['one' as 'one' | 'future'],
  });
  private previewInput = '';
  private request: string = crypto.randomUUID();
  readonly pending = signal<
    { run: () => Promise<void>; message: string; day?: string } | undefined
  >(undefined);
  constructor() {
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.preview.set([]);
      this.previewInput = '';
    });
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      untracked(() => this.reset());
    });
  }
  reset() {
    this.open.set(false);
    this.previous.set(undefined);
    this.previousSeries.set(undefined);
    this.error.set('');
    this.preview.set([]);
    this.pending.set(undefined);
    this.request = crypto.randomUUID();
  }
  create() {
    this.reset();
    this.form.reset({
      title: '',
      date: localDate(),
      time: '09:00',
      duration: 60,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      frequency: 'monthly',
      count: 12,
      location: '',
      color: 'purple',
      project: '',
      visibility: 'private',
      scope: 'one',
    });
    this.open.set(true);
  }
  edit(event: CalendarEvent) {
    if (this.busy()) return;
    this.reset();
    const series = this.store.calendarSeries().find((s) => s.id === event.series_id),
      zone = this.library.timezone(event),
      parts = wallParts(event.starts_at, zone);
    this.previous.set(event);
    this.previousSeries.set(series);
    const input: CalendarInput = series
      ? calendarSeriesInput(series, event)
      : {
          title: event.title,
          date: parts.date,
          time: parts.time,
          duration: (Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60000,
          timezone: zone,
          frequency: 'monthly',
          count: 12,
          location: event.location,
          color: event.color,
          project: event.project_id ?? '',
          visibility: event.visibility,
        };
    this.form.reset({ ...input, scope: 'one' });
    this.open.set(true);
  }
  editSeries(series: CalendarSeries) {
    const events = this.store
      .events()
      .filter((e) => e.series_id === series.id)
      .sort((a, b) => (a.occurrence_index ?? 0) - (b.occurrence_index ?? 0));
    const event =
      events.find(
        (e) => e.starts_at >= new Date().toISOString() && e.event_state !== 'cancelled',
      ) ?? events.at(-1);
    if (event) this.edit(event);
  }
  label(series: CalendarSeries) {
    return this.store.events().find((e) => e.series_id === series.id)?.title ?? 'Recurring event';
  }
  previewDates() {
    this.error.set('');
    try {
      const input = this.form.getRawValue();
      this.preview.set(calendarDates(input));
      this.previewInput = JSON.stringify(input);
    } catch (e) {
      this.preview.set([]);
      this.error.set(this.store.message(e));
    }
  }
  async save() {
    const input = this.form.getRawValue(),
      event = this.previous(),
      series = this.previousSeries(),
      id = this.request;
    if (!event && this.previewInput !== JSON.stringify(input)) {
      this.error.set('Preview the current schedule before creating it.');
      return;
    }
    try {
      const day = localDate(new Date(calendarInstant(input.date, input.time, input.timezone)));
      await this.action(
        () =>
          event
            ? this.library.edit(id, event, series, input.scope, input)
            : this.library.create(id, input),
        event ? 'Calendar event updated' : `${input.count} recurring events created`,
        day,
      );
    } catch (e) {
      this.error.set(this.store.message(e));
    }
  }
  async changeState(scope: 'one' | 'series', target: CalendarSeries['state']) {
    const event = this.previous(),
      series = this.previousSeries(),
      id = this.request;
    if (!event) return;
    await this.action(
      () => this.library.state(id, event, series, scope, target),
      scope === 'series'
        ? `Repeat ${target === 'active' ? 'resumed' : target}`
        : `Occurrence ${target === 'active' ? 'restored' : 'cancelled'}`,
    );
  }
  private async action(run: () => Promise<void>, message: string, day?: string) {
    if (this.busy() || !this.store.writable()) return;
    this.pending.set({ run, message, day });
    await this.retry();
  }
  async retry() {
    const p = this.pending();
    if (!p || this.busy()) return;
    const w = this.store.workspace()?.id,
      session = this.store.fileSession();
    this.busy.set(true);
    this.error.set('');
    try {
      await p.run();
      if (w === this.store.workspace()?.id && session === this.store.fileSession()) {
        this.ui.notify(p.message);
        if (p.day) this.eventDate.emit(p.day);
        this.reset();
      }
    } catch (e) {
      if (w === this.store.workspace()?.id && session === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
