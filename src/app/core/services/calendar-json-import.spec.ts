import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { RecordJsonImporter } from './record-json-import';
import { eventImportTime, parseRecordJson } from '../../shared/utilities/record-json-import';

describe('Calendar JSON import boundaries', () => {
  let store: LifeStore, importer: RecordJsonImporter;
  const event = (patch: Record<string, unknown> = {}) => ({
    id: 'portable-event',
    title: 'Import review meeting',
    starts_at: '2027-01-01T09:00:00+05:30',
    ends_at: '2027-01-01T10:00:00+05:30',
    location: '  Studio\n<b>literal</b>',
    color: 'blue',
    project_id: 'old-project',
    visibility: 'workspace',
    owner_id: 'someone-else',
    rrule: 'FREQ=DAILY',
    ...patch,
  });
  const file = (rows = [event()]) =>
    JSON.stringify({
      projects: [{ id: 'old-project', title: 'Old project' }],
      events: rows,
      notes: [{ id: 'omitted' }],
    });
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    importer = TestBed.inject(RecordJsonImporter);
  });
  async function request(text = file()) {
    const p = await importer.preview(text, true);
    p.mapping['old-project'] = store.projects()[0].id;
    return importer.prepare(p.source, p.mapping, p.links, new Set([0]));
  }
  it('normalizes explicit offsets and milliseconds without changing instants; rejects ambiguous or impossible times', () => {
    expect(eventImportTime('2027-01-01T09:00:00+05:30')).toBe('2027-01-01T03:30:00.000Z');
    expect(eventImportTime('2027-01-01T03:30:00.1Z')).toBe('2027-01-01T03:30:00.100Z');
    for (const value of [
      '2024-02-30T00:00:00Z',
      '2027-01-01T09:00:00',
      '2027-01-01T24:00:00Z',
      '2027-01-01T23:59:60Z',
      '2027-01-01T00:00:00+14:01',
      '1899-12-31T23:59:59Z',
      '2101-01-01T00:00:00Z',
      '2027-01-01T00:00:00.0001Z',
    ])
      expect(() => eventImportTime(value)).toThrow();
    const p = parseRecordJson(file(), true);
    expect(p.rows[0].row).toMatchObject({
      kind: 'event',
      starts_at: '2027-01-01T03:30:00.000Z',
      ends_at: '2027-01-01T04:30:00.000Z',
    });
    expect(p.rows[0].warnings.length).toBe(2);
    expect(p.omitted).toContain('notes');
  });
  it('requires unique IDs, 1–500 events and valid ordered times, location and color', () => {
    for (const text of [
      '{}',
      '{"events":[]}',
      file([event(), event()]),
      JSON.stringify({ events: Array.from({ length: 501 }, (_, i) => event({ id: String(i) })) }),
    ])
      expect(() => parseRecordJson(text, true)).toThrow();
    for (const patch of [
      { ends_at: '2027-01-01T03:30:00Z' },
      { starts_at: '2027-02-30T00:00:00Z' },
      { location: null },
      { location: 'x'.repeat(2001) },
      { color: 'red' },
      { title: '' },
    ])
      expect(parseRecordJson(file([event(patch)]), true).rows[0].row).toBeNull();
    expect(
      parseRecordJson(file([event({ location: undefined, color: undefined })]), true).rows[0].row,
    ).toMatchObject({ location: '', color: 'purple' });
  });
  it('requires explicit project mapping, creates a private event and keeps an exact retry stable', async () => {
    const p = await importer.preview(file(), true);
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('unmapped');
    const r = await request();
    expect(await importer.save(r)).toMatchObject({ events_imported: 1, skipped: 0 });
    expect(await importer.save(r)).toMatchObject({ events_imported: 1, skipped: 0 });
    const imported = store.events().filter((e) => e.title === 'Import review meeting');
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({
      owner_id: store.profile()!.id,
      visibility: 'private',
      project_id: store.projects()[0].id,
      location: event().location,
      color: 'blue',
      starts_at: '2027-01-01T03:30:00.000Z',
    });
    const reupload = await importer.preview(
      file([event({ starts_at: '2027-01-01T03:30:00.000Z', ends_at: '2027-01-01T04:30:00.000Z' })]),
      true,
    );
    expect(importer.review(reupload.source, reupload.mapping, reupload.links)[0].state).toBe(
      'duplicate',
    );
  });
  it('preserves later event edits/deletions and rejects changed source contents', async () => {
    await importer.save(await request());
    const id = store.events().find((e) => e.title === 'Import review meeting')!.id;
    store.events.update((rows) =>
      rows.map((e) => (e.id === id ? { ...e, title: 'Intentional edit' } : e)),
    );
    let p = await importer.preview(file(), true);
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('duplicate');
    p = await importer.preview(file([event({ location: 'Changed location' })]), true);
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('invalid');
    store.events.update((rows) => rows.filter((e) => e.id !== id));
    p = await importer.preview(file(), true);
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('duplicate');
  });
  it('skips only identical private events, leaves shared events available as private copies, and rolls back invalid later rows', async () => {
    const r = await request();
    const before = store.events();
    r.payload.rows.push({
      ...r.payload.rows[0],
      source_id: 'invalid',
      ends_at: r.payload.rows[0].starts_at,
    });
    await expect(importer.save(r)).rejects.toThrow(/end/);
    expect(store.events()).toEqual(before);
    expect((await importer.preview(file(), true)).links).toEqual([]);
    const existing = store.events()[0];
    const text = file([event({ ...existing, id: 'copy', project_id: null })]);
    let p = await importer.preview(text, true);
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('duplicate');
    store.events.update((rows) =>
      rows.map((e) => (e.id === existing.id ? { ...e, visibility: 'workspace' } : e)),
    );
    p = await importer.preview(text, true);
    expect(importer.review(p.source, p.mapping, p.links)[0].state).toBe('ready');
  });
  it('loads more than 500 events in stable pages and retains chronological display', async () => {
    const auth = TestBed.inject(AuthService),
      workspace = store.workspace()!,
      base = store.events()[0];
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    const events = Array.from({ length: 501 }, (_, i) => ({
      ...base,
      id: `event-${i}`,
      starts_at: i === 500 ? '2023-01-01T00:00:00Z' : '2024-01-01T00:00:00Z',
    }));
    const ranges: number[] = [];
    function builder(table: string) {
      const result = { data: table === 'calendar_events' ? events.slice(0, 500) : [], error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => Promise.resolve(result),
        range: (from: number, to: number) => {
          if (table === 'calendar_events') ranges.push(from);
          return Promise.resolve({
            data: table === 'calendar_events' ? events.slice(from, to + 1) : [],
            error: null,
          });
        },
        then: (resolve: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    }
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      from: (table: string) => builder(table),
      rpc: () => builder('members'),
    } as never);
    await store.switchWorkspace(workspace);
    expect(store.error()).toBe('');
    expect(store.events()).toHaveLength(501);
    expect(store.events()[0].id).toBe('event-500');
    expect(ranges).toEqual([0, 500]);
  });
});
