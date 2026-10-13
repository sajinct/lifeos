import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function healthTrackingSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Health logs, medication timing and immutable expense links', () => {
    let db: PGlite, w: string, today: string, expense: string, income: string, appointment: string;
    const log = () => ({
      kind: 'fitness',
      title: 'Walk',
      logged_on: today,
      minutes: 30,
      value: 2.5,
      unit: 'km',
      notes: 'Synthetic',
    });
    const med = () => ({
      title: 'Synthetic reminder schedule',
      instructions: 'User entered instructions',
      starts_on: today,
      ends_on: null,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      reminder_time: '00:00',
      timezone: 'UTC',
    });
    async function save(
      table: 'log' | 'medication',
      id = randomUUID(),
      revision: number | null = null,
      fields: Record<string, unknown> = {},
    ) {
      await db.query(
        `select public.save_${table === 'log' ? 'health_log' : 'medication_plan'}($1,$2,$3,$4::jsonb)`,
        [id, w, revision, JSON.stringify({ ...(table === 'log' ? log() : med()), ...fields })],
      );
      return id;
    }
    async function link(
      id = randomUUID(),
      revision: number | null = null,
      tx = expense,
      parent: string | null = appointment,
    ) {
      await db.query('select public.save_health_expense($1,$2,$3,$4,$5,$6)', [
        id,
        w,
        revision,
        tx,
        parent,
        'Synthetic only',
      ]);
      return id;
    }
    async function act(id: string, kind: string, revision: number, action: string) {
      await db.query('select public.act_on_health_tracking($1,$2,$3,$4)', [
        id,
        kind,
        revision,
        action,
      ]);
    }
    async function prefs(enabled: boolean) {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,23,'Pacific/Honolulu',false,7,false,3,false,1,false,7,false,30,7,false,1,30,false,1,$1)",
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
          "select id from public.notifications where source_id=$1 and source_kind='health_medication' and dismissed_at is null",
          [id],
        )
      ).rows;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Full health tests','family')as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      today = (await db.query<{ day: string }>('select current_date::text as day')).rows[0].day;
      const account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Health expenses','INR')returning id",
          [w],
        )
      ).rows[0].id;
      expense = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Synthetic clinic expense',100,'expense','Health',current_date)as id",
          [w, account],
        )
      ).rows[0].id;
      income = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Income',100,'income','Other',current_date)as id",
          [w, account],
        )
      ).rows[0].id;
      appointment = randomUUID();
      await db.query('select public.save_health_appointment($1,$2,null,$3::jsonb,$4)', [
        appointment,
        w,
        JSON.stringify({
          title: 'Synthetic visit',
          provider: '',
          location: '',
          appointment_on: today,
          appointment_time: '',
          notes: '',
          status: 'scheduled',
        }),
        [],
      ]);
    });
    it('denies direct writes and validates durations, precision, units and dates', async () => {
      for (const table of ['health_logs', 'medication_plans', 'health_expenses'])
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
      for (const fields of [
        { minutes: 0 },
        { minutes: 1441 },
        { value: 'NaN' },
        { value: 1.0001 },
        { value: -1 },
        { unit: '' },
        { logged_on: '2100-12-31' },
        { kind: 'measurement', minutes: 30 },
        { kind: 'measurement', minutes: null, value: null },
      ])
        await expect(save('log', randomUUID(), null, fields)).rejects.toThrow();
      const id = await save('log');
      await save('log', id, null, { title: 'Ignored' });
      await save('log', id, 1, { title: 'Revised' });
      await expect(save('log', id, 1)).rejects.toThrow(/changed/);
      await expect(save('log', id, 2, { kind: 'measurement', minutes: null })).rejects.toThrow();
    });
    it('validates medication weekday, time, zone and date boundaries', async () => {
      for (const fields of [
        { weekdays: [] },
        { weekdays: [1, 1] },
        { weekdays: [null] },
        { weekdays: [7] },
        { reminder_time: '24:01' },
        { timezone: 'Unknown/Zone' },
        { ends_on: '1900-01-01' },
        { instructions: 'x'.repeat(2001) },
      ])
        await expect(save('medication', randomUUID(), null, fields)).rejects.toThrow();
      const id = await save('medication');
      await save('medication', id, null, { title: 'Ignored' });
      expect(
        (await db.query('select title,revision from public.medication_plans where id=$1', [id]))
          .rows[0],
      ).toEqual({ title: 'Synthetic reminder schedule', revision: 1 });
    });
    it('preserves pause and archive state, rejects stale edits and replay', async () => {
      const id = await save('medication');
      await act(id, 'medication', 1, 'pause');
      await act(id, 'medication', 1, 'pause');
      await expect(act(id, 'medication', 1, 'resume')).rejects.toThrow(/changed/);
      await act(id, 'medication', 2, 'archive');
      await expect(save('medication', id, 3)).rejects.toThrow(/restore/);
      await act(id, 'medication', 3, 'restore');
      expect(
        (
          await db.query(
            'select active,archived,revision from public.medication_plans where id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({ active: false, archived: false, revision: 4 });
    });
    it('requires separate opt-in and uses the schedule zone/time independently of daily delivery hour', async () => {
      const id = await save('medication');
      await prefs(false);
      await dispatch();
      expect(await alerts(id)).toHaveLength(0);
      await prefs(true);
      await dispatch();
      await dispatch();
      expect(await alerts(id)).toHaveLength(1);
      await act(id, 'medication', 1, 'pause');
      expect(await alerts(id)).toHaveLength(0);
      await act(id, 'medication', 2, 'resume');
      await dispatch();
      expect(await alerts(id)).toHaveLength(0);
      const future = await save('medication', randomUUID(), null, { starts_on: '2100-12-31' });
      await dispatch();
      expect(await alerts(future)).toHaveLength(0);
      const day = new Date(today + 'T00:00:00Z').getUTCDay(),
        other = await save('medication', randomUUID(), null, { weekdays: [(day + 1) % 7] });
      await dispatch();
      expect(await alerts(other)).toHaveLength(0);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7,false,1,30,false,1)",
      );
      expect(
        (await db.query('select medication_reminders from public.app_settings where id=$1', [A]))
          .rows[0],
      ).toEqual({ medication_reminders: true });
      await prefs(false);
    });
    it('links owned expenses once without modifying finance and protects revisions', async () => {
      const before = (
          await db.query(
            'select amount,kind,account_id,project_id from public.transactions where id=$1',
            [expense],
          )
        ).rows[0],
        id = await link();
      await link(id);
      await expect(link(randomUUID())).rejects.toThrow(/already linked/);
      await expect(link(randomUUID(), null, income)).rejects.toThrow(/recorded expense/);
      await link(id, 1, expense, null);
      await expect(link(id, 1)).rejects.toThrow(/changed/);
      expect(
        (
          await db.query(
            'select amount,kind,account_id,project_id from public.transactions where id=$1',
            [expense],
          )
        ).rows[0],
      ).toEqual(before);
      await act(id, 'expense', 2, 'archive');
      await expect(link(randomUUID())).rejects.toThrow(/restore/);
      await act(id, 'expense', 3, 'restore');
    });
    it('hides logs, plans and linked expenses from members, including workspace owners', async () => {
      const a = await save('log'),
        p = await save('medication');
      await asUser(B);
      for (const table of ['health_logs', 'medication_plans', 'health_expenses'])
        expect(
          (await db.query(`select id from public.${table} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(act(a, 'log', 1, 'archive')).rejects.toThrow(/owner/);
      await expect(save('medication', p)).rejects.toThrow(/inaccessible/);
      await expect(link(randomUUID())).rejects.toThrow(/recorded expense/);
      const b = await save('log');
      await asUser(A);
      expect(
        (await db.query('select id from public.health_logs where id=$1', [b])).rows,
      ).toHaveLength(0);
      await expect(act(b, 'log', 1, 'archive')).rejects.toThrow(/owner/);
    });
    it('rejects viewer, removed-member and anonymous access', async () => {
      await asUser(C);
      await expect(save('log')).rejects.toThrow(/write/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.health_logs where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(save('medication')).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.medication_plans')).rejects.toThrow(
        /permission denied/,
      );
      await expect(save('log')).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
