import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function learningSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private learning, lesson progress and linked certificates', () => {
    let db: PGlite,
      w: string,
      item: string,
      lesson: string,
      otherItem: string,
      file: string,
      note: string;
    type Item = {
      id: string;
      revision: number;
      status: string;
      archived: boolean;
      completed_on: string | null;
      title: string;
      owner_id: string;
    };
    async function row(id = item) {
      return (
        await db.query<Item>(
          'select id,revision,status,archived,completed_on::text,title,owner_id from public.learning_items where id=$1',
          [id],
        )
      ).rows[0];
    }
    async function save(
      id = randomUUID(),
      revision: number | null = null,
      changes: Record<string, unknown> = {},
      request = randomUUID(),
    ) {
      const v = {
        kind: 'course',
        title: 'SQL foundations',
        provider: 'Learning library',
        url: 'https://example.com/@sql',
        goal: 'Build a safe app',
        deadline: '2026-12-31',
        notes: '  Literal <script>text</script>  ',
        note_ids: [],
        document_ids: [],
        certificate_ids: [],
        ...changes,
      };
      await db.query(
        'select public.save_learning_item($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [
          request,
          id,
          w,
          revision,
          v.kind,
          v.title,
          v.provider,
          v.url,
          v.goal,
          v.deadline,
          v.notes,
          v.note_ids,
          v.document_ids,
          v.certificate_ids,
        ],
      );
      return { id, request };
    }
    async function unit(
      id = randomUUID(),
      parent = item,
      done = false,
      archived = false,
      revision: number | null = null,
      parentRevision?: number,
      request = randomUUID(),
      title = 'First lesson',
    ) {
      await db.query('select public.save_learning_unit($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        request,
        id,
        parent,
        revision,
        parentRevision ?? (await row(parent)).revision,
        title,
        'Keep notes',
        done,
        archived,
      ]);
      return { id, request };
    }
    async function state(
      target = 'active',
      archived = false,
      id = item,
      revision?: number,
      request = randomUUID(),
    ) {
      await db.query('select public.set_learning_state($1,$2,$3,$4,$5)', [
        request,
        id,
        revision ?? (await row(id)).revision,
        target,
        archived,
      ]);
      return request;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Learning security','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('creates exactly once, preserves text and rejects changed request payloads', async () => {
      const saved = await save();
      item = saved.id;
      await save(item, null, {}, saved.request);
      expect(await row()).toMatchObject({
        revision: 1,
        status: 'active',
        archived: false,
        completed_on: null,
        owner_id: A,
      });
      await expect(save(item, null, { title: 'Changed replay' }, saved.request)).rejects.toThrow(
        /another change/,
      );
      expect(
        (
          await db.query<{ notes: string }>('select notes from public.learning_items where id=$1', [
            item,
          ])
        ).rows[0].notes,
      ).toBe('  Literal <script>text</script>  ');
    });
    it('rejects invalid bounds, links, kinds and dates without creating rows', async () => {
      for (const changes of [
        { kind: 'video' },
        { title: '' },
        { provider: 'x'.repeat(201) },
        { goal: 'x'.repeat(1001) },
        { notes: 'x'.repeat(4001) },
        { url: 'javascript:alert(1)' },
        { url: 'https://user:pass@example.com' },
        { deadline: '2101-01-01' },
        { note_ids: [null] },
        { note_ids: Array(51).fill(randomUUID()) },
      ])
        await expect(save(randomUUID(), null, changes)).rejects.toThrow();
    });
    it('requires revisions and prevents forged direct writes or receipt access', async () => {
      await save(item, 1, { title: 'Updated course' });
      await expect(save(item, 1)).rejects.toThrow(/changed/);
      for (const table of [
        'learning_items',
        'learning_units',
        'learning_notes',
        'learning_documents',
      ]) {
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`update public.${table} set owner_id=$1`, [B])).rejects.toThrow(
          /permission denied/,
        );
      }
      await expect(db.query('select * from private.learning_requests')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query(
          "insert into public.learning_items(id,workspace_id,owner_id,kind,title)values($1,$2,$3,'book','Forged')",
          [randomUUID(), w, A],
        ),
      ).rejects.toThrow(/permission denied/);
    });
    it('adds a lesson once and rejects stale parent edits and lesson moves', async () => {
      const before = await row(),
        saved = await unit();
      lesson = saved.id;
      await unit(lesson, item, false, false, null, before.revision, saved.request);
      expect((await row()).revision).toBe(before.revision + 1);
      await expect(save(item, before.revision)).rejects.toThrow(/changed/);
      await expect(unit(randomUUID(), item, false, false, null, before.revision)).rejects.toThrow(
        /changed/,
      );
      const another = (await save()).id;
      await expect(unit(lesson, another, false, false, 1)).rejects.toThrow(/inaccessible/);
    });
    it('completes on the final lesson and reopens on an unfinished addition or reopened lesson', async () => {
      await unit(lesson, item, true, false, 1);
      expect(await row()).toMatchObject({ status: 'completed' });
      expect((await row()).completed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await unit(lesson, item, false, false, 2);
      expect(await row()).toMatchObject({ status: 'active', completed_on: null });
      await expect(state('completed')).rejects.toThrow(/remaining lessons/);
      await unit(lesson, item, true, false, 3);
      const next = (await unit()).id;
      expect((await row()).status).toBe('active');
      await unit(next, item, true, false, 1);
      expect((await row()).status).toBe('completed');
    });
    it('preserves archived lesson history and recalculates progress after restoration', async () => {
      await unit(lesson, item, false, true, 4);
      expect((await row()).status).toBe('completed');
      await unit(lesson, item, false, false, 5);
      expect((await row()).status).toBe('active');
      expect(
        (await db.query('select id from public.learning_units where item_id=$1', [item])).rows,
      ).toHaveLength(2);
    });
    it('pauses, archives and restores without erasing progress, and rejects stale reversals', async () => {
      await state('paused');
      await expect(unit()).rejects.toThrow(/resume/);
      await state('active');
      const before = await row(),
        request = await state('active', true);
      await state('active', true, item, before.revision, request);
      expect((await row()).revision).toBe(before.revision + 1);
      await expect(save(item, (await row()).revision)).rejects.toThrow(/Restore/);
      await expect(state('active', false, item, before.revision)).rejects.toThrow(/changed/);
      await expect(state('paused', true)).rejects.toThrow(/Restore/);
      await state('active', false);
    });
    it('allows manual completion with no tracked lessons and reopening without inventing progress', async () => {
      const id = (await save(randomUUID(), null, { kind: 'book' })).id;
      await state('completed', false, id);
      expect((await row(id)).completed_on).toBeTruthy();
      await state('active', false, id);
      expect((await row(id)).completed_on).toBeNull();
    });
    it('links owned notes and completed file versions, changes purpose and unlinks without deleting sources', async () => {
      note = (
        await db.query<{ id: string }>(
          "insert into public.notes(workspace_id,title)values($1,'Private study note')returning id",
          [w],
        )
      ).rows[0].id;
      file = randomUUID();
      const path = `${A}/${w}/${file}.txt`;
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Synthetic certificate',$3,'text/plain',5)",
        [file, w, path],
      );
      await db.query(
        'insert into storage.objects(bucket_id,name,metadata)values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
        [path],
      );
      await db.query('select public.complete_attachment($1)', [file]);
      await save(item, (await row()).revision, { note_ids: [note], certificate_ids: [file] });
      expect(
        (await db.query('select purpose from public.learning_documents where item_id=$1', [item]))
          .rows,
      ).toEqual([{ purpose: 'certificate' }]);
      await db.query("select public.set_attachment_status($1,'archived')", [file]);
      await save(item, (await row()).revision, { note_ids: [note], document_ids: [file] });
      expect(
        (await db.query('select purpose from public.learning_documents where item_id=$1', [item]))
          .rows,
      ).toEqual([{ purpose: 'reference' }]);
      const before = await row();
      await expect(
        save(item, before.revision, { document_ids: [file], certificate_ids: [file] }),
      ).rejects.toThrow(/one purpose/);
      expect(await row()).toEqual(before);
      await save(item, before.revision);
      expect(
        (await db.query('select id from public.learning_documents where item_id=$1', [item])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.attachments where id=$1', [file])).rows,
      ).toHaveLength(1);
      expect((await db.query('select id from public.notes where id=$1', [note])).rows).toHaveLength(
        1,
      );
    });
    it('keeps member learning hidden from workspace owners and blocks cross-owner notes/files', async () => {
      await asUser(B);
      expect(await row()).toBeUndefined();
      expect(
        (await db.query('select id from public.learning_units where item_id=$1', [item])).rows,
      ).toHaveLength(0);
      await expect(save(item, 1)).rejects.toThrow(/inaccessible/);
      await expect(save(randomUUID(), null, { note_ids: [note] })).rejects.toThrow(/notes you own/);
      await expect(save(randomUUID(), null, { certificate_ids: [file] })).rejects.toThrow(
        /own completed/,
      );
      const ownedNote = (
        await db.query<{ id: string }>(
          "insert into public.notes(workspace_id,title,visibility)values($1,'Member shared note','workspace')returning id",
          [w],
        )
      ).rows[0].id;
      otherItem = (await save(randomUUID(), null, { note_ids: [ownedNote] })).id;
      await asUser(A);
      expect(await row(otherItem)).toBeUndefined();
      expect(
        (await db.query('select id from public.learning_notes where item_id=$1', [otherItem])).rows,
      ).toHaveLength(0);
      await expect(unit(randomUUID(), otherItem)).rejects.toThrow();
      await asUser(C);
      expect(await row()).toBeUndefined();
      await expect(save()).rejects.toThrow(/write access/);
      await asUser(A);
    });
    it('does not reuse another workspace’s owned source links', async () => {
      const other = (
          await db.query<{ id: string }>(
            "select public.create_workspace('Other learning','personal') id",
          )
        ).rows[0].id,
        foreignNote = (
          await db.query<{ id: string }>(
            "insert into public.notes(workspace_id,title)values($1,'Other note')returning id",
            [other],
          )
        ).rows[0].id;
      await expect(save(randomUUID(), null, { note_ids: [foreignNote] })).rejects.toThrow(
        /this workspace/,
      );
    });
    it('denies viewers and removed members even on successful exact retries', async () => {
      await asUser(B);
      const previous = await row(otherItem),
        request = await state('active', true, otherItem);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await row(otherItem)).toBeDefined();
      await expect(state('active', true, otherItem, previous.revision, request)).rejects.toThrow(
        /inaccessible/,
      );
      await expect(save()).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(await row(otherItem)).toBeUndefined();
      await expect(state('active', true, otherItem, previous.revision, request)).rejects.toThrow(
        /inaccessible/,
      );
      await asUser(A);
    });
    it('limits lessons including archives to 200 and leaves parent revision unchanged on overflow', async () => {
      const id = (await save()).id;
      for (let n = 0; n < 200; n++) await unit(randomUUID(), id, false, true);
      const before = await row(id);
      await expect(unit(randomUUID(), id)).rejects.toThrow(/200 lessons/);
      expect(await row(id)).toEqual(before);
    });
  });
}
