import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { CalendarLibrary } from './calendar';
import { Backend } from '../supabase/client';
import { CalendarInput } from '../models/domain';
import {
  calendarDates,
  calendarInstant,
  calendarSeriesInput,
} from '../../shared/utilities/calendar';
describe('Calendar schedule creation, exceptions and safe retries', () => {
  let store: LifeStore, library: CalendarLibrary;
  const input: CalendarInput = {
    title: 'Monthly review',
    date: '2090-01-31',
    time: '09:00',
    duration: 60,
    timezone: 'Asia/Kolkata',
    frequency: 'monthly',
    count: 4,
    location: 'Room',
    color: 'blue',
    project: '',
    visibility: 'private',
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(CalendarLibrary);
  });
  async function create() {
    const id = crypto.randomUUID();
    await library.create(id, input);
    return id;
  }
  function events(id: string) {
    return store
      .events()
      .filter((e) => e.series_id === id)
      .sort((a, b) => a.occurrence_index! - b.occurrence_index!);
  }
  function series(id: string) {
    return store.calendarSeries().find((s) => s.id === id)!;
  }
  it('previews anchored monthly and yearly dates and keeps timezone instants', () => {
    expect(calendarDates(input).map((e) => e.date)).toEqual([
      '2090-01-31',
      '2090-02-28',
      '2090-03-31',
      '2090-04-30',
    ]);
    expect(
      calendarDates({ ...input, date: '2092-02-29', frequency: 'yearly', count: 5 }).at(-1)?.date,
    ).toBe('2096-02-29');
    expect(calendarInstant('2090-01-31', '09:00', 'Asia/Kolkata')).toBe('2090-01-31T03:30:00.000Z');
  });
  it('rejects DST gaps and folds, but keeps valid wall time across a clock change', () => {
    expect(() => calendarInstant('2027-03-14', '02:30', 'America/New_York')).toThrow(
      /missing or ambiguous/,
    );
    expect(() => calendarInstant('2027-11-07', '01:30', 'America/New_York')).toThrow(
      /missing or ambiguous/,
    );
    expect(
      calendarDates({
        ...input,
        date: '2027-03-13',
        frequency: 'daily',
        count: 3,
        timezone: 'America/New_York',
      }).map((e) => e.starts_at),
    ).toEqual(['2027-03-13T14:00:00.000Z', '2027-03-14T13:00:00.000Z', '2027-03-15T13:00:00.000Z']);
  });
  it('replays creation exactly once and rejects changed request payloads', async () => {
    const id = await create();
    await library.create(id, input);
    expect(events(id)).toHaveLength(4);
    await expect(library.create(id, { ...input, count: 5 })).rejects.toThrow(/another change/);
    await expect(library.create(crypto.randomUUID(), { ...input, count: 121 })).rejects.toThrow(
      /valid event/,
    );
  });
  it('preserves individually edited occurrences and the original month-end anchor in future edits', async () => {
    const id = await create(),
      e = events(id)[2],
      s = series(id),
      req = crypto.randomUUID(),
      one = { ...calendarSeriesInput(s, e), title: 'Individual' };
    await library.edit(req, e, s, 'one', one);
    await library.edit(req, e, s, 'one', one);
    expect(events(id)[2].revision).toBe(2);
    const next = events(id)[1],
      future = { ...calendarSeriesInput(series(id), next), title: 'Future' };
    await library.edit(crypto.randomUUID(), next, series(id), 'future', future);
    expect(events(id).map((e) => e.title)).toEqual([
      'Monthly review',
      'Future',
      'Individual',
      'Future',
    ]);
    expect(events(id).map((e) => library.parts(e).date)).toEqual([
      '2090-01-31',
      '2090-02-28',
      '2090-03-31',
      '2090-04-30',
    ]);
    await expect(library.edit(crypto.randomUUID(), next, s, 'future', future)).rejects.toThrow(
      /changed/,
    );
  });
  it('reanchors changed dates while preserving prior events and exceptions', async () => {
    const id = await create(),
      e = events(id)[1],
      s = series(id);
    await library.edit(crypto.randomUUID(), e, s, 'future', {
      ...calendarSeriesInput(s, e),
      date: '2090-02-27',
    });
    expect(events(id).map((e) => library.parts(e).date)).toEqual([
      '2090-01-31',
      '2090-02-27',
      '2090-03-27',
      '2090-04-27',
    ]);
  });
  it('pauses and resumes without reviving cancellations, and never resumes a cancelled series', async () => {
    const id = await create();
    await library.state(crypto.randomUUID(), events(id)[2], series(id), 'one', 'cancelled');
    const e = events(id)[0],
      s = series(id),
      req = crypto.randomUUID();
    await library.state(req, e, s, 'series', 'paused');
    await library.state(req, e, s, 'series', 'paused');
    expect(events(id).map((e) => e.event_state)).toEqual([
      'paused',
      'paused',
      'cancelled',
      'paused',
    ]);
    await library.state(crypto.randomUUID(), events(id)[0], series(id), 'series', 'active');
    expect(events(id)[2].event_state).toBe('cancelled');
    await library.state(crypto.randomUUID(), events(id)[0], series(id), 'series', 'cancelled');
    await expect(
      library.state(crypto.randomUUID(), events(id)[0], series(id), 'series', 'active'),
    ).rejects.toThrow(/cancelled repeat/);
  });
  it('keeps demo repeats isolated across workspace switches and rejects viewer writes', async () => {
    const original = store.workspace()!,
      id = await create();
    await store.createWorkspace('Other calendar', 'personal');
    expect(store.calendarSeries()).toHaveLength(0);
    expect(events(id)).toHaveLength(0);
    await store.switchWorkspace(original);
    expect(events(id)).toHaveLength(4);
    expect(series(id)).toBeDefined();
    store.members.set([
      { workspace_id: original.id, user_id: store.profile()!.id, role: 'viewer' },
    ]);
    TestBed.inject(AuthService).demo.set(false);
    TestBed.inject(AuthService).user.set({ id: store.profile()!.id } as never);
    await expect(library.create(crypto.randomUUID(), input)).rejects.toThrow(/write access/);
  });
  it('rolls back every future edit when a later date hits a daylight-saving gap', async () => {
    const id = crypto.randomUUID();
    await library.create(id, {
      ...input,
      date: '2027-03-07',
      time: '01:30',
      timezone: 'America/New_York',
      frequency: 'weekly',
      count: 3,
    });
    const before = events(id),
      s = series(id),
      e = before[0];
    await expect(
      library.edit(crypto.randomUUID(), e, s, 'future', {
        ...calendarSeriesInput(s, e),
        time: '02:30',
      }),
    ).rejects.toThrow(/missing or ambiguous/);
    expect(events(id)).toEqual(before);
    expect(series(id)).toEqual(s);
  });
  it('ignores a successful cloud response after the user changes workspace', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    let complete!: (v: { error: null }) => void;
    const rpc = vi.fn(
      () =>
        new Promise<{ error: null }>((resolve) => {
          complete = resolve;
        }),
    );
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.create(crypto.randomUUID(), input);
    store.workspace.set({ ...store.workspace()!, id: 'other-workspace' });
    store.events.set([]);
    store.calendarSeries.set([]);
    complete({ error: null });
    await pending;
    expect(rpc).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(store.events()).toEqual([]);
    expect(store.calendarSeries()).toEqual([]);
  });
  it('retries the same saved cloud edit after refresh clears cached records and membership', async () => {
    const auth = TestBed.inject(AuthService),
      event = store.events()[0],
      id = crypto.randomUUID();
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as never);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    vi.spyOn(store, 'switchWorkspace')
      .mockImplementationOnce(async () => {
        store.events.set([]);
        store.members.set([]);
        store.error.set('Offline refresh');
      })
      .mockImplementationOnce(async () => {
        store.error.set('');
      });
    await expect(library.edit(id, event, undefined, 'one', input)).rejects.toThrow(
      /Offline refresh/,
    );
    await library.edit(id, event, undefined, 'one', input);
    expect(rpc).toHaveBeenCalledTimes(2);
    await expect(
      library.edit(id, event, undefined, 'one', { ...input, title: 'Changed retry' }),
    ).rejects.toThrow(/another change/);
  });
});
