import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function healthSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Owner-private health appointments and documents', () => {
    let db: PGlite,
      w: string,
      other: string,
      file: string,
      foreign: string,
      unfinished: string,
      today: string;
    const details = () => ({
      title: 'Synthetic appointment',
      provider: 'Example clinic',
      location: 'Room 2',
      appointment_on: today,
      appointment_time: '10:30',
      notes: 'Synthetic only',
      status: 'scheduled',
    });
    async function save(
      id = randomUUID(),
      revision: number | null = null,
      fields: Record<string, unknown> = {},
      files: string[] = [file],
      workspace = w,
    ) {
      await db.query('select public.save_health_appointment($1,$2,$3,$4::jsonb,$5)', [
        id,
        workspace,
        revision,
        JSON.stringify({ ...details(), ...fields }),
        files,
      ]);
      return id;
    }
    async function act(id: string, revision: number, action: string) {
      await db.query('select public.act_on_health_appointment($1,$2,$3)', [id, revision, action]);
    }
    async function rev(id: string) {
      return (
        await db.query<{ revision: number }>(
          'select revision from public.health_appointments where id=$1',
          [id],
        )
      ).rows[0].revision;
    }
    async function prefs(enabled = true) {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,false,1,30,$1,3)",
        [enabled],
      );
    }
    async function dispatch() {
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await asUser(A);
    }
    async function alerts(id: string) {
      return (
        await db.query(
          "select id,title from public.notifications where source_id=$1 and source_kind='health_appointment' and dismissed_at is null",
          [id],
        )
      ).rows;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Health isolation','family')as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      today = (await db.query<{ day: string }>('select current_date::text as day')).rows[0].day;
      file = randomUUID();
      unfinished = randomUUID();
      for (const id of [file, unfinished])
        await db.query(
          "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Synthetic visit note.pdf',$3,'application/pdf',10)",
          [id, w, `${A}/${w}/${id}.pdf`],
        );
      await db.exec('reset role');
      await db.query("update public.attachments set status='ready' where id=$1", [file]);
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other health')as id")
      ).rows[0].id;
      foreign = randomUUID();
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Other private file.pdf',$3,'application/pdf',10)",
        [foreign, w, `${B}/${w}/${foreign}.pdf`],
      );
      await db.exec('reset role');
      await db.query("update public.attachments set status='ready' where id=$1", [foreign]);
      await asUser(A);
    });
    it('denies direct browser writes and validates input', async () => {
      for (const table of ['health_appointments', 'health_documents']) {
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
        await expect(
          db.query(`insert into public.${table}(id)values($1)`, [randomUUID()]),
        ).rejects.toThrow(/permission denied/);
      }
      for (const fields of [
        { title: '' },
        { title: 'x'.repeat(201) },
        { notes: 'x'.repeat(4001) },
        { provider: 'x'.repeat(201) },
        { location: 'x'.repeat(301) },
        { appointment_time: '24:01' },
        { appointment_time: '9:30' },
        { appointment_on: '2026-02-30' },
        { appointment_on: '2101-01-01' },
        { status: 'shared' },
        { status: 'completed', appointment_on: '2100-12-31' },
      ])
        await expect(save(randomUUID(), null, fields)).rejects.toThrow();
      await expect(save(randomUUID(), null, {}, Array(51).fill(file))).rejects.toThrow(
        /50 documents/,
      );
    });
    it('replays stable creation and rejects stale edits without changing links', async () => {
      const id = await save();
      await save(id, null, { title: 'Ignored' }, []);
      expect(await rev(id)).toBe(1);
      await save(id, 1, { title: 'Revised' });
      await expect(save(id, 1, { title: 'Stale' }, [])).rejects.toThrow(/changed/);
      expect(
        (
          await db.query(
            'select attachment_id from public.health_documents where appointment_id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ attachment_id: file }]);
    });
    it('binds completed documents to the owner and workspace and replaces them atomically', async () => {
      const id = await save();
      for (const f of [foreign, unfinished, randomUUID()])
        await expect(save(id, 1, {}, [f])).rejects.toThrow(/own completed document/);
      await expect(save(id, 1, {}, [file], other)).rejects.toThrow(/write|inaccessible/);
      expect(await rev(id)).toBe(1);
      await save(id, 1, {}, []);
      expect(
        (await db.query('select id from public.health_documents where appointment_id=$1', [id]))
          .rows,
      ).toHaveLength(0);
      await db.exec('reset role');
      await db.query("update public.attachments set status='archived' where id=$1", [file]);
      await asUser(A);
      await save(id, 2, {}, [file]);
    });
    it('never exposes private appointments or document links to other workspace roles', async () => {
      const id = await save();
      await asUser(B);
      for (const table of ['health_appointments', 'health_documents'])
        expect(
          (await db.query(`select id from public.${table} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(act(id, 1, 'cancel')).rejects.toThrow(/owner/);
      await expect(save(id)).rejects.toThrow(/inaccessible/);
      const own = await save(randomUUID(), null, {}, []);
      await asUser(A);
      expect(
        (await db.query('select id from public.health_appointments where id=$1', [own])).rows,
      ).toHaveLength(0);
      await expect(act(own, 1, 'archive')).rejects.toThrow(/owner/);
      await asUser(C);
      await expect(save(randomUUID(), null, {}, [])).rejects.toThrow(/write/);
      await asUser(A);
    });
    it('preserves status and links through archives and protects newer actions', async () => {
      const id = await save();
      await act(id, 1, 'complete');
      await act(id, 1, 'complete');
      await expect(act(id, 1, 'reopen')).rejects.toThrow(/changed/);
      await act(id, 2, 'archive');
      await act(id, 2, 'archive');
      await expect(save(id, 3)).rejects.toThrow(/restore/);
      await expect(act(id, 3, 'reopen')).rejects.toThrow(/restore/);
      await act(id, 3, 'restore');
      expect(
        (
          await db.query(
            'select status,archived,revision from public.health_appointments where id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({ status: 'completed', archived: false, revision: 4 });
      expect(
        (await db.query('select id from public.health_documents where appointment_id=$1', [id]))
          .rows,
      ).toHaveLength(1);
      await act(id, 4, 'reopen');
      await act(id, 5, 'cancel');
      await act(id, 5, 'cancel');
      expect(await rev(id)).toBe(6);
    });
    it('forbids future visit completion and allows independent cancellation', async () => {
      const id = await save(randomUUID(), null, { appointment_on: '2100-12-31' });
      await expect(act(id, 1, 'complete')).rejects.toThrow(/future/);
      await act(id, 1, 'cancel');
      expect(await rev(id)).toBe(2);
    });
    it('delivers only opted-in scheduled reminders and clears cancelled or archived sources', async () => {
      const id = await save();
      await dispatch();
      expect(await alerts(id)).toHaveLength(0);
      await prefs();
      await dispatch();
      await dispatch();
      expect(await alerts(id)).toHaveLength(1);
      expect((await alerts(id))[0].title).toMatch(/^Health appointment due/);
      await asUser(B);
      expect(
        (await db.query('select id from public.notifications where source_id=$1', [id])).rows,
      ).toHaveLength(0);
      await asUser(A);
      await act(id, 1, 'cancel');
      expect(await alerts(id)).toHaveLength(0);
      await act(id, 2, 'reopen');
      await dispatch();
      expect(await alerts(id)).toHaveLength(0);
      const second = await save();
      await dispatch();
      await act(second, 1, 'archive');
      expect(await alerts(second)).toHaveLength(0);
      const third = await save();
      await dispatch();
      await act(third, 1, 'complete');
      expect(await alerts(third)).toHaveLength(0);
    });
    it('dismisses stale rescheduled notices and preserves settings through old RPC clients', async () => {
      const id = await save();
      await dispatch();
      expect(await alerts(id)).toHaveLength(1);
      await save(id, 1, { appointment_on: '2100-12-31' });
      expect(await alerts(id)).toHaveLength(0);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,false,1,30)",
      );
      expect(
        (await db.query('select health_reminders from public.app_settings where id=$1', [A]))
          .rows[0],
      ).toEqual({ health_reminders: true });
      const second = await save();
      await dispatch();
      await prefs(false);
      expect(await alerts(second)).toHaveLength(0);
      await expect(db.query('select public.deliver_due_reminders()')).rejects.toThrow(
        /permission denied/,
      );
    });
    it('revokes health and file-link access on member removal and rejects anonymous access', async () => {
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      for (const table of ['health_appointments', 'health_documents'])
        expect(
          (await db.query(`select id from public.${table} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(save(randomUUID(), null, {}, [])).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.health_appointments')).rejects.toThrow(
        /permission denied/,
      );
      await expect(save()).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
