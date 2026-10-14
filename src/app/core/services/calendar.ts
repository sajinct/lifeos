import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { CalendarEvent, CalendarInput, CalendarSeries } from '../models/domain';
import { calendarDates, calendarInstant, wallParts } from '../../shared/utilities/calendar';
import { recurrenceDate } from '../../shared/utilities/finance';

@Injectable({ providedIn: 'root' })
export class CalendarLibrary {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  private readonly receipts = new Map<
    string,
    { w: string; user: string; session: number; payload: string }
  >();
  private readonly attempts = new Map<
    string,
    { w: string; user: string; session: number; payload: string }
  >();
  private context(request?: string) {
    const w = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    const attempt = request ? this.attempts.get(request) : undefined;
    const retry =
      !this.store.auth.demo() &&
      attempt?.w === w &&
      attempt?.user === user &&
      attempt?.session === session;
    if (
      !w ||
      !user ||
      (!this.store.writable() && !retry) ||
      (!this.store.auth.demo() && user !== this.store.auth.user()?.id)
    )
      throw new Error('Workspace write access required.');
    return { w, user, session };
  }
  private remember(id: string, c: ReturnType<CalendarLibrary['context']>, payload: unknown) {
    const p = JSON.stringify(payload),
      old = this.attempts.get(id);
    if (
      old &&
      (old.w !== c.w || old.user !== c.user || old.session !== c.session || old.payload !== p)
    )
      throw new Error('Request was already used for another change.');
    this.attempts.set(id, { ...c, payload: p });
  }
  private replay(id: string, c: ReturnType<CalendarLibrary['context']>, payload: unknown) {
    const p = JSON.stringify(payload),
      old = this.receipts.get(id);
    if (!old) return false;
    if (old.w !== c.w || old.user !== c.user || old.session !== c.session || old.payload !== p)
      throw new Error('Request was already used for another change.');
    return true;
  }
  private receipt(id: string, c: ReturnType<CalendarLibrary['context']>, payload: unknown) {
    this.receipts.set(id, { ...c, payload: JSON.stringify(payload) });
  }
  private async reload(c: ReturnType<CalendarLibrary['context']>) {
    if (
      c.w !== this.store.workspace()?.id ||
      c.user !== this.store.profile()?.id ||
      c.session !== this.store.fileSession()
    )
      return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (
      c.w === this.store.workspace()?.id &&
      c.session === this.store.fileSession() &&
      this.store.error()
    )
      throw new Error(this.store.error());
  }
  private project(input: Pick<CalendarInput, 'project' | 'visibility'>, w: string) {
    if (
      input.project &&
      !this.store
        .projects()
        .some(
          (p) =>
            p.id === input.project &&
            p.workspace_id === w &&
            (input.visibility === 'private' || p.visibility === 'workspace'),
        )
    )
      throw new Error('Project is inaccessible or private.');
  }
  async create(id: string, input: CalendarInput) {
    const c = this.context(id),
      dates = calendarDates(input);
    if (this.store.auth.demo() || !this.attempts.has(id)) this.project(input, c.w);
    const payload = ['create', input];
    if (!this.store.auth.demo()) {
      this.remember(id, c, payload);
      const { error } = await this.backend.requireClient().rpc('create_calendar_series', {
        entry: id,
        w: c.w,
        event_title: input.title.trim(),
        anchor: input.date,
        start_time: input.time,
        duration: input.duration * 60,
        timezone: input.timezone,
        repeat_frequency: input.frequency,
        event_count: input.count,
        place: input.location,
        event_color: input.color,
        linked_project: input.project || null,
        sharing: input.visibility,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (this.replay(id, c, payload)) return;
    const now = new Date().toISOString(),
      base = {
        workspace_id: c.w,
        owner_id: c.user,
        visibility: input.visibility,
        created_at: now,
        updated_at: now,
      };
    if (this.store.calendarSeries().some((s) => s.id === id))
      throw new Error('Repeat ID is already in use.');
    this.store.calendarSeries.update((rows) => [
      ...rows,
      {
        ...base,
        id,
        frequency: input.frequency,
        anchor_on: input.date,
        anchor_index: 0,
        start_clock: input.time,
        duration_seconds: input.duration * 60,
        time_zone: input.timezone,
        occurrences: input.count,
        state: 'active',
        revision: 1,
      },
    ]);
    this.store.events.update((rows) =>
      [
        ...rows,
        ...dates.map((d) => ({
          ...base,
          id: crypto.randomUUID(),
          title: input.title.trim(),
          starts_at: d.starts_at,
          ends_at: d.ends_at,
          location: input.location,
          color: input.color,
          project_id: input.project || null,
          series_id: id,
          occurrence_index: d.index,
          revision: 1,
          is_exception: false,
          event_state: 'scheduled' as const,
        })),
      ].sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    );
    this.receipt(id, c, payload);
  }
  private accessible(
    event: CalendarEvent,
    c: ReturnType<CalendarLibrary['context']>,
    retry = false,
  ) {
    const old = this.store.events().find((e) => e.id === event.id);
    if (retry && !this.store.auth.demo() && event.workspace_id === c.w) return old ?? event;
    if (!old || old.workspace_id !== c.w || !this.store.canEdit(old))
      throw new Error('Event is inaccessible.');
    return old;
  }
  private current(event: CalendarEvent, old: CalendarEvent, series?: CalendarSeries) {
    if ((old.revision ?? 1) !== (event.revision ?? 1))
      throw new Error('Event changed; refresh and try again.');
    const s = this.store.calendarSeries().find((r) => r.id === old.series_id);
    if (old.series_id && (!s || !series || s.revision !== series.revision))
      throw new Error('Repeat changed; refresh and try again.');
    return s;
  }
  async edit(
    id: string,
    event: CalendarEvent,
    series: CalendarSeries | undefined,
    scope: 'one' | 'future',
    input: CalendarInput,
  ) {
    const c = this.context(id),
      old = this.accessible(event, c, this.attempts.has(id)),
      payload = ['edit', event.id, event.revision ?? 1, series?.revision ?? null, scope, input];
    if (this.store.auth.demo() || !this.attempts.has(id))
      this.project({ ...input, visibility: old.visibility }, c.w);
    const starts_at = calendarInstant(input.date, input.time, input.timezone),
      ends_at = new Date(Date.parse(starts_at) + input.duration * 60000).toISOString();
    if (
      !input.title.trim() ||
      input.title.trim().length > 200 ||
      input.location.length > 2000 ||
      !Number.isFinite(input.duration) ||
      input.duration <= 0 ||
      input.duration > 10080 ||
      ends_at >= '2101-01-01T00:00:00.000Z' ||
      !['purple', 'green', 'orange', 'blue'].includes(input.color)
    )
      throw new Error('Enter valid event details and a duration of up to seven days.');
    if (!this.store.auth.demo()) {
      this.remember(id, c, payload);
      const { error } = await this.backend.requireClient().rpc('edit_calendar_event', {
        request: id,
        entry: event.id,
        expected_revision: event.revision ?? 1,
        expected_series_revision: series?.revision ?? null,
        edit_scope: scope,
        event_title: input.title.trim(),
        event_start: starts_at,
        event_end: ends_at,
        place: input.location,
        event_color: input.color,
        linked_project: input.project || null,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (this.replay(id, c, payload)) return;
    const s = this.current(event, old, series),
      changes = new Map<string, Partial<CalendarEvent>>(),
      now = new Date().toISOString();
    const fields = {
      title: input.title.trim(),
      location: input.location,
      color: input.color,
      project_id: input.project || null,
    };
    let anchor = s?.anchor_on ?? input.date,
      base = s?.anchor_index ?? 0;
    if (scope === 'future') {
      if (
        !s ||
        s.state === 'cancelled' ||
        old.starts_at < now ||
        starts_at < now ||
        input.timezone !== s.time_zone
      )
        throw new Error('Choose an upcoming occurrence of an active or paused repeat.');
      if (
        input.date !==
        recurrenceDate(s.anchor_on, s.frequency, old.occurrence_index! - s.anchor_index)
      ) {
        anchor = input.date;
        base = old.occurrence_index!;
      }
      for (const e of this.store
        .events()
        .filter(
          (e) =>
            e.series_id === s.id &&
            e.occurrence_index! >= old.occurrence_index! &&
            e.starts_at >= now &&
            !e.is_exception,
        )) {
        const start = calendarInstant(
          recurrenceDate(anchor, s.frequency, e.occurrence_index! - base),
          input.time,
          s.time_zone,
        );
        const end = new Date(Date.parse(start) + input.duration * 60000).toISOString();
        if (start < now || end >= '2101-01-01T00:00:00.000Z')
          throw new Error(
            'Future occurrences must remain upcoming and within the supported date range.',
          );
        changes.set(e.id, { ...fields, starts_at: start, ends_at: end });
      }
    }
    changes.set(old.id, { ...fields, starts_at, ends_at, is_exception: scope === 'one' && !!s });
    this.store.events.update((rows) =>
      rows
        .map((e) =>
          changes.has(e.id)
            ? { ...e, ...changes.get(e.id), revision: (e.revision ?? 1) + 1, updated_at: now }
            : e,
        )
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)),
    );
    if (s)
      this.store.calendarSeries.update((rows) =>
        rows.map((r) =>
          r.id === s.id
            ? {
                ...r,
                revision: r.revision + 1,
                updated_at: now,
                ...(scope === 'future'
                  ? {
                      anchor_on: anchor,
                      anchor_index: base,
                      start_clock: input.time,
                      duration_seconds: input.duration * 60,
                    }
                  : {}),
              }
            : r,
        ),
      );
    this.receipt(id, c, payload);
  }
  async state(
    id: string,
    event: CalendarEvent,
    series: CalendarSeries | undefined,
    scope: 'one' | 'series',
    target: CalendarSeries['state'],
  ) {
    const c = this.context(id),
      old = this.accessible(event, c, this.attempts.has(id)),
      payload = ['state', event.id, event.revision ?? 1, series?.revision ?? null, scope, target];
    if (!this.store.auth.demo()) {
      this.remember(id, c, payload);
      const { error } = await this.backend.requireClient().rpc('set_calendar_state', {
        request: id,
        entry: event.id,
        expected_revision: event.revision ?? 1,
        expected_series_revision: series?.revision ?? null,
        edit_scope: scope,
        target,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    if (this.replay(id, c, payload)) return;
    const s = this.current(event, old, series),
      now = new Date().toISOString();
    if (scope === 'series' && (!s || s.state === 'cancelled'))
      throw new Error('A cancelled repeat cannot be resumed.');
    if (
      scope === 'one' &&
      (target === 'paused' || (target === 'active' && s && s.state !== 'active'))
    )
      throw new Error('Resume the repeat before restoring an occurrence.');
    this.store.events.update((rows) =>
      rows.map((e) =>
        (
          scope === 'one'
            ? e.id === old.id
            : e.series_id === s!.id && e.starts_at >= now && e.event_state !== 'cancelled'
        )
          ? {
              ...e,
              event_state: target === 'active' ? 'scheduled' : target,
              is_exception: scope === 'one' ? !!s : e.is_exception,
              revision: (e.revision ?? 1) + 1,
              updated_at: now,
            }
          : e,
      ),
    );
    if (s)
      this.store.calendarSeries.update((rows) =>
        rows.map((r) =>
          r.id === s.id
            ? {
                ...r,
                revision: r.revision + 1,
                updated_at: now,
                ...(scope === 'series' ? { state: target } : {}),
              }
            : r,
        ),
      );
    this.receipt(id, c, payload);
  }
  timezone(event?: CalendarEvent) {
    return (
      this.store.calendarSeries().find((s) => s.id === event?.series_id)?.time_zone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  }
  parts(event: CalendarEvent) {
    return wallParts(event.starts_at, this.timezone(event));
  }
}
