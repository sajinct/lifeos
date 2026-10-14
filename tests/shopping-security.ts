import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function shoppingSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Shopping list sharing, collaboration and safe retries', () => {
    let db: PGlite, w: string, list: string, item: string, privateList: string, memberList: string;
    type List = {
      id: string;
      revision: number;
      visibility: string;
      archived: boolean;
      owner_id: string;
    };
    type Item = {
      id: string;
      revision: number;
      name: string;
      category: string;
      quantity: number;
      unit: string;
      notes: string;
      checked: boolean;
      checked_by: string | null;
      checked_at: string | null;
      archived: boolean;
      owner_id: string;
    };
    async function row(id = list) {
      return (await db.query<List>('select * from public.shopping_lists where id=$1', [id]))
        .rows[0];
    }
    async function child(id = item) {
      return (await db.query<Item>('select * from public.shopping_items where id=$1', [id]))
        .rows[0];
    }
    async function save(
      id = randomUUID(),
      revision: number | null = null,
      sharing = 'private',
      request = randomUUID(),
      title = 'Weekly groceries',
      kind = 'grocery',
      notes = '  Literal <script>text</script>  ',
    ) {
      await db.query('select public.save_shopping_list($1,$2,$3,$4,$5,$6,$7,$8)', [
        request,
        id,
        w,
        revision,
        title,
        kind,
        notes,
        sharing,
      ]);
      return { id, request };
    }
    async function put(
      id = randomUUID(),
      parent = list,
      changes: Record<string, unknown> = {},
      revision: number | null = null,
      parentRevision?: number,
      request = randomUUID(),
    ) {
      const v = {
        name: 'Milk',
        category: 'Dairy',
        quantity: 1.5,
        unit: 'litres',
        notes: '  Cold  ',
        checked: false,
        archived: false,
        ...changes,
      };
      const pr = parentRevision ?? (await row(parent)).revision;
      await db.query('select public.save_shopping_item($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
        request,
        id,
        parent,
        revision,
        pr,
        v.name,
        v.category,
        v.quantity,
        v.unit,
        v.notes,
        v.checked,
        v.archived,
      ]);
      return { id, request, parentRevision: pr };
    }
    async function archive(id = list, value = true, revision?: number, request = randomUUID()) {
      await db.query('select public.set_shopping_archived($1,$2,$3,$4)', [
        request,
        id,
        revision ?? (await row(id)).revision,
        value,
      ]);
      return request;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Shopping test','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      list = (await save(randomUUID(), null, 'workspace')).id;
      privateList = (await save()).id;
      item = (await put()).id;
    });
    it('keeps private parents and their items unreadable to editors and outsiders', async () => {
      await asUser(A);
      const pi = (await put(randomUUID(), privateList)).id;
      await asUser(B);
      expect(await row(privateList)).toBeUndefined();
      expect(await child(pi)).toBeUndefined();
      expect(await row()).toBeDefined();
      await asUser(C);
      expect(await row()).toBeUndefined();
      expect(await child()).toBeUndefined();
      await expect(put(randomUUID(), list, {}, null, 2)).rejects.toThrow(/inaccessible/);
    });
    it('lets shared editors change another creator’s item while preserving authorship and check audit', async () => {
      await asUser(B);
      await put(item, list, { checked: true }, 1);
      const checked = await child();
      expect(checked).toMatchObject({ owner_id: A, checked: true, checked_by: B });
      expect(checked.checked_at).toBeTruthy();
      await asUser(A);
      await put(item, list, { checked: true, quantity: 2 }, 2);
      expect(await child()).toMatchObject({
        checked_by: B,
        checked_at: checked.checked_at,
        owner_id: A,
      });
      await put(item, list, { quantity: 2, checked: false }, 3);
      expect(await child()).toMatchObject({ checked: false, checked_by: null, checked_at: null });
    });
    it('prevents editors from changing another creator’s list metadata or archive', async () => {
      await asUser(B);
      await expect(save(list, (await row()).revision, 'workspace')).rejects.toThrow(/inaccessible/);
      await expect(archive()).rejects.toThrow(/inaccessible/);
      memberList = (await save(randomUUID(), null, 'workspace')).id;
      await asUser(A);
      await save(memberList, 1, 'workspace', randomUUID(), 'Owner can edit');
      await expect(save(memberList, 2, 'private')).rejects.toThrow(/Only the list creator/);
    });
    it('replays exact item requests without duplicate additions or undoing later changes', async () => {
      await asUser(B);
      const x = await put(),
        before = await row();
      await put(x.id, list, {}, null, x.parentRevision, x.request);
      expect((await row()).revision).toBe(before.revision);
      await put(x.id, list, { checked: true }, 1);
      await put(x.id, list, {}, null, x.parentRevision, x.request);
      expect((await child(x.id)).checked).toBe(true);
      await expect(
        put(x.id, list, { name: 'Changed payload' }, null, x.parentRevision, x.request),
      ).rejects.toThrow(/another change/);
    });
    it('uses item and parent revisions to reject stale edits and sharing transitions', async () => {
      await asUser(A);
      const parent = await row(),
        old = await child();
      await put(item, list, { checked: true, quantity: 2 }, old.revision, parent.revision);
      await expect(put(item, list, {}, old.revision, parent.revision)).rejects.toThrow(
        /list changed/,
      );
      await expect(put(item, list, {}, old.revision)).rejects.toThrow(/item changed/);
      await save(list, (await row()).revision, 'private');
      await asUser(B);
      expect(await child()).toBeUndefined();
      await expect(
        put(item, list, {}, (await child())?.revision ?? 1, parent.revision),
      ).rejects.toThrow(/inaccessible/);
      await asUser(A);
      await save(list, (await row()).revision, 'workspace');
    });
    it('denies old contributors when the parent becomes private, including archived children', async () => {
      await asUser(B);
      const x = await put();
      await put(x.id, list, { archived: true }, 1);
      await asUser(A);
      await save(list, (await row()).revision, 'private');
      await asUser(B);
      expect(await child(x.id)).toBeUndefined();
      await expect(put(x.id, list, { archived: false }, 2, 1)).rejects.toThrow(/inaccessible/);
      await asUser(A);
      await save(list, (await row()).revision, 'workspace');
      await asUser(B);
      expect((await child(x.id)).archived).toBe(true);
    });
    it('archives and restores checked items without changing their audit, and requires restore before edit', async () => {
      await asUser(A);
      const x = await put(randomUUID(), list, { checked: true });
      const before = await child(x.id);
      await put(x.id, list, { checked: true, archived: true }, 1);
      await expect(
        put(x.id, list, { checked: true, archived: false, name: 'Hidden edit' }, 2),
      ).rejects.toThrow(/Restore the item/);
      await put(x.id, list, { checked: true, archived: false }, 2);
      expect(await child(x.id)).toMatchObject({
        checked_at: before.checked_at,
        checked_by: A,
        revision: 3,
        archived: false,
      });
    });
    it('freezes archived lists and restores their item history with exact archive receipts', async () => {
      await asUser(A);
      const revision = (await row()).revision,
        request = await archive();
      await archive(list, true, revision, request);
      await expect(put()).rejects.toThrow(/Restore the shopping list/);
      await expect(save(list, (await row()).revision, 'workspace')).rejects.toThrow(
        /Restore the shopping list/,
      );
      await archive(list, false);
      expect((await child()).checked).toBe(true);
      await archive(list, true, revision, request);
      expect((await row()).archived).toBe(false);
      await expect(archive(list, false, revision, request)).rejects.toThrow(/another change/);
    });
    it('rechecks current writer permissions before cached replay after downgrade or removal', async () => {
      await asUser(B);
      const x = await put();
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await child(x.id)).toBeDefined();
      await expect(put(x.id, list, {}, null, x.parentRevision, x.request)).rejects.toThrow(
        /inaccessible/,
      );
      await expect(save()).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(await child(x.id)).toBeUndefined();
      await expect(put(x.id, list, {}, null, x.parentRevision, x.request)).rejects.toThrow(
        /inaccessible/,
      );
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('allows only the creator to publish a private member list even for the workspace owner', async () => {
      await asUser(B);
      await save(memberList, (await row(memberList)).revision, 'private');
      await asUser(A);
      expect(await row(memberList)).toBeUndefined();
      await expect(archive(memberList, true, 3)).rejects.toThrow(/inaccessible/);
      await asUser(B);
      await save(memberList, (await row(memberList)).revision, 'workspace');
    });
    it('blocks direct table writes, private receipts, foreign item IDs and anonymous calls', async () => {
      await asUser(A);
      await expect(
        db.query('update public.shopping_items set owner_id=$1 where id=$2', [B, item]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('delete from public.shopping_lists where id=$1', [list]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from private.shopping_requests')).rejects.toThrow(
        /permission denied/,
      );
      await expect(put(item, privateList, {}, (await child()).revision)).rejects.toThrow(
        /inaccessible/,
      );
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.shopping_lists')).rejects.toThrow(
        /permission denied/,
      );
      await expect(save()).rejects.toThrow(/permission denied/);
    });
    it('validates quantities, literal notes, required fields and immutable list type', async () => {
      await asUser(A);
      for (const changes of [
        { quantity: 0 },
        { quantity: -1 },
        { quantity: 1000000.001 },
        { quantity: 0.0001 },
        { quantity: 'NaN' },
        { quantity: 'Infinity' },
        { quantity: null },
        { name: '' },
        { category: 'x'.repeat(61) },
        { unit: '' },
        { notes: 'x'.repeat(2001) },
        { checked: null },
        { archived: null },
      ])
        await expect(put(randomUUID(), list, changes)).rejects.toThrow(/valid item/);
      await expect(
        save(list, (await row()).revision, 'workspace', randomUUID(), 'Changed', 'shopping'),
      ).rejects.toThrow(/type cannot change/);
      const x = await put(randomUUID(), list, {
        quantity: 0.001,
        notes: ' <script>literal</script> ',
      });
      expect((await child(x.id)).notes).toBe(' <script>literal</script> ');
    });
    it('limits lists to 500 items including archives without reusing positions', async () => {
      await asUser(A);
      const l = (await save()).id;
      await db.exec('reset role');
      await db.query(
        "insert into public.shopping_items(id,workspace_id,owner_id,list_id,name,category,quantity,unit,position,archived) select gen_random_uuid(),$1,$2,$3,'Fixture','Other',1,'items',n,true from generate_series(1,500) n",
        [w, A, l],
      );
      await asUser(A);
      await expect(put(randomUUID(), l)).rejects.toThrow(/500 items/);
    });
  });
}
