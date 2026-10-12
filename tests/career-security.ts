import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function careerSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
) {
  describe('Private career records and reminder lifecycle', () => {
    let db: PGlite,
      w: string,
      other: string,
      file: string,
      foreign: string,
      unfinished: string,
      app: string,
      today: string;
    const details = (kind = 'application') => ({
      kind,
      title: 'Example role',
      organization: 'Example company',
      location: 'Remote',
      skills: 'Angular',
      url: 'https://example.com/jobs',
      notes: 'Synthetic only',
      status: kind === 'application' ? 'applied' : 'active',
      starts_on: kind === 'employment' ? '2025-01-01' : null,
      ends_on: null,
      applied_on: kind === 'application' ? '2025-01-01' : null,
      interview_on: kind === 'application' ? today : null,
      follow_up_on: kind === 'application' ? today : null,
      expires_on: kind === 'certification' ? today : null,
    });
    async function save(
      v: {
        id?: string;
        workspace?: string;
        revision?: number;
        fields?: Record<string, unknown>;
        files?: string[];
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.save_career_record($1,$2,$3,$4::jsonb,$5)', [
        id,
        v.workspace ?? w,
        v.revision ?? null,
        JSON.stringify({ ...details(), ...v.fields }),
        v.files ?? [file],
      ]);
      return id;
    }
    async function act(id: string, revision: number, action: string) {
      return db.query('select public.act_on_career_record($1,$2,$3)', [id, revision, action]);
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Career isolation','professional') as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      today = new Date().toISOString().slice(0, 10);
      file = randomUUID();
      unfinished = randomUUID();
      for (const id of [file, unfinished])
        await db.query(
          "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Sample CV.pdf',$3,'application/pdf',10)",
          [id, w, `${A}/${w}/${id}.pdf`],
        );
      await db.exec('reset role');
      await db.query("update public.attachments set status='ready' where id=$1", [file]);
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other career') as id")
      ).rows[0].id;
      foreign = randomUUID();
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Foreign CV.pdf',$3,'application/pdf',10)",
        [foreign, w, `${B}/${w}/${foreign}.pdf`],
      );
      await db.exec('reset role');
      await db.query("update public.attachments set status='ready' where id=$1", [foreign]);
      await asUser(A);
    });
    it('denies browser table mutations and rejects invalid fields, dates, statuses and URLs', async () => {
      for (const t of ['career_records', 'career_documents'])
        await expect(db.query(`delete from public.${t}`)).rejects.toThrow(/permission denied/);
      for (const fields of [
        { title: '' },
        { organization: '' },
        { url: 'javascript:alert(1)' },
        { status: 'active' },
        { notes: 'x'.repeat(4001) },
        { applied_on: '2026-02-30' },
        { applied_on: '2101-01-01' },
        { follow_up_on: '2024-01-01' },
        { ...details('employment'), starts_on: null },
        { ...details('employment'), ends_on: '2024-01-01' },
        { ...details('certification'), starts_on: '2025-01-01', expires_on: '2024-01-01' },
      ])
        await expect(save({ fields })).rejects.toThrow();
    });
    it('makes creation retries safe and rejects stale revisions and section changes', async () => {
      app = await save({ files: [file, file] });
      await save({ id: app, fields: { title: 'Ignored retry' } });
      expect(
        (await db.query('select title,revision from public.career_records where id=$1', [app]))
          .rows[0],
      ).toEqual({ title: 'Example role', revision: 1 });
      expect(
        (await db.query('select id from public.career_documents where record_id=$1', [app])).rows,
      ).toHaveLength(1);
      await save({ id: app, revision: 1, fields: { title: 'Edited role' } });
      await expect(save({ id: app, revision: 1 })).rejects.toThrow(/changed/);
      await expect(save({ id: app, revision: 2, fields: details('employment') })).rejects.toThrow(
        /Invalid/,
      );
    });
    it('validates every document before changing any record or link and retains archived versions', async () => {
      for (const id of [foreign, unfinished, randomUUID()])
        await expect(save({ id: app, revision: 2, files: [id] })).rejects.toThrow(
          /completed document/,
        );
      expect(
        (await db.query('select revision from public.career_records where id=$1', [app])).rows[0],
      ).toEqual({ revision: 2 });
      await db.query("select public.set_attachment_status($1,'archived')", [file]);
      await save({ id: app, revision: 2 });
      const ownElsewhere = randomUUID();
      await asUser(B);
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Other.pdf',$3,'application/pdf',10)",
        [ownElsewhere, other, `${B}/${other}/${ownElsewhere}.pdf`],
      );
      await db.exec('reset role');
      await db.query(
        "update public.attachments set owner_id=$1::uuid,object_path=$1::uuid::text||'/'||workspace_id::text||'/'||id::text||'.pdf',status='ready' where id=$2",
        [A, ownElsewhere],
      );
      await asUser(A);
      await expect(save({ id: app, revision: 3, files: [ownElsewhere] })).rejects.toThrow(
        /completed document/,
      );
    });
    it('keeps records private from other editors and workspace owners', async () => {
      await asUser(B);
      for (const t of ['career_records', 'career_documents'])
        expect(
          (await db.query(`select id from public.${t} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(save({ id: app, revision: 3, files: [] })).rejects.toThrow(/inaccessible/);
      await expect(act(app, 3, 'archive')).rejects.toThrow(/owner/);
      const mine = await save({ files: [] });
      await asUser(A);
      expect(
        (await db.query('select id from public.career_records where id=$1', [mine])).rows,
      ).toHaveLength(0);
      await expect(act(mine, 1, 'archive')).rejects.toThrow(/owner/);
    });
    it('delivers separate follow-up, interview and certification alerts once', async () => {
      const cert = await save({ fields: details('certification'), files: [] });
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,true,1,30)",
      );
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query(
            'select source_kind from public.notifications where source_id=$1 and dismissed_at is null order by source_kind',
            [app],
          )
        ).rows,
      ).toEqual([{ source_kind: 'career_follow_up' }, { source_kind: 'career_interview' }]);
      expect(
        (
          await db.query(
            'select title from public.notifications where source_id=$1 and dismissed_at is null',
            [cert],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await db.query<{ title: string }>(
            'select title from public.notifications where source_id=$1',
            [cert],
          )
        ).rows[0].title,
      ).toMatch(/^Certification expires/);
      await asUser(A);
    });
    it('completes dates without duplicate effects and rejects stale completion of a new date', async () => {
      await act(app, 3, 'follow_up');
      await act(app, 3, 'follow_up');
      await expect(act(app, 3, 'interview')).rejects.toThrow(/changed/);
      expect(
        (
          await db.query(
            "select id from public.notifications where source_id=$1 and source_kind='career_follow_up' and dismissed_at is null",
            [app],
          )
        ).rows,
      ).toHaveLength(0);
      await save({ id: app, revision: 4, fields: { follow_up_on: '2100-01-01' } });
      await expect(act(app, 3, 'follow_up')).rejects.toThrow(/changed/);
      expect(
        (await db.query('select follow_up_on::text from public.career_records where id=$1', [app]))
          .rows[0],
      ).toEqual({ follow_up_on: '2100-01-01' });
      await act(app, 5, 'interview');
      await act(app, 5, 'interview');
    });
    it('stops reminders when applications close, preserves links and supports archives', async () => {
      await save({ id: app, revision: 6, fields: { status: 'accepted' } });
      await expect(act(app, 7, 'follow_up')).rejects.toThrow(/Invalid/);
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await asUser(A);
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id=$1 and dismissed_at is null',
            [app],
          )
        ).rows,
      ).toHaveLength(0);
      await act(app, 7, 'archive');
      await act(app, 7, 'archive');
      await act(app, 8, 'restore');
      expect(
        (await db.query('select status from public.career_records where id=$1', [app])).rows[0],
      ).toEqual({ status: 'applied' });
      expect(
        (await db.query('select id from public.career_documents where record_id=$1', [app])).rows,
      ).toHaveLength(1);
    });
    it('preserves new preferences through old clients and dismisses alerts on opt-out', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7)",
      );
      expect(
        (await db.query('select career_reminders from public.app_settings where id=$1', [A]))
          .rows[0],
      ).toEqual({ career_reminders: true });
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,false,1,30)",
      );
      expect(
        (
          await db.query(
            "select id from public.notifications where owner_id=$1 and source_kind in ('career_follow_up','career_interview','certification') and dismissed_at is null",
            [A],
          )
        ).rows,
      ).toHaveLength(0);
      await expect(db.query('select public.deliver_due_reminders()')).rejects.toThrow(
        /permission denied/,
      );
    });
    it('blocks viewer writes, revoked memberships and anonymous access', async () => {
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(save({ files: [] })).rejects.toThrow(/write/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.career_records where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(save({ files: [] })).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.career_records')).rejects.toThrow(
        /permission denied/,
      );
      await expect(save({ files: [] })).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
