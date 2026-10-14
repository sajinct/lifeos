import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function learningImportSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Atomic private Learning JSON imports', () => {
    let db: PGlite, w: string, item: string;
    const lesson = {
      position: 1,
      title: 'First chapter',
      notes: 'Private lesson',
      done: true,
      archived: false,
    };
    const source = {
      source_id: 'portable-course',
      kind: 'book',
      title: 'Portable learning',
      provider: 'Author',
      url: 'https://example.com/@book',
      goal: 'Learn more',
      due_on: '2027-01-31',
      notes: '  <script>literal</script>  ',
      status: 'completed',
      completed_on: '2026-01-01',
      archived: true,
      units: [lesson],
    };
    async function save(rows: unknown[] = [source], request = randomUUID(), workspace = w) {
      return (
        await db.query<{
          result: { items_imported: number; lessons_imported: number; skipped: number };
        }>('select public.import_learning_json($1,$2,$3) result', [
          request,
          workspace,
          JSON.stringify(rows),
        ])
      ).rows[0].result;
    }
    async function preview(rows: unknown[] = [source]) {
      return (
        await db.query<{ result: { source_id: string; state: string; message: string }[] }>(
          'select public.preview_learning_import($1,$2) result',
          [w, JSON.stringify(rows)],
        )
      ).rows[0].result;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Learning import security','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('previews and atomically imports new private identities with lesson/completion/archive history', async () => {
      expect((await preview())[0].state).toBe('ready');
      expect(await save()).toEqual({ items_imported: 1, lessons_imported: 1, skipped: 0 });
      const row = (
        await db.query<{
          id: string;
          owner_id: string;
          visibility: string;
          status: string;
          completed_on: string;
          archived: boolean;
          revision: number;
        }>(
          'select id,owner_id,visibility,status,completed_on::text,archived,revision from public.learning_items where workspace_id=$1',
          [w],
        )
      ).rows[0];
      item = row.id;
      expect(row).toMatchObject({
        owner_id: A,
        visibility: 'private',
        status: 'completed',
        completed_on: '2026-01-01',
        archived: true,
        revision: 1,
      });
      expect(row.id).not.toBe(source.source_id);
      expect(
        (
          await db.query(
            'select title,position,done,archived from public.learning_units where item_id=$1',
            [item],
          )
        ).rows,
      ).toEqual([{ title: lesson.title, position: 1, done: true, archived: false }]);
    });
    it('replays a stable request once and rejects changed request payloads or cross-user reuse', async () => {
      const request = randomUUID(),
        rows = [{ ...source, source_id: 'retry-course' }],
        first = await save(rows, request);
      expect(await save(rows, request)).toEqual(first);
      await expect(save([{ ...rows[0], title: 'Changed' }], request)).rejects.toThrow(
        /request reused/,
      );
      await asUser(B);
      await expect(save(rows, request)).rejects.toThrow(/request reused/);
      await asUser(A);
    });
    it('skips unchanged source IDs while preserving later item/lesson edits and archives', async () => {
      await db.query("select public.set_learning_state($1,$2,1,'completed',false)", [
        randomUUID(),
        item,
      ]);
      await db.query(
        "select public.save_learning_item($1,$2,$3,2,'book','Destination edit','','','','2027-01-31','New notes','{}','{}','{}')",
        [randomUUID(), item, w],
      );
      const before = (
        await db.query(
          'select title,notes,revision,archived from public.learning_items where id=$1',
          [item],
        )
      ).rows[0];
      expect((await preview())[0].state).toBe('duplicate');
      expect(await save()).toEqual({ items_imported: 0, lessons_imported: 0, skipped: 1 });
      expect(
        (
          await db.query(
            'select title,notes,revision,archived from public.learning_items where id=$1',
            [item],
          )
        ).rows[0],
      ).toEqual(before);
      await expect(save([{ ...source, title: 'Changed source' }])).rejects.toThrow(
        /contents changed/,
      );
      expect((await preview([{ ...source, title: 'Changed source' }]))[0].state).toBe('invalid');
    });
    it('rolls back an earlier new row when a later source conflict appears', async () => {
      await expect(
        save([
          { ...source, source_id: 'atomic-new' },
          { ...source, title: 'Source conflict' },
        ]),
      ).rejects.toThrow(/contents changed/);
      expect((await preview([{ ...source, source_id: 'atomic-new' }]))[0].state).toBe('ready');
      expect(
        (
          await db.query(
            'select id from public.learning_items where workspace_id=$1 and title=$2',
            [w, source.title],
          )
        ).rows,
      ).toHaveLength(1);
    });
    it('rejects forged fields/types, bounds, duplicate sources, inconsistent completion and duplicate lesson positions', async () => {
      const invalid = [
        { ...source, owner_id: B },
        { ...source, units: [{ ...lesson, visibility: 'workspace' }] },
        { ...source, title: '' },
        { ...source, archived: 'false' },
        { ...source, units: [{ ...lesson, position: 1.5 }] },
        { ...source, units: [lesson, lesson] },
        { ...source, completed_on: '2100-01-01' },
        { ...source, status: 'active' },
        { ...source, units: [{ ...lesson, done: false }] },
        { ...source, url: 'javascript:alert(1)' },
        { ...source, url: 'https://user:pass@example.com' },
        { ...source, due_on: '2026-02-30' },
        { ...source, notes: 'x'.repeat(4001) },
      ];
      for (const row of invalid)
        await expect(save([{ ...row, source_id: randomUUID() }])).rejects.toThrow();
      await expect(save([source, source])).rejects.toThrow(/unique/);
      await expect(
        save(Array.from({ length: 201 }, (_, i) => ({ ...source, source_id: String(i) }))),
      ).rejects.toThrow(/1–200/);
    });
    it('bounds total lessons and preserves no rows on an oversized batch', async () => {
      const units = Array.from({ length: 200 }, (_, i) => ({ ...lesson, position: i + 1 }));
      await expect(
        save([0, 1, 2].map((i) => ({ ...source, source_id: `oversized-${i}`, units }))),
      ).rejects.toThrow(/500 lessons/);
      expect((await preview([{ ...source, source_id: 'oversized-0' }]))[0].state).toBe('ready');
    });
    it('does not reuse current owned destination IDs or reveal another owner’s source bindings', async () => {
      expect((await preview([{ ...source, source_id: item }]))[0].state).toBe('invalid');
      await expect(save([{ ...source, source_id: item }])).rejects.toThrow(/existing learning/);
      await asUser(B);
      expect((await preview())[0].state).toBe('ready');
      expect(
        (await db.query('select id from public.learning_items where id=$1', [item])).rows,
      ).toHaveLength(0);
      expect(await save()).toMatchObject({ items_imported: 1 });
      await asUser(A);
    });
    it('denies direct audit/helper access and anonymous, viewer or removed-member imports, including retries', async () => {
      for (const table of ['learning_import_batches', 'learning_import_sources'])
        await expect(db.query(`select * from private.${table}`)).rejects.toThrow(
          /permission denied/,
        );
      await expect(
        db.query('select private.learning_import_row($1)', [JSON.stringify(source)]),
      ).rejects.toThrow(/permission denied/);
      await asUser(B);
      const request = randomUUID(),
        rows = [{ ...source, source_id: 'revoked-import' }];
      await save(rows, request);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(preview()).rejects.toThrow(/write access/);
      await expect(save(rows, request)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      await expect(save(rows, request)).rejects.toThrow(/write access/);
      await asUser(C);
      await expect(preview()).rejects.toThrow(/write access/);
      await db.exec('reset role;set role anon');
      await expect(save()).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
    it('keeps immutable source tombstones after an administrative purge', async () => {
      await db.exec('reset role');
      await db.query('delete from public.learning_items where id=$1', [item]);
      await asUser(A);
      expect((await preview())[0].state).toBe('duplicate');
      expect((await save()).items_imported).toBe(0);
      expect(
        (await db.query('select id from public.learning_items where id=$1', [item])).rows,
      ).toHaveLength(0);
    });
  });
}
