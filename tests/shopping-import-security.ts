import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function shoppingImportSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Atomic private Shopping JSON imports', () => {
    let db: PGlite, w: string, list: string;
    const item = {
      position: 1,
      name: '  Rice  ',
      category: '  Food  ',
      quantity: 1.25,
      unit: ' kg ',
      notes: '<script>literal</script>',
      checked: true,
      archived: true,
    };
    const source = {
      source_id: 'portable-groceries',
      kind: 'grocery',
      title: ' Portable groceries ',
      notes: 'Private list notes',
      archived: true,
      items: [item],
    };
    const request = randomUUID(),
      memberRequest = randomUUID();
    async function save(rows: unknown[] = [source], id = randomUUID(), workspace = w) {
      return (
        await db.query<{
          result: { lists_imported: number; items_imported: number; skipped: number };
        }>('select public.import_shopping_json($1,$2,$3) result', [
          id,
          workspace,
          JSON.stringify(rows),
        ])
      ).rows[0].result;
    }
    async function preview(rows: unknown[] = [source]) {
      return (
        await db.query<{ result: { source_id: string; state: string; message: string }[] }>(
          'select public.preview_shopping_import($1,$2) result',
          [w, JSON.stringify(rows)],
        )
      ).rows[0].result;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Shopping import security','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('previews and atomically imports fresh private identities and complete item states', async () => {
      expect((await preview())[0].state).toBe('ready');
      expect(await save([source], request)).toEqual({
        lists_imported: 1,
        items_imported: 1,
        skipped: 0,
      });
      const l = (
        await db.query<{
          id: string;
          owner_id: string;
          visibility: string;
          revision: number;
          archived: boolean;
        }>('select * from public.shopping_lists where workspace_id=$1', [w])
      ).rows[0];
      list = l.id;
      expect(l).toMatchObject({ owner_id: A, visibility: 'private', revision: 1, archived: true });
      expect(list).not.toBe(source.source_id);
      expect(
        (
          await db.query(
            'select name,quantity::text q,unit,checked,checked_by,checked_at is not null stamped,archived,revision from public.shopping_items where list_id=$1',
            [list],
          )
        ).rows[0],
      ).toMatchObject({
        name: 'Rice',
        q: '1.250',
        unit: 'kg',
        checked: true,
        checked_by: A,
        stamped: true,
        archived: true,
        revision: 1,
      });
    });
    it('keeps imports and audit contents hidden from other members and workspace owners', async () => {
      await asUser(B);
      expect(
        (await db.query('select * from public.shopping_lists where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      expect(
        (await db.query('select * from public.shopping_items where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      await expect(db.query('select * from private.shopping_import_sources')).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query('select * from private.shopping_import_batches')).rejects.toThrow(
        /permission denied/,
      );
      await save([source], memberRequest);
      await asUser(A);
      expect(
        (
          await db.query(
            'select * from public.shopping_lists where workspace_id=$1 and owner_id=$2',
            [w, B],
          )
        ).rows,
      ).toEqual([]);
    });
    it('supports exact batch retries and rejects reused batch payloads or users', async () => {
      await asUser(A);
      expect(await save([source], request)).toEqual({
        lists_imported: 1,
        items_imported: 1,
        skipped: 0,
      });
      await expect(save([{ ...source, title: 'Changed' }], request)).rejects.toThrow(/reused/);
      await asUser(B);
      await expect(save([source], request)).rejects.toThrow(/reused/);
      await asUser(A);
    });
    it('skips canonical reuploads while preserving later destination edits and archive changes', async () => {
      await asUser(A);
      await db.query('select public.set_shopping_archived($1,$2,1,false)', [randomUUID(), list]);
      await db.query(
        "select public.save_shopping_list($1,$2,$3,2,'Edited destination','grocery','','private')",
        [randomUUID(), list, w],
      );
      const normalized = {
        ...source,
        title: 'Portable groceries',
        items: [{ ...item, name: 'Rice', category: 'Food', unit: 'kg' }],
      };
      expect((await preview([normalized]))[0].state).toBe('duplicate');
      expect(await save([normalized])).toEqual({
        lists_imported: 0,
        items_imported: 0,
        skipped: 1,
      });
      expect(
        (
          await db.query('select title,archived,revision from public.shopping_lists where id=$1', [
            list,
          ])
        ).rows[0],
      ).toMatchObject({ title: 'Edited destination', archived: false, revision: 3 });
    });
    it('rejects changed original source contents without overwriting destination state', async () => {
      await asUser(A);
      expect((await preview([{ ...source, items: [{ ...item, quantity: 2 }] }]))[0].state).toBe(
        'invalid',
      );
      await expect(save([{ ...source, items: [{ ...item, quantity: 2 }] }])).rejects.toThrow(
        /contents changed/,
      );
    });
    it('rolls back an earlier valid list when a later source conflict is found', async () => {
      await asUser(A);
      const fresh = { ...source, source_id: 'atomic-new-list', title: 'Should roll back' };
      await expect(save([fresh, { ...source, notes: 'Changed source' }])).rejects.toThrow(
        /contents changed/,
      );
      expect(
        (
          await db.query(
            "select id from public.shopping_lists where workspace_id=$1 and title='Should roll back'",
            [w],
          )
        ).rows,
      ).toEqual([]);
      expect((await preview([fresh]))[0].state).toBe('ready');
    });
    it('rejects forged ownership, sharing, audit timestamps and extra nested columns', async () => {
      await asUser(A);
      for (const row of [
        { ...source, owner_id: B },
        { ...source, visibility: 'workspace' },
        { ...source, items: [{ ...item, checked_by: B }] },
        { ...source, items: [{ ...item, checked_at: '2000-01-01' }] },
      ])
        await expect(save([row])).rejects.toThrow(/columns/);
    });
    it('checks primitive types, bounds, position uniqueness and quantity precision', async () => {
      await asUser(A);
      for (const row of [
        { ...source, archived: 'false' },
        { ...source, notes: null },
        { ...source, kind: 'other' },
        { ...source, items: [{ ...item, checked: null }] },
        { ...source, items: [item, item] },
        { ...source, items: [{ ...item, position: 0 }] },
        { ...source, items: [{ ...item, quantity: 0 }] },
        { ...source, items: [{ ...item, quantity: 0.0001 }] },
        { ...source, items: [{ ...item, quantity: 1000001 }] },
        { ...source, items: [{ ...item, quantity: '1.25' }] },
      ])
        await expect(save([row])).rejects.toThrow();
      await expect(save([source, source])).rejects.toThrow(/unique/);
    });
    it('enforces list, total item and byte limits without any partial import', async () => {
      await asUser(A);
      await expect(
        save(Array.from({ length: 101 }, (_, i) => ({ ...source, source_id: `limit-${i}` }))),
      ).rejects.toThrow(/1–100/);
      const children = Array.from({ length: 251 }, (_, i) => ({ ...item, position: i + 1 }));
      await expect(
        save([
          { ...source, source_id: 'limit-a', items: children },
          { ...source, source_id: 'limit-b', items: children },
        ]),
      ).rejects.toThrow(/500 items in total/);
      await expect(save([{ ...source, notes: 'x'.repeat(5 * 1024 * 1024) }])).rejects.toThrow(
        /5 MiB/,
      );
    });
    it('blocks existing owned destination IDs without exposing another member’s identities', async () => {
      await asUser(A);
      expect((await preview([{ ...source, source_id: list }]))[0].state).toBe('invalid');
      await expect(save([{ ...source, source_id: list }])).rejects.toThrow(/existing list/);
      await asUser(B);
      expect((await preview([{ ...source, source_id: list }]))[0].state).toBe('ready');
      await asUser(A);
    });
    it('retains source identity after an administrative purge instead of resurrecting deleted lists', async () => {
      await asUser(A);
      const tombstone = { ...source, source_id: 'purge-proof-list' };
      await save([tombstone]);
      await db.exec('reset role');
      await db.query(
        "delete from public.shopping_lists where id=(select list_id from private.shopping_import_sources where workspace_id=$1 and owner_id=$2 and source_id='purge-proof-list')",
        [w, A],
      );
      await asUser(A);
      expect((await preview([tombstone]))[0].state).toBe('duplicate');
      expect(await save([tombstone])).toEqual({ lists_imported: 0, items_imported: 0, skipped: 1 });
    });
    it('requires current writer membership on preview and cached retries and isolates workspaces', async () => {
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(preview()).rejects.toThrow(/write access/);
      await expect(save([source], memberRequest)).rejects.toThrow(/write access/);
      await asUser(C);
      await expect(save()).rejects.toThrow(/write access/);
      await asUser(A);
      const other = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Shopping import other','personal') id",
        )
      ).rows[0].id;
      await expect(save([source], request, other)).rejects.toThrow(/reused/);
      expect(await save([source], randomUUID(), other)).toEqual({
        lists_imported: 1,
        items_imported: 1,
        skipped: 0,
      });
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      await expect(save()).rejects.toThrow(/write access/);
    });
    it('denies anonymous and direct browser writes or private primitive execution', async () => {
      await db.exec('reset role;set role anon');
      await expect(preview()).rejects.toThrow(/permission denied/);
      await expect(save()).rejects.toThrow(/permission denied/);
      await asUser(A);
      await expect(
        db.query('select private.shopping_import_row($1)', [JSON.stringify(source)]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query(
          "insert into public.shopping_lists(id,workspace_id,owner_id,title,kind)values($1,$2,$3,'Forged','grocery')",
          [randomUUID(), w, A],
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
}
