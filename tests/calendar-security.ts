import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function calendarSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Calendar repeat dates, retries and tenant boundaries', () => {
    let db: PGlite, w: string, series: string;
    async function create(
      id = randomUUID(),
      frequency = 'monthly',
      anchor = '2090-01-31',
      count = 4,
      zone = 'Asia/Kolkata',
      time = '09:00',
      visibility = 'private',
      project: string | null = null,
    ) {
      await db.query(
        'select public.create_calendar_series($1,$2,$3,$4,$5,3600,$6,$7,$8,$9,$10,$11,$12)',
        [
          id,
          w,
          'Repeat review',
          anchor,
          time,
          zone,
          frequency,
          count,
          'Room',
          'blue',
          project,
          visibility,
        ],
      );
      return id;
    }
    type EventRow = {
      id: string;
      revision: number;
      series_id: string;
      occurrence_index: number;
      title: string;
      starts_at: string;
      ends_at: string;
      is_exception: boolean;
      event_state: string;
      date: string;
    };
    async function rows(id = series) {
      return (
        await db.query<EventRow>(
          "select *,to_char(starts_at at time zone 'Asia/Kolkata','YYYY-MM-DD') date from public.calendar_events where series_id=$1 order by occurrence_index",
          [id],
        )
      ).rows;
    }
    async function revision(id = series) {
      return (
        await db.query<{ revision: number }>(
          'select revision from public.calendar_series where id=$1',
          [id],
        )
      ).rows[0].revision;
    }
    async function edit(
      e: EventRow,
      title: string,
      scope = 'one',
      request = randomUUID(),
      sr?: number,
      start?: string,
    ) {
      await db.query('select public.edit_calendar_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null)', [
        request,
        e.id,
        e.revision,
        sr ?? (await revision(e.series_id)),
        scope,
        title,
        start ?? e.starts_at,
        start ? new Date(Date.parse(start) + 3600000).toISOString() : e.ends_at,
        'Room',
        'blue',
      ]);
      return request;
    }
    async function state(
      e: EventRow,
      target: string,
      scope = 'series',
      request = randomUUID(),
      sr?: number,
    ) {
      await db.query('select public.set_calendar_state($1,$2,$3,$4,$5,$6)', [
        request,
        e.id,
        e.revision,
        sr ?? (await revision(e.series_id)),
        scope,
        target,
      ]);
      return request;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Calendar repeat security','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('creates a bounded monthly schedule, preserves month-end and replays once', async () => {
      series = await create();
      await create(series);
      expect((await rows()).map((e) => e.date)).toEqual([
        '2090-01-31',
        '2090-02-28',
        '2090-03-31',
        '2090-04-30',
      ]);
      expect(
        (await rows()).every(
          (e) => e.event_state === 'scheduled' && !e.is_exception && e.revision === 1,
        ),
      ).toBe(true);
      await expect(create(series, 'weekly')).rejects.toThrow(/Request.*another/);
    });
    it('handles daily, weekly and original leap-year anchors', async () => {
      const daily = await create(randomUUID(), 'daily', '2090-01-31', 3),
        weekly = await create(randomUUID(), 'weekly', '2090-01-31', 3),
        yearly = await create(randomUUID(), 'yearly', '2092-02-29', 5);
      expect((await rows(daily)).map((e) => e.date)).toEqual([
        '2090-01-31',
        '2090-02-01',
        '2090-02-02',
      ]);
      expect((await rows(weekly)).map((e) => e.date)).toEqual([
        '2090-01-31',
        '2090-02-07',
        '2090-02-14',
      ]);
      expect((await rows(yearly)).map((e) => e.date)).toEqual([
        '2092-02-29',
        '2093-02-28',
        '2094-02-28',
        '2095-02-28',
        '2096-02-29',
      ]);
    });
    it('keeps wall time across DST and atomically rejects gaps, folds and invalid limits', async () => {
      const id = await create(randomUUID(), 'daily', '2027-03-13', 3, 'America/New_York');
      const times = (
        await db.query<{ start: string }>(
          "select to_char(starts_at at time zone 'UTC','YYYY-MM-DD HH24:MI') start from public.calendar_events where series_id=$1 order by occurrence_index",
          [id],
        )
      ).rows;
      expect(times.map((e) => e.start)).toEqual([
        '2027-03-13 14:00',
        '2027-03-14 13:00',
        '2027-03-15 13:00',
      ]);
      for (const args of [
        ['2027-03-14', '02:30'],
        ['2027-11-07', '01:30'],
      ]) {
        const failed = randomUUID();
        await expect(
          create(failed, 'daily', args[0], 2, 'America/New_York', args[1]),
        ).rejects.toThrow(/missing or ambiguous/);
        expect(await rows(failed)).toHaveLength(0);
        expect(
          (await db.query('select id from public.calendar_series where id=$1', [failed])).rows,
        ).toHaveLength(0);
      }
      await expect(create(randomUUID(), 'daily', '2090-01-31', 121)).rejects.toThrow(/valid event/);
      await expect(create(randomUUID(), 'yearly', '2100-01-01', 2)).rejects.toThrow(
        /supported date/,
      );
    });
    it('blocks direct metadata writes, recurring edits and deletes', async () => {
      const e = (await rows())[0];
      await expect(
        db.query(
          "insert into public.calendar_events(workspace_id,title,starts_at,ends_at,series_id,occurrence_index)values($1,'Forged',now(),now()+interval '1 hour',$2,50)",
          [w, series],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('update public.calendar_events set revision=99 where id=$1', [e.id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update public.calendar_events set title='Direct' where id=$1", [e.id]),
      ).rejects.toThrow(/Calendar editor/);
      expect(
        (await db.query('delete from public.calendar_events where id=$1 returning id', [e.id]))
          .rows,
      ).toHaveLength(0);
      for (const table of ['calendar_series', 'private.calendar_requests'])
        await expect(
          db.query(`delete from ${table === 'calendar_series' ? 'public.' : ''}${table}`),
        ).rejects.toThrow(/permission denied/);
    });
    it('edits one exception, then updates future events without overwriting it or losing month anchors', async () => {
      let events = await rows();
      const sr = await revision();
      const req = await edit(events[2], 'Individual change', 'one', randomUUID(), sr);
      await edit(events[2], 'Individual change', 'one', req, sr);
      events = await rows();
      expect(events[2].is_exception).toBe(true);
      expect(events[2].revision).toBe(2);
      await edit(events[1], 'Future change', 'future');
      events = await rows();
      expect(events.map((e) => e.title)).toEqual([
        'Repeat review',
        'Future change',
        'Individual change',
        'Future change',
      ]);
      expect(events.map((e) => e.date)).toEqual([
        '2090-01-31',
        '2090-02-28',
        '2090-03-31',
        '2090-04-30',
      ]);
      expect(events[1].revision).toBe(2);
    });
    it('rejects stale event and series revisions, reanchors changed dates and preserves earlier occurrences', async () => {
      const e = (await rows())[1],
        sr = await revision();
      await edit(e, 'Reanchor', 'future', randomUUID(), sr, '2090-02-27T03:30:00Z');
      expect((await rows()).map((e) => e.date)).toEqual([
        '2090-01-31',
        '2090-02-27',
        '2090-03-31',
        '2090-04-27',
      ]);
      await expect(edit(e, 'Stale', 'future', randomUUID(), sr)).rejects.toThrow(/Event changed/);
      await expect(
        edit((await rows())[0], 'Stale series', 'one', randomUUID(), sr),
      ).rejects.toThrow(/Repeat changed/);
    });
    it('pauses and resumes without reviving cancelled exceptions, then permanently cancels future repeats', async () => {
      await state((await rows())[2], 'cancelled', 'one');
      const e = (await rows())[1],
        sr = await revision(),
        request = await state(e, 'paused', 'series', randomUUID(), sr);
      await state(e, 'paused', 'series', request, sr);
      expect((await rows()).map((e) => e.event_state)).toEqual([
        'paused',
        'paused',
        'cancelled',
        'paused',
      ]);
      await state((await rows())[1], 'active');
      expect((await rows()).map((e) => e.event_state)).toEqual([
        'scheduled',
        'scheduled',
        'cancelled',
        'scheduled',
      ]);
      await state((await rows())[1], 'cancelled');
      expect((await rows()).every((e) => e.event_state === 'cancelled')).toBe(true);
      await expect(state((await rows())[1], 'active')).rejects.toThrow(/cancelled repeat/);
      await expect(state((await rows())[2], 'active', 'one')).rejects.toThrow(/Resume the repeat/);
    });
    it('keeps past events intact when pausing or cancelling a schedule', async () => {
      const past = await create(randomUUID(), 'daily', '2020-01-01', 3),
        e = (await rows(past))[0];
      await state(e, 'paused');
      expect((await rows(past)).every((e) => e.event_state === 'scheduled')).toBe(true);
      await expect(edit((await rows(past))[0], 'Future', 'future')).rejects.toThrow(/upcoming/);
    });
    it('keeps a member’s private repeats hidden from the workspace owner and outsiders', async () => {
      await asUser(B);
      const id = await create();
      const e = (await rows(id))[0];
      await asUser(A);
      expect(await rows(id)).toHaveLength(0);
      expect(
        (await db.query('select id from public.calendar_series where id=$1', [id])).rows,
      ).toHaveLength(0);
      await expect(
        db.query("select public.set_calendar_state($1,$2,1,1,'series','paused')", [
          randomUUID(),
          e.id,
        ]),
      ).rejects.toThrow(/inaccessible/);
      await asUser(C);
      expect(await rows(id)).toHaveLength(0);
      await expect(create()).rejects.toThrow(/write access/);
      await asUser(A);
    });
    it('shares only explicitly, preserves linked-project privacy and denies viewer retries', async () => {
      const project = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title)values($1,'Private calendar project')returning id",
          [w],
        )
      ).rows[0].id;
      await expect(
        create(
          randomUUID(),
          'daily',
          '2090-01-31',
          2,
          'Asia/Kolkata',
          '09:00',
          'workspace',
          project,
        ),
      ).rejects.toThrow(/Project.*private/);
      await asUser(B);
      await expect(
        create(randomUUID(), 'daily', '2090-01-31', 2, 'Asia/Kolkata', '09:00', 'private', project),
      ).rejects.toThrow(/Project.*inaccessible/);
      const shared = await create(
        randomUUID(),
        'daily',
        '2090-01-31',
        2,
        'Asia/Kolkata',
        '09:00',
        'workspace',
      );
      await asUser(A);
      expect(await rows(shared)).toHaveLength(2);
      await edit((await rows(shared))[0], 'Owner edit');
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await rows(shared)).toHaveLength(2);
      await expect(
        create(shared, 'daily', '2090-01-31', 2, 'Asia/Kolkata', '09:00', 'workspace'),
      ).rejects.toThrow(/write access/);
      await expect(edit((await rows(shared))[0], 'Viewer edit')).rejects.toThrow(/inaccessible/);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('does not treat recurring occurrences as standalone import duplicates', async () => {
      const id = await create(),
        e = (await rows(id))[0];
      const row = {
        kind: 'event',
        source_id: 'repeat-copy',
        project_source: null,
        title: e.title,
        status: null,
        priority: null,
        due_date: null,
        body: null,
        starts_at: new Date(e.starts_at).toISOString(),
        ends_at: new Date(e.ends_at).toISOString(),
        location: 'Room',
        color: 'blue',
      };
      const result = (
        await db.query<{ result: { events_imported: number } }>(
          'select public.import_record_json($1,$2,$3) result',
          [randomUUID(), w, { projects: [], rows: [row] }],
        )
      ).rows[0].result;
      expect(result.events_imported).toBe(1);
      await expect(
        db.query('select public.import_record_json($1,$2,$3)', [
          randomUUID(),
          w,
          { projects: [], rows: [{ ...row, source_id: e.id }] },
        ]),
      ).rejects.toThrow(/different content/);
    });
    it('excludes paused and cancelled occurrences from email summaries', async () => {
      const id = await create(randomUUID(), 'daily', '2090-07-01', 3, 'UTC');
      let e = (await rows(id))[0];
      await state(e, 'paused');
      await db.exec('reset role');
      await db.query(
        "insert into public.email_preferences(owner_id,delivery_timezone)values($1,'UTC')on conflict(owner_id)do update set delivery_timezone='UTC'",
        [A],
      );
      const delivery = (
        await db.query<{ id: string }>(
          "insert into public.email_deliveries(workspace_id,owner_id,kind,period_key)values($1,$2,'daily','calendar-test')returning id",
          [w, A],
        )
      ).rows[0].id;
      async function text() {
        return (
          await db.query<{ text: string }>(
            "select private.email_text(d,'2090-07-01T12:00:00Z') text from public.email_deliveries d where id=$1",
            [delivery],
          )
        ).rows[0].text;
      }
      expect(await text()).not.toContain('Repeat review');
      await asUser(A);
      await state((await rows(id))[0], 'active');
      await db.exec('reset role');
      expect(await text()).toContain('Repeat review');
      await asUser(A);
      e = (await rows(id))[0];
      await state(e, 'cancelled');
      await db.exec('reset role');
      expect(await text()).not.toContain('Repeat review');
      await asUser(A);
    });
    it('rolls back all future edits if a later occurrence crosses a DST gap', async () => {
      const id = await create(randomUUID(), 'weekly', '2027-03-07', 3, 'America/New_York', '01:30'),
        before = await rows(id),
        sr = await revision(id);
      await expect(
        edit(before[0], 'Invalid future time', 'future', randomUUID(), sr, '2027-03-07T07:30:00Z'),
      ).rejects.toThrow(/missing or ambiguous/);
      expect(await rows(id)).toEqual(before);
      expect(await revision(id)).toBe(sr);
    });
  });
}
