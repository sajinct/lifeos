import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function recordJsonSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private atomic Tasks and Notes JSON imports', () => {
    let db: PGlite,
      w: string,
      shared: string,
      secret: string,
      batch: string,
      task: string,
      note: string;
    const row = (kind = 'task', id = randomUUID(), patch: Record<string, unknown> = {}) => ({
      kind,
      source_id: id,
      project_source: 'source-project',
      title: kind === 'task' ? 'Imported task' : 'Imported note',
      status: kind === 'task' ? 'in_progress' : null,
      priority: kind === 'task' ? 'high' : null,
      due_date: kind === 'task' ? '2027-01-01' : null,
      body: kind === 'note' ? 'Keep this content\n<script>literal text</script>' : null,
      ...patch,
    });
    const payload = (rows: unknown[], target: string | null = shared) => ({
      projects: [{ source_id: 'source-project', target_id: target }],
      rows,
    });
    const run = (p: unknown, id = randomUUID(), workspace = w) =>
      db.query<{ result: { tasks_imported: number; notes_imported: number; skipped: number } }>(
        'select public.import_record_json($1,$2,$3::jsonb) result',
        [id, workspace, JSON.stringify(p)],
      );
    const tally = async () =>
      (
        await db.query(
          'select (select count(*)::int from public.tasks where workspace_id=$1) tasks,(select count(*)::int from public.notes where workspace_id=$1) notes,(select count(*)::int from public.record_json_links where workspace_id=$1) links,(select count(*)::int from public.record_json_batches where workspace_id=$1) batches',
          [w],
        )
      ).rows[0];
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Record imports','family') id",
        )
      ).rows[0].id;
      shared = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title,visibility)values($1,'Shared destination','workspace') returning id",
          [w],
        )
      ).rows[0].id;
      secret = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title)values($1,'Owner secret') returning id",
          [w],
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      batch = randomUUID();
      task = randomUUID();
      note = randomUUID();
    });
    it('creates private caller-owned task/note records without granting shared project members access', async () => {
      const p = payload([row('task', 'portable-task'), row('note', 'portable-note')]);
      expect((await run(p, batch)).rows[0].result).toEqual({
        tasks_imported: 1,
        notes_imported: 1,
        skipped: 0,
      });
      expect((await run(p, batch)).rows[0].result.tasks_imported).toBe(1);
      const t = (
        await db.query<{
          id: string;
          owner_id: string;
          visibility: string;
          assignee_id: string | null;
          series_id: string | null;
          list_id: string | null;
          status: string;
          priority: string;
          revision: number;
        }>('select * from public.tasks where workspace_id=$1', [w])
      ).rows[0];
      task = t.id;
      expect(t).toMatchObject({
        owner_id: B,
        visibility: 'private',
        assignee_id: null,
        series_id: null,
        list_id: null,
        status: 'in_progress',
        priority: 'high',
        revision: 1,
      });
      note = (
        await db.query<{ id: string; body: string }>(
          'select * from public.notes where workspace_id=$1',
          [w],
        )
      ).rows[0].id;
      await asUser(A);
      expect((await db.query('select id from public.tasks where id=$1', [task])).rows).toHaveLength(
        0,
      );
      expect((await db.query('select id from public.notes where id=$1', [note])).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('select id from public.record_json_links where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(run(p, batch)).rejects.toThrow(/request reused/);
      await asUser(B);
    });
    it('skips reuploads and rejects changed IDs, project mappings and reused batch payloads', async () => {
      const p = payload([row('task', 'portable-task'), row('note', 'portable-note')]);
      expect((await run(p)).rows[0].result).toEqual({
        tasks_imported: 0,
        notes_imported: 0,
        skipped: 2,
      });
      await expect(
        run(payload([row('task', 'portable-task', { title: 'Changed' })])),
      ).rejects.toThrow(/contents changed/);
      await expect(run(payload([row('task', 'other')], null))).rejects.toThrow(/saved mapping/);
      await expect(run(payload([row('task', 'portable-task')]), batch)).rejects.toThrow(
        /request reused/,
      );
    });
    it('keeps destination edits and deletions on unchanged source reupload', async () => {
      await db.query("select public.set_task_status($1,1,'done')", [task]);
      await db.query('delete from public.notes where id=$1', [note]);
      expect(
        (await run(payload([row('task', 'portable-task'), row('note', 'portable-note')]))).rows[0]
          .result.skipped,
      ).toBe(2);
      expect(
        (await db.query<{ status: string }>('select status from public.tasks where id=$1', [task]))
          .rows[0].status,
      ).toBe('done');
      expect((await db.query('select id from public.notes where id=$1', [note])).rows).toHaveLength(
        0,
      );
      expect(
        (
          await db.query<{ note_id: string | null }>(
            "select note_id from public.record_json_links where workspace_id=$1 and source_id='portable-note'",
            [w],
          )
        ).rows[0].note_id,
      ).toBeNull();
    });
    it('rolls back prior rows and mappings if a later row has invalid dates, types or forged fields', async () => {
      const before = await tally();
      for (const patch of [
        { due_date: '2024-02-30' },
        { due_date: '2101-01-01' },
        { status: 'cancelled' },
        { priority: 'urgent' },
        { owner_id: A },
        { visibility: 'workspace' },
        { assignee_id: A },
        { series_id: randomUUID() },
        { title: '' },
        { body: 'not a task body' },
        { due_date: 20270101 },
      ]) {
        await expect(
          run({
            projects: [],
            rows: [
              row('note', randomUUID(), { project_source: null, title: 'Rollback candidate' }),
              row('task', randomUUID(), { project_source: null, ...patch }),
            ],
          }),
        ).rejects.toThrow();
        expect(await tally()).toEqual(before);
      }
      await expect(
        run({
          projects: [],
          rows: [row('note', randomUUID(), { project_source: null, body: 'x'.repeat(100001) })],
        }),
      ).rejects.toThrow(/note content/);
      expect(await tally()).toEqual(before);
    });
    it('rejects inaccessible private/cross-workspace projects and unresolved links, but allows explicit unlinking', async () => {
      await expect(
        run({
          projects: [{ source_id: 'secret-source', target_id: secret }],
          rows: [row('task', 'secret-child', { project_source: 'secret-source' })],
        }),
      ).rejects.toThrow(/inaccessible/);
      await expect(run({ projects: [], rows: [row('task', 'unresolved')] })).rejects.toThrow(
        /explicitly unlink/,
      );
      expect(
        (
          await run({
            projects: [{ source_id: 'unlink-source', target_id: null }],
            rows: [row('note', 'unlinked-note', { project_source: 'unlink-source' })],
          })
        ).rows[0].result.notes_imported,
      ).toBe(1);
      const other = (
        await db.query<{ id: string }>("select public.create_workspace('Other record scope') id")
      ).rows[0].id;
      await expect(run(payload([row('task', 'wrong-scope')]), randomUUID(), other)).rejects.toThrow(
        /inaccessible/,
      );
    });
    it('rejects direct writes and anonymous/viewer/revoked membership, including retries', async () => {
      await expect(
        db.query("update public.record_json_links set source_id='forged' where workspace_id=$1", [
          w,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('delete from public.record_json_batches where id=$1', [batch]),
      ).rejects.toThrow(/permission denied/);
      await db.exec('reset role;set role anon');
      await expect(run(payload([row()]))).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from public.record_json_links')).rejects.toThrow(
        /permission denied/,
      );
      await asUser(C);
      await expect(run(payload([row()]))).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(run(payload([row()]), batch)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.record_json_links where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(run(payload([row()]), batch)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
    });
    it('skips identical private records but never uses another member’s or shared records as duplicates', async () => {
      const first = row('note', 'duplicate-one', { project_source: null, title: 'Matching note' }),
        second = { ...first, source_id: 'duplicate-two' };
      expect((await run({ projects: [], rows: [first, second] })).rows[0].result).toEqual({
        tasks_imported: 0,
        notes_imported: 1,
        skipped: 1,
      });
      await asUser(A);
      const original = (
        await db.query<{ id: string }>(
          "insert into public.notes(workspace_id,title,body,visibility)values($1,'Shared note','Shared body','workspace') returning id",
          [w],
        )
      ).rows[0].id;
      await asUser(B);
      expect(
        (
          await run({
            projects: [],
            rows: [
              row('note', original, {
                project_source: null,
                title: 'Shared note',
                body: 'Shared body',
              }),
            ],
          })
        ).rows[0].result.notes_imported,
      ).toBe(1);
      expect(
        (
          await db.query<{ visibility: string }>(
            "select visibility from public.notes where workspace_id=$1 and owner_id=$2 and title='Shared note'",
            [w, B],
          )
        ).rows[0].visibility,
      ).toBe('private');
    });
    it('rejects altered existing private source IDs and prevents large or ambiguous batches', async () => {
      const original = (
        await db.query<{ id: string }>(
          "insert into public.notes(workspace_id,title,body)values($1,'Original private','Body') returning id",
          [w],
        )
      ).rows[0].id;
      await expect(
        run({
          projects: [],
          rows: [row('note', original, { project_source: null, title: 'Changed', body: 'Body' })],
        }),
      ).rejects.toThrow(/Existing note source/);
      const p = row('task', 'duplicate-source', { project_source: null });
      for (const payload of [
        { projects: [], rows: [] },
        { projects: [], rows: [p, p] },
        {
          projects: [],
          rows: Array.from({ length: 501 }, () =>
            row('task', randomUUID(), { project_source: null }),
          ),
        },
        {
          projects: [
            { source_id: 'dup', target_id: null },
            { source_id: 'dup', target_id: null },
          ],
          rows: [p],
        },
        { projects: [], rows: [p], owner_id: A },
      ])
        await expect(run(payload)).rejects.toThrow();
    });
  });
}
