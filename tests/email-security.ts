import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function emailSecurityTests(database: () => PGlite, asUser: (id: string) => Promise<void>) {
  describe('Private opt-in email outbox', () => {
    let db: PGlite, w: string, other: string;
    const A = randomUUID(),
      B = randomUUID(),
      C = randomUUID();
    const day = new Date().toISOString().slice(0, 10),
      weekday = new Date(day + 'T00:00:00Z').getUTCDay();
    const service = () => db.exec('reset role;set role service_role');
    const inspect = async <T>(sql: string, args: unknown[]) => {
      await db.exec('reset role');
      const result = await db.query<T>(sql, args);
      await service();
      return result;
    };
    const save = async (
      revision: number,
      reminders = true,
      daily = true,
      weekly = true,
      finance = 'weekly',
      hour = 0,
      zone = 'UTC',
    ) =>
      (
        await db.query<{ revision: number; owner_id: string }>(
          'select (public.save_email_preferences($1,$2,$3,$4,$5,$6,$7,$8)).*',
          [revision, reminders, daily, weekly, finance, hour, weekday, zone],
        )
      ).rows[0];
    const queue = () => db.query<{ n: number }>('select public.queue_email_deliveries() n');
    const claim = async (clock = new Date().toISOString(), sender = 'sender@example.test') =>
      (
        await db.query<{
          job: {
            id: string;
            lease: string;
            payload: { from: string; to: string[]; subject: string; text: string };
          } | null;
        }>('select public.claim_email_delivery($1,$2) job', [sender, clock])
      ).rows[0].job;
    const finish = (
      j: { id: string; lease: string },
      outcome = 'accepted',
      clock = new Date().toISOString(),
    ) =>
      db.query('select public.finish_email_delivery($1,$2,$3,$4,$5,$6)', [
        j.id,
        j.lease,
        outcome,
        outcome === 'accepted' ? 'provider-id' : null,
        outcome === 'retry' ? 'network_outcome_unknown' : null,
        clock,
      ]);
    async function newNotice(title: string) {
      await asUser(B);
      const due = new Date(Date.parse(day + 'T00:00:00Z') + 7 * 86400000)
        .toISOString()
        .slice(0, 10);
      const t = (
        await db.query<{ id: string }>(
          'insert into public.tasks(workspace_id,title,due_date)values($1,$2,$3)returning id',
          [w, title, due],
        )
      ).rows[0].id;
      await service();
      await queue();
      return t;
    }
    beforeAll(async () => {
      db = database();
      await db.exec('reset role');
      await db.query(
        "insert into auth.users(id,email,email_confirmed_at)values($1,'owner-a@example.test',now()),($2,'owner-b@example.test',now()),($3,'unverified@example.test',null)",
        [A, B, C],
      );
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Email workspace','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query('insert into public.tasks(workspace_id,title,due_date)values($1,$2,$3)', [
        w,
        'Other owner private task sentinel',
        day,
      ]);
      const a = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Other owner USD','USD')returning id",
          [w],
        )
      ).rows[0].id;
      const past = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      await db.query(
        "select public.record_transaction($1,$2,'Other owner secret',77777,'income','Other',$3)",
        [w, a, past],
      );
      await asUser(B);
      other = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Separate email workspace','personal') id",
        )
      ).rows[0].id;
      await db.query(
        'insert into public.tasks(workspace_id,title,due_date)values($1,$2,$3),($4,$5,$3)',
        [w, 'My open task', day, other, 'Separate workspace sentinel'],
      );
      await db.query(
        "insert into public.calendar_events(workspace_id,title,starts_at,ends_at)values($1,'My appointment',$2::date+interval '9 hours',$2::date+interval '10 hours')",
        [w, day],
      );
      const account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'My USD','USD')returning id",
          [w],
        )
      ).rows[0].id;
      await db.query(
        "select public.record_transaction($1,$2,'My income',12.34,'income','Other',$3)",
        [w, account, past],
      );
      await db.query(
        "select public.record_transaction($1,$2,'My expense',5.10,'expense','Other',$3)",
        [w, account, past],
      );
      await db.query("select public.save_reminder_preferences(true,false,false,30,3,30,0,'UTC')");
    });
    it('defaults off and requires a configured sender plus verified recipient for new opt-ins', async () => {
      await service();
      expect((await queue()).rows[0].n).toBe(0);
      await asUser(B);
      await expect(save(0)).rejects.toThrow(/Verified email/);
      await service();
      await db.query('select public.set_email_delivery_ready(true)');
      await asUser(C);
      await expect(save(0)).rejects.toThrow(/Verified email/);
      await asUser(B);
      await expect(save(0, true, true, true, 'weekly', 0, 'No/SuchZone')).rejects.toThrow(
        /schedule/,
      );
      const p = await save(0);
      expect(p.owner_id).toBe(B);
      expect((await save(0)).revision).toBe(p.revision);
      await expect(save(0, false)).rejects.toThrow(/changed/);
    });
    it('protects preferences, private payloads, recipient/lease columns and service-only RPCs from other users and anonymous clients', async () => {
      await asUser(A);
      expect(
        (await db.query('select * from public.email_preferences where owner_id=$1', [B])).rows,
      ).toEqual([]);
      await asUser(B);
      await expect(
        db.query('update public.email_preferences set daily_digest=false where owner_id=$1', [B]),
      ).rejects.toThrow(/permission/);
      await expect(queue()).rejects.toThrow(/permission/);
      await expect(claim()).rejects.toThrow(/permission/);
      await expect(db.query('select lease_id from public.email_deliveries')).rejects.toThrow(
        /permission/,
      );
      await expect(db.query('select * from private.email_payloads')).rejects.toThrow(/permission/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.email_preferences')).rejects.toThrow(
        /permission/,
      );
      await expect(db.query('select public.email_delivery_available()')).rejects.toThrow(
        /permission/,
      );
    });
    it('queues once per workspace/period and produces owner-only plain-text digests and separate currency finance totals', async () => {
      await service();
      expect((await queue()).rows[0].n).toBe(8);
      expect((await queue()).rows[0].n).toBe(0);
      const jobs = [];
      for (let i = 0; i < 10; i++) {
        const j = await claim();
        if (!j) break;
        jobs.push(j);
        await finish(j);
      }
      expect(jobs).toHaveLength(8);
      for (const j of jobs) {
        expect(j.payload.to).toEqual(['owner-b@example.test']);
        expect(j.payload.text).not.toContain('Other owner');
        expect(j.payload.text).not.toContain('77777');
      }
      const ownDaily = jobs.find(
        (j) =>
          j.payload.subject === 'LifeOS daily overview' &&
          j.payload.text.startsWith('LifeOS - Email workspace'),
      )!;
      expect(ownDaily.payload.text).toContain('My open task');
      expect(ownDaily.payload.text).toContain('My appointment');
      expect(ownDaily.payload.text).not.toContain('Separate workspace sentinel');
      const financial = jobs.find(
        (j) =>
          j.payload.subject === 'LifeOS financial summary' &&
          j.payload.text.startsWith('LifeOS - Email workspace'),
      )!;
      expect(financial.payload.text).toContain('USD: income 12.34, expenses 5.10, net 7.24');
      await asUser(A);
      expect(
        (await db.query('select id from public.email_deliveries where workspace_id=$1', [w])).rows,
      ).toEqual([]);
    });
    it('leases work once, freezes retry payloads and ignores stale completion tokens', async () => {
      const task = await newNotice('Retry task');
      const first = (await claim())!;
      expect(await claim()).toBeNull();
      await asUser(B);
      await db.query("update public.tasks set title='Edited after first send' where id=$1", [task]);
      await service();
      const later = new Date(Date.now() + 6 * 60000).toISOString(),
        retry = (await claim(later, 'new-sender@example.test'))!;
      expect(retry.id).toBe(first.id);
      expect(retry.lease).not.toBe(first.lease);
      expect(retry.payload).toEqual(first.payload);
      await finish(first);
      expect(
        (
          await inspect<{ status: string }>(
            'select status from public.email_deliveries where id=$1',
            [first.id],
          )
        ).rows[0].status,
      ).toBe('sending');
      await finish(retry, 'accepted', later);
    });
    it('honors snoozes and source completion before sending', async () => {
      const task = await newNotice('Snoozed task');
      await asUser(B);
      const n = (
        await db.query<{ id: string }>('select id from public.notifications where source_id=$1', [
          task,
        ])
      ).rows[0].id;
      await db.query("select public.act_on_notification($1,'snooze',60)", [n]);
      await service();
      expect(await claim()).toBeNull();
      expect(
        (
          await inspect<{ status: string }>(
            'select status from public.email_deliveries where notification_id=$1',
            [n],
          )
        ).rows[0].status,
      ).toBe('queued');
      await asUser(B);
      await db.query("select public.set_task_status($1,1,'done')", [task]);
      await service();
      expect(await claim()).toBeNull();
      expect(
        (
          await inspect<{ status: string }>(
            'select status from public.email_deliveries where notification_id=$1',
            [n],
          )
        ).rows[0].status,
      ).toBe('cancelled');
    });
    it('stops ambiguous retries before provider idempotency expires', async () => {
      await newNotice('Retry cutoff task');
      const j = (await claim())!;
      await finish(j, 'retry');
      await claim(new Date(Date.now() + 23 * 3600000).toISOString());
      expect(
        (
          await inspect<{ status: string; error_code: string }>(
            'select status,error_code from public.email_deliveries where id=$1',
            [j.id],
          )
        ).rows[0],
      ).toMatchObject({ status: 'uncertain', error_code: 'stale_or_retry_window_expired' });
      await newNotice('Final attempt crash');
      const last = (await claim())!;
      await db.exec('reset role');
      await db.query(
        "update public.email_deliveries set attempts=5,lease_until=now()-interval '1 minute' where id=$1",
        [last.id],
      );
      await service();
      expect(await claim()).toBeNull();
      expect(
        (
          await inspect<{ status: string; error_code: string }>(
            'select status,error_code from public.email_deliveries where id=$1',
            [last.id],
          )
        ).rows[0],
      ).toMatchObject({ status: 'uncertain', error_code: 'retry_limit_reached' });
    });
    it('cancels queued opt-outs even while the provider is unavailable, and rejects changed verified recipients', async () => {
      await newNotice('Recipient change task');
      const j = (await claim())!;
      await finish(j, 'retry');
      await db.exec('reset role');
      await db.query("update auth.users set email='changed@example.test' where id=$1", [B]);
      await service();
      await claim(new Date(Date.now() + 2 * 60000).toISOString());
      expect(
        (
          await inspect<{ status: string }>(
            'select status from public.email_deliveries where id=$1',
            [j.id],
          )
        ).rows[0].status,
      ).toBe('uncertain');
      await db.exec('reset role');
      await db.query("update auth.users set email='owner-b@example.test' where id=$1", [B]);
      await newNotice('Opt out task');
      await db.query('select public.set_email_delivery_ready(false)');
      await asUser(B);
      const p = (
        await db.query<{ revision: number }>(
          'select revision from public.email_preferences where owner_id=$1',
          [B],
        )
      ).rows[0];
      await save(p.revision, false, true, true, 'weekly');
      await service();
      await db.query('select public.set_email_delivery_ready(true)');
      expect(await claim()).toBeNull();
    });
    it('revokes history and queued deliveries when workspace membership is removed', async () => {
      await asUser(B);
      const p = (
        await db.query<{ revision: number }>(
          'select revision from public.email_preferences where owner_id=$1',
          [B],
        )
      ).rows[0];
      await save(p.revision);
      await newNotice('Revoked workspace task');
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.email_deliveries where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      await service();
      expect(await claim()).toBeNull();
      await asUser(A);
    });
    it('uses the configured local hour/month boundary and excludes pre-opt-in notification history', async () => {
      await db.exec('reset role');
      await db.query('update auth.users set email_confirmed_at=now() where id=$1', [C]);
      await asUser(C);
      const cw = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Monthly timezone review','personal') id",
        )
      ).rows[0].id;
      await db.query('insert into public.tasks(workspace_id,title,due_date)values($1,$2,$3)', [
        cw,
        'Existing notice before opt-in',
        day,
      ]);
      await db.query("select public.save_reminder_preferences(true,false,false,0,3,30,0,'UTC')");
      await service();
      await db.query('select public.deliver_due_reminders()');
      await asUser(C);
      await save(0, true, false, false, 'monthly', 15, 'Pacific/Kiritimati');
      await service();
      await db.query("select public.queue_email_deliveries('2027-02-01T00:30:00Z')");
      expect(
        (
          await inspect<{ n: number }>(
            'select count(*)::int n from public.email_deliveries where owner_id=$1',
            [C],
          )
        ).rows[0].n,
      ).toBe(0);
      await db.query("select public.queue_email_deliveries('2027-02-01T01:30:00Z')");
      const rows = (
        await inspect<{ kind: string; period_key: string; body: string }>(
          "select kind,period_key,private.email_text(d,'2027-02-01T01:30:00Z') body from public.email_deliveries d where owner_id=$1",
          [C],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'financial', period_key: 'monthly:2027-02-01' });
      expect(rows[0].body).toContain('2027-01-01 to 2027-01-31');
      await asUser(A);
    });
  });
}
