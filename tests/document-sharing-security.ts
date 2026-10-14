import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function documentSharingSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Exact document version sharing and revocation', () => {
    let db: PGlite, w: string, file: string, next: string, receipt: string, unfinished: string;
    const id = randomUUID(),
      req = randomUUID();
    async function document(
      bucket = 'personal-documents',
      previous: string | null = null,
      complete = true,
    ) {
      const id = randomUUID(),
        mime = bucket === 'personal-documents' ? 'text/plain' : 'application/pdf';
      const path = `${A}/${w}/${id}.${mime === 'text/plain' ? 'txt' : 'pdf'}`;
      await db.query(
        'insert into public.attachments(id,workspace_id,bucket_id,name,object_path,mime_type,size_bytes,previous_version_id)values($1,$2,$3,$4,$5,$6,5,$7)',
        [id, w, bucket, 'Private filename', path, mime, previous],
      );
      if (complete) {
        await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3)', [
          bucket,
          path,
          JSON.stringify({ size: 5, mimetype: mime }),
        ]);
        await db.query('select public.complete_attachment($1)', [id]);
      }
      return id;
    }
    async function set(
      entry = id,
      source = file,
      recipient = B,
      rev: number | null = null,
      revoked = false,
      request = randomUUID(),
    ) {
      return db.query('select public.set_document_share($1,$2,$3,$4,$5,$6,$7)', [
        request,
        entry,
        w,
        source,
        recipient,
        rev,
        revoked,
      ]);
    }
    async function catalog() {
      return (await db.query('select * from public.document_share_catalog($1)', [w])).rows;
    }
    async function download(entry = id) {
      return (await db.query('select * from public.document_share_download($1)', [entry])).rows;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Document sharing test','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, C]);
      file = await document();
      next = await document('personal-documents', file);
      receipt = await document('financial-receipts');
      unfinished = await document('personal-documents', null, false);
    });
    it('starts private and rejects receipts, unfinished files, self and nonmembers', async () => {
      await asUser(B);
      expect(await catalog()).toEqual([]);
      expect(await download()).toEqual([]);
      await asUser(A);
      await expect(set(randomUUID(), receipt)).rejects.toThrow(/completed document/);
      await expect(set(randomUUID(), unfinished)).rejects.toThrow(/completed document/);
      await expect(set(randomUUID(), file, A)).rejects.toThrow(/another/);
      await expect(set(randomUUID(), file, randomUUID())).rejects.toThrow(/current workspace/);
    });
    it('publishes only the selected old version and minimal catalog fields', async () => {
      await asUser(A);
      await set(id, file, B, null, false, req);
      await asUser(B);
      const rows = await catalog();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id, attachment_id: file, version_number: 1, revoked: false });
      for (const field of [
        'object_path',
        'project_id',
        'transaction_id',
        'expires_on',
        'category',
        'previous_version_id',
      ])
        expect(rows[0]).not.toHaveProperty(field);
      const d = await download();
      expect(d).toHaveLength(1);
      expect(d[0].object_path).toContain(file);
      expect(
        (await db.query('select * from public.attachments where workspace_id=$1', [w])).rows,
      ).toEqual([]);
    });
    it('does not grant direct Storage or signed-token permissions to recipients', async () => {
      await asUser(B);
      expect(
        (await db.query('select * from storage.objects where name like $1', [`%/${w}/%`])).rows,
      ).toEqual([]);
      await expect(
        db.query(
          "insert into storage.objects(bucket_id,name)values('personal-documents','forged')",
        ),
      ).rejects.toThrow(/row-level/);
      await db.query('delete from storage.objects where name like $1', [`%/${w}/%`]);
      await asUser(A);
      expect(
        (await db.query('select * from storage.objects where name like $1', [`%/${w}/%`])).rows,
      ).toHaveLength(3);
    });
    it('excludes other members and rejects recipient modifications or sharing another owner file', async () => {
      await asUser(C);
      expect(await catalog()).toEqual([]);
      expect(await download()).toEqual([]);
      await expect(set(randomUUID(), file, B)).rejects.toThrow(/your own/);
      await asUser(B);
      await expect(set(id, file, B, 1, true)).rejects.toThrow(/your own/);
      await expect(
        db.query('update public.document_shares set revoked=true where id=$1', [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('delete from public.document_shares where id=$1', [id]),
      ).rejects.toThrow(/permission denied/);
    });
    it('preserves exact retry identities and rejects reused or stale requests', async () => {
      await asUser(A);
      await set(id, file, B, null, false, req);
      expect(
        (await db.query('select revision from public.document_shares where id=$1', [id])).rows[0]
          .revision,
      ).toBe(1);
      await expect(set(id, file, B, 1, true, req)).rejects.toThrow(/identity/);
      await expect(set(id, file, B, 9, true)).rejects.toThrow(/changed/);
      await expect(set(id, next, B, 1, true)).rejects.toThrow(/binding/);
      await expect(set(randomUUID(), file, B)).rejects.toThrow(/unique/);
    });
    it('revokes future access and cannot be undone by replaying an old successful grant', async () => {
      await asUser(A);
      await set(id, file, B, 1, true);
      await set(id, file, B, null, false, req);
      expect(
        (await db.query('select revoked,revision from public.document_shares where id=$1', [id]))
          .rows[0],
      ).toMatchObject({ revoked: true, revision: 2 });
      await asUser(B);
      expect(await catalog()).toEqual([]);
      expect(await download()).toEqual([]);
      await asUser(A);
      expect(await catalog()).toHaveLength(1);
      await set(id, file, B, 2, false);
      await asUser(B);
      expect(await download()).toHaveLength(1);
    });
    it('automatically revokes on recipient removal and rejoining does not restore it', async () => {
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(await catalog()).toEqual([]);
      expect(await download()).toEqual([]);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await download()).toEqual([]);
      await asUser(A);
      await set(id, file, B, 4, false);
    });
    it('lets a downgraded file owner revoke but forbids restoring access', async () => {
      const ownedByC = randomUUID(),
        share = randomUUID();
      await asUser(C);
      const path = `${C}/${w}/${ownedByC}.txt`;
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Member file.txt',$3,'text/plain',5)",
        [ownedByC, w, path],
      );
      await db.query(
        'insert into storage.objects(bucket_id,name,metadata)values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
        [path],
      );
      await db.query('select public.complete_attachment($1)', [ownedByC]);
      await set(share, ownedByC, A);
      await asUser(A);
      await expect(set(share, ownedByC, A, 1, true)).rejects.toThrow(/your own/);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      await asUser(C);
      await set(share, ownedByC, A, 1, true);
      await expect(set(share, ownedByC, A, 2, false)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, C]);
      await asUser(C);
      await set(share, ownedByC, A, 2, false);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, C]);
      expect(
        (await db.query('select * from public.document_share_download($1)', [share])).rows,
      ).toEqual([]);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, C]);
      expect(
        (await db.query('select * from public.document_share_download($1)', [share])).rows,
      ).toEqual([]);
    });
    it('requires current permissions even when replaying a previously successful request', async () => {
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await expect(set(id, file, B, null, false, req)).rejects.toThrow(/current workspace member/);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
    });
    it('denies anonymous RPC and metadata access', async () => {
      await db.exec('reset role;set role anon');
      await expect(catalog()).rejects.toThrow(/permission denied/);
      await expect(download()).rejects.toThrow(/permission denied/);
      await expect(set()).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from public.document_shares')).rejects.toThrow(
        /permission denied/,
      );
    });
  });
}
