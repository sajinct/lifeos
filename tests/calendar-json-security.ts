import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function calendarJsonSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Atomic private Calendar JSON imports', () => {
    let db: PGlite,
      w: string,
      shared: string,
      secret: string,
      other: string,
      eventId: string,
      batch: string;
    const row = (patch: Record<string, unknown> = {}) => ({
      kind: 'event',
      source_id: 'portable-event',
      project_source: 'calendar-project',
      title: 'Imported calendar meeting',
      status: null,
      priority: null,
      due_date: null,
      body: null,
      starts_at: '2027-01-01T03:30:00.000Z',
      ends_at: '2027-01-01T04:30:00.000Z',
      location: ' Studio\n<b>literal</b> ',
      color: 'blue',
      ...patch,
    });
    const payload = (rows: unknown[] = [row()], target: string | null = shared) => ({
      projects: [{ source_id: 'calendar-project', target_id: target }],
      rows,
    });
    const run = (p: unknown = payload(), id = randomUUID(), workspace = w) =>
      db.query<{ result: { events_imported: number; skipped: number } }>(
        'select public.import_record_json($1,$2,$3::jsonb) result',
        [id, workspace, JSON.stringify(p)],
      );
    const counts = async () =>
      (
        await db.query(
          'select (select count(*)::int from public.calendar_events where workspace_id=$1) events,(select count(*)::int from public.record_json_links where workspace_id=$1) links,(select count(*)::int from public.record_json_batches where workspace_id=$1) batches',
          [w],
        )
      ).rows[0];
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Calendar imports','family') id",
        )
      ).rows[0].id;
      other = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Other calendar','personal') id",
        )
      ).rows[0].id;
      shared = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title,visibility)values($1,'Calendar shared project','workspace')returning id",
          [w],
        )
      ).rows[0].id;
      secret = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title)values($1,'Private calendar project')returning id",
          [w],
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      batch = randomUUID();
    });
    it('creates a private caller-owned event linked to a shared readable project and retains retry identity', async () => {
      const result = (await run(payload(), batch)).rows[0].result;
      expect(result).toMatchObject({ events_imported: 1, skipped: 0 });
      expect((await run(payload(), batch)).rows[0].result).toEqual(result);
      const e = (
        await db.query<{
          id: string;
          owner_id: string;
          visibility: string;
          project_id: string;
          location: string;
          starts_at: Date;
        }>('select * from public.calendar_events where workspace_id=$1', [w])
      ).rows[0];
      eventId = e.id;
      expect(e).toMatchObject({
        owner_id: B,
        visibility: 'private',
        project_id: shared,
        location: row().location,
      });
      expect(new Date(e.starts_at).toISOString()).toBe(row().starts_at);
      await asUser(A);
      expect(
        (await db.query('select * from public.calendar_events where id=$1', [eventId])).rows,
      ).toEqual([]);
      expect(
        (await db.query('select * from public.record_json_links where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      expect(
        (await db.query('select * from public.record_json_batches where workspace_id=$1', [w]))
          .rows,
      ).toEqual([]);
      await asUser(B);
    });
    it('deduplicates reuploads and exact private matches while changed sources and batch IDs are rejected', async () => {
      expect((await run()).rows[0].result).toMatchObject({ events_imported: 0, skipped: 1 });
      expect((await run(payload([row({ source_id: 'new-source' })]))).rows[0].result).toMatchObject(
        { events_imported: 0, skipped: 1 },
      );
      const before = await counts();
      await expect(run(payload([row({ title: 'Changed source' })]))).rejects.toThrow(
        /contents changed/,
      );
      await expect(run(payload([row({ title: 'Changed request' })]), batch)).rejects.toThrow(
        /request reused/,
      );
      expect(await counts()).toEqual(before);
      await expect(
        run(payload([row({ source_id: eventId, title: 'Conflicting existing ID' })])),
      ).rejects.toThrow(/Existing event/);
    });
    it('rejects ambiguous, impossible, reversed, out-of-range times and forged fields atomically', async () => {
      const before = await counts();
      for (const patch of [
        { starts_at: '2027-01-01T03:30:00' },
        { starts_at: '2027-01-01T09:00:00+05:30' },
        { starts_at: '2024-02-30T03:30:00.000Z' },
        { starts_at: '2027-01-01T24:00:00.000Z' },
        { starts_at: '1899-01-01T00:00:00.000Z' },
        { ends_at: '2101-01-01T00:00:00.000Z' },
        { ends_at: row().starts_at },
        { color: 'red' },
        { location: 'x'.repeat(2001) },
        { status: 'todo' },
        { owner_id: A },
        { visibility: 'workspace' },
        { starts_at: 123 },
      ]) {
        await expect(
          run(
            payload([
              row({ source_id: randomUUID(), title: 'Rollback candidate' }),
              row({ source_id: randomUUID(), ...patch }),
            ]),
          ),
        ).rejects.toThrow();
        expect(await counts()).toEqual(before);
      }
      await expect(run(payload([row(), row()]))).rejects.toThrow(/unique/);
      await expect(
        run({
          projects: [],
          rows: Array.from({ length: 501 }, () =>
            row({ source_id: randomUUID(), project_source: null }),
          ),
        }),
      ).rejects.toThrow(/500/);
    });
    it('enforces private/cross-workspace project access and immutable bindings, with explicit unlink supported', async () => {
      await expect(run(payload([row({ source_id: randomUUID() })], secret))).rejects.toThrow(
        /inaccessible/,
      );
      await expect(run(payload(), randomUUID(), other)).rejects.toThrow(/write access/);
      await expect(run(payload([row({ source_id: randomUUID() })], null))).rejects.toThrow(
        /saved mapping/,
      );
      await expect(run({ projects: [], rows: [row()] })).rejects.toThrow(/mapping/);
      const r = row({
        source_id: 'unlinked-event',
        project_source: null,
        title: 'Unlinked calendar event',
      });
      expect((await run({ projects: [], rows: [r] })).rows[0].result.events_imported).toBe(1);
    });
    it('keeps subsequent edits and deletion, including the reserved source identity', async () => {
      await db.query(
        "update public.calendar_events set title='Intentional local edit' where id=$1",
        [eventId],
      );
      expect((await run()).rows[0].result.skipped).toBe(1);
      expect(
        (
          await db.query<{ title: string }>(
            'select title from public.calendar_events where id=$1',
            [eventId],
          )
        ).rows[0].title,
      ).toBe('Intentional local edit');
      await db.query('delete from public.calendar_events where id=$1', [eventId]);
      expect((await run()).rows[0].result.skipped).toBe(1);
      expect(
        (await db.query('select * from public.calendar_events where id=$1', [eventId])).rows,
      ).toEqual([]);
      expect(
        (
          await db.query<{ event_id: string | null }>(
            "select event_id from public.record_json_links where workspace_id=$1 and source_id='portable-event'",
            [w],
          )
        ).rows[0].event_id,
      ).toBeNull();
    });
    it('does not reuse another member’s or shared events as private duplicate destinations', async () => {
      await asUser(A);
      const title = 'Shared duplicate';
      await db.query(
        "insert into public.calendar_events(workspace_id,title,starts_at,ends_at,location,color,project_id,visibility)values($1,$2,$3,$4,$5,'blue',$6,'workspace')",
        [w, title, row().starts_at, row().ends_at, row().location, shared],
      );
      await asUser(B);
      expect(
        (await run(payload([row({ source_id: 'shared-copy', title })]))).rows[0].result
          .events_imported,
      ).toBe(1);
      const own = (
        await db.query<{ owner_id: string; visibility: string }>(
          'select owner_id,visibility from public.calendar_events where workspace_id=$1 and title=$2',
          [w, title],
        )
      ).rows;
      expect(own).toHaveLength(2);
      expect(own).toContainEqual({ owner_id: B, visibility: 'private' });
    });
    it('denies direct source metadata writes, anonymous calls and removed/viewer/unrelated users, even on replay', async () => {
      await expect(
        db.query(
          "insert into public.record_json_links(workspace_id,owner_id,record_kind,source_id,details)values($1,$2,'event','forged','{}')",
          [w, B],
        ),
      ).rejects.toThrow(/permission/);
      await expect(
        db.query("select private.calendar_import_time('2027-01-01T03:30:00.000Z')"),
      ).rejects.toThrow(/permission/);
      await asUser(C);
      await expect(run(payload(), batch)).rejects.toThrow(/write access/);
      await db.exec('reset role;set role anon');
      await expect(run()).rejects.toThrow(/permission/);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(run(payload(), batch)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select * from public.record_json_links where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      await expect(run()).rejects.toThrow(/write access/);
      await asUser(A);
    });
  });
}
