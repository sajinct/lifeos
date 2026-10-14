import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function notesSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Notes/journals, private document links and reversible archives', () => {
    let db: PGlite, w: string, note: string, file: string;
    type Row = {
      id: string;
      owner_id: string;
      visibility: string;
      revision: number;
      title: string;
      body: string;
      tags: string[];
      journal_on: string | null;
      archived: boolean;
    };
    async function row(id = note) {
      return (
        await db.query<Row>(
          'select id,owner_id,visibility,revision,title,body,tags,journal_on::text,archived from public.notes where id=$1',
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
        title: 'Reflection',
        body: '  <script>literal</script>\nBody  ',
        project: null,
        tags: ['Ideas', ' work   notes ', 'ideas'],
        journal: null,
        visibility: 'private',
        documents: [],
        ...changes,
      };
      await db.query('select public.save_note($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        request,
        id,
        w,
        revision,
        v.title,
        v.body,
        v.project,
        v.tags,
        v.journal,
        v.visibility,
        v.documents,
      ]);
      return { id, request, v };
    }
    async function archive(id = note, value = true, revision?: number, request = randomUUID()) {
      await db.query('select public.set_note_archived($1,$2,$3,$4)', [
        request,
        id,
        revision ?? (await row(id)).revision,
        value,
      ]);
      return request;
    }
    async function document(owner: string, title = 'Synthetic note file', workspace = w) {
      await asUser(owner);
      const id = randomUUID(),
        path = `${owner}/${workspace}/${id}.txt`;
      await db.query(
        'insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,$3,$4,$5,5)',
        [id, workspace, title, path, 'text/plain'],
      );
      await db.query(
        'insert into storage.objects(bucket_id,name,metadata)values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
        [path],
      );
      await db.query('select public.complete_attachment($1)', [id]);
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Notes security','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('preserves literal content, normalizes bounded tags and replays creation once', async () => {
      const created = await save();
      note = created.id;
      await save(note, null, {}, created.request);
      expect(await row()).toMatchObject({
        revision: 1,
        tags: ['ideas', 'work notes'],
        body: '  <script>literal</script>\nBody  ',
        archived: false,
      });
      await expect(save(note, null, { title: 'Reused payload' }, created.request)).rejects.toThrow(
        /another change/,
      );
      for (const tags of [[null], [''], Array(11).fill('tag'), ['x'.repeat(31)], ['bad\ncontrol']])
        await expect(save(randomUUID(), null, { tags })).rejects.toThrow(/tags/);
    });
    it('blocks forged metadata, link writes and permanent deletion', async () => {
      await expect(
        db.query('update public.notes set archived=true where id=$1', [note]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query(
          "insert into public.notes(workspace_id,title,tags)values($1,'Forged',array['x'])",
          [w],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('delete from public.notes where id=$1', [note])).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query('delete from public.note_documents')).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query('delete from private.note_requests')).rejects.toThrow(
        /permission denied/,
      );
    });
    it('rejects conflicting edits, including legacy direct updates that increment revisions', async () => {
      await save(note, 1, { title: 'Updated', tags: [] });
      await expect(save(note, 1, { title: 'Stale' })).rejects.toThrow(/changed/);
      await db.query("update public.notes set title='Legacy client edit' where id=$1", [note]);
      expect((await row()).revision).toBe(3);
      await expect(save(note, 2, { title: 'Conflict' })).rejects.toThrow(/changed/);
    });
    it('archives/restores without losing content and rejects stale reversals or edits while archived', async () => {
      const n = await row(),
        request = await archive(note, true, n.revision);
      await archive(note, true, n.revision, request);
      expect((await row()).revision).toBe(n.revision + 1);
      expect((await row()).body).toBe(n.body);
      await expect(archive(note, false, n.revision)).rejects.toThrow(/changed/);
      await expect(save(note, (await row()).revision)).rejects.toThrow(/Restore/);
      await expect(
        db.query("update public.notes set body='Bypass' where id=$1", [note]),
      ).rejects.toThrow(/Restore/);
      await archive(note, false);
      expect((await row()).archived).toBe(false);
    });
    it('keeps dated journals private, including uniqueness across archives and ordinary notes', async () => {
      const id = (await save(randomUUID(), null, { journal: '2026-10-14', tags: [] })).id;
      await archive(id, true);
      await expect(save(randomUUID(), null, { journal: '2026-10-14' })).rejects.toThrow(
        /already exists/,
      );
      await expect(
        save(randomUUID(), null, { journal: '2026-10-15', visibility: 'workspace' }),
      ).rejects.toThrow(/journals must be private/);
      await asUser(B);
      expect(await row(id)).toBeUndefined();
      const other = (await save(randomUUID(), null, { journal: '2026-10-14', tags: [] })).id;
      await asUser(A);
      expect(await row(other)).toBeUndefined();
      await archive(id, false);
    });
    it('links only owned completed files and keeps links private on shared notes', async () => {
      file = await document(B);
      const shared = (
        await save(randomUUID(), null, { visibility: 'workspace', documents: [file], tags: [] })
      ).id;
      await asUser(A);
      expect((await row(shared)).visibility).toBe('workspace');
      expect(
        (
          await db.query('select attachment_id from public.note_documents where note_id=$1', [
            shared,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.attachments where id=$1', [file])).rows,
      ).toHaveLength(0);
      await expect(
        save(shared, 1, {
          title: 'Owner file takeover',
          visibility: 'workspace',
          documents: [file],
        }),
      ).rejects.toThrow(/Only the note creator/);
      await save(shared, 1, {
        title: 'Owner can edit shared text',
        visibility: 'workspace',
        documents: null,
        tags: [],
      });
      await expect(
        save(shared, 2, { visibility: 'private', documents: null, tags: [] }),
      ).rejects.toThrow(/Only the note creator/);
      await asUser(B);
      expect((await row(shared)).owner_id).toBe(B);
      expect(
        (
          await db.query('select attachment_id from public.note_documents where note_id=$1', [
            shared,
          ])
        ).rows,
      ).toEqual([{ attachment_id: file }]);
      await db.query("select public.set_attachment_status($1,'archived')", [file]);
      await save(shared, 2, { visibility: 'workspace', documents: [file], tags: [] });
      await save(shared, 3, { visibility: 'workspace', documents: [], tags: [] });
      expect(
        (
          await db.query('select attachment_id from public.note_documents where note_id=$1', [
            shared,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.attachments where id=$1', [file])).rows,
      ).toHaveLength(1);
      await asUser(A);
    });
    it('rejects another member’s file and atomically rolls back invalid document selections', async () => {
      const before = await row();
      await expect(
        save(note, before.revision, { title: 'Must roll back', documents: [file] }),
      ).rejects.toThrow(/own completed/);
      expect(await row()).toEqual(before);
      const pending = randomUUID();
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Pending',$3,'text/plain',5)",
        [pending, w, `${A}/${w}/${pending}.txt`],
      );
      await expect(save(randomUUID(), null, { documents: [pending] })).rejects.toThrow(
        /own completed/,
      );
      await expect(save(randomUUID(), null, { documents: [null] })).rejects.toThrow(
        /own completed/,
      );
    });
    it('enforces shared project access and cannot move note ownership or workspace', async () => {
      const project = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title)values($1,'Private note project')returning id",
          [w],
        )
      ).rows[0].id;
      await expect(save(randomUUID(), null, { visibility: 'workspace', project })).rejects.toThrow(
        /Project.*private/,
      );
      await asUser(B);
      await expect(save(randomUUID(), null, { project })).rejects.toThrow(/Project.*inaccessible/);
      await asUser(A);
      await expect(
        db.query('update public.notes set owner_id=$1 where id=$2', [B, note]),
      ).rejects.toThrow(/permission denied/);
      await asUser(C);
      await expect(save()).rejects.toThrow(/write access/);
      expect(await row()).toBeUndefined();
      await asUser(A);
    });
    it('denies viewers and revoked members even on exact archive retries', async () => {
      await asUser(B);
      const created = await save(),
        n = await row(created.id),
        request = await archive(n.id, true, n.revision);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await row(created.id)).toBeDefined();
      await expect(archive(created.id, true, n.revision, request)).rejects.toThrow(/inaccessible/);
      await expect(save()).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(await row(created.id)).toBeUndefined();
      await expect(archive(created.id, true, n.revision, request)).rejects.toThrow(/inaccessible/);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('never reuses structured or archived notes as plain JSON import duplicates', async () => {
      const plain = (
        await save(randomUUID(), null, { title: 'Import candidate', body: 'Body', tags: [] })
      ).id;
      await archive(plain, true);
      const payload = {
        projects: [],
        rows: [
          {
            kind: 'note',
            source_id: 'new-note-source',
            project_source: null,
            title: 'Import candidate',
            status: null,
            priority: null,
            due_date: null,
            body: 'Body',
          },
        ],
      };
      const result = (
        await db.query<{ result: { notes_imported: number } }>(
          'select public.import_record_json($1,$2,$3) result',
          [randomUUID(), w, payload],
        )
      ).rows[0].result;
      expect(result.notes_imported).toBe(1);
      await expect(
        db.query('select public.import_record_json($1,$2,$3)', [
          randomUUID(),
          w,
          { ...payload, rows: [{ ...payload.rows[0], source_id: plain }] },
        ]),
      ).rejects.toThrow(/Existing note source/);
    });
  });
}
