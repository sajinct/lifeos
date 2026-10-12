import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function reportSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
) {
  describe('Durable subscription expense attribution', () => {
    let db: PGlite, w: string, account: string, today: string, sub: string, plan: string;
    async function save(
      id: string,
      revision: string | null,
      mode: string,
      schedule: string | null = null,
    ) {
      await db.query(
        'select public.save_subscription($1,$2,$3,$4,10,$5,$6,$7,null,$8,$9,$10,$11,$12,$13,$14,false)',
        [
          id,
          w,
          revision,
          'Synthetic report subscription',
          'INR',
          'monthly',
          today,
          'active',
          'Subscriptions',
          '',
          '',
          mode,
          account,
          schedule,
        ],
      );
    }
    async function revision() {
      return (
        await db.query<{ revision: string }>(
          'select updated_at::text as revision from public.subscriptions where id=$1',
          [sub],
        )
      ).rows[0].revision;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (await db.query<{ id: string }>("select public.create_workspace('Report tests') as id"))
        .rows[0].id;
      account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name) values($1,'Report cash') returning id",
          [w],
        )
      ).rows[0].id;
      today = (
        await db.query<{ day: string }>(
          "select (now() at time zone 'Asia/Kolkata')::date::text as day",
        )
      ).rows[0].day;
      sub = randomUUID();
      await save(sub, null, 'create');
      plan = (
        await db.query<{ id: string }>(
          'select recurring_id as id from public.subscriptions where id=$1',
          [sub],
        )
      ).rows[0].id;
    });
    it('tags new posted expenses with the owned subscription and denies browser retagging', async () => {
      await db.query('select public.post_recurring_due($1)', [plan]);
      const row = (
        await db.query<{ subscription_id: string; amount: string }>(
          'select subscription_id,amount from public.transactions where recurring_id=$1',
          [plan],
        )
      ).rows[0];
      expect(row.subscription_id).toBe(sub);
      expect(Number(row.amount)).toBe(10);
      await expect(
        db.query('update public.transactions set subscription_id=null where recurring_id=$1', [
          plan,
        ]),
      ).rejects.toThrow(/permission denied/);
    });
    it('retains expense classification when disconnecting and reusing a schedule', async () => {
      await save(sub, await revision(), 'track');
      const second = randomUUID();
      await save(second, null, 'existing', plan);
      expect(
        (
          await db.query<{ subscription_id: string }>(
            'select subscription_id from public.transactions where recurring_id=$1',
            [plan],
          )
        ).rows[0].subscription_id,
      ).toBe(sub);
      await db.query('select public.cancel_subscription($1)', [second]);
      expect(
        (
          await db.query<{ subscription_id: string }>(
            'select subscription_id from public.transactions where recurring_id=$1',
            [plan],
          )
        ).rows[0].subscription_id,
      ).toBe(sub);
    });
    it('attributes already posted unclassified expense history when an existing plan is linked', async () => {
      const p = (
        await db.query<{ id: string }>(
          "insert into public.recurring_transactions(workspace_id,account_id,title,amount,kind,category,start_on,next_on,frequency) values($1,$2,'Existing service',15,'expense','Subscriptions',$3,$3,'monthly') returning id",
          [w, account, today],
        )
      ).rows[0].id;
      await db.query('select public.post_recurring_due($1)', [p]);
      expect(
        (
          await db.query<{ subscription_id: string | null }>(
            'select subscription_id from public.transactions where recurring_id=$1',
            [p],
          )
        ).rows[0].subscription_id,
      ).toBeNull();
      const s = randomUUID();
      await save(s, null, 'existing', p);
      expect(
        (
          await db.query<{ subscription_id: string }>(
            'select subscription_id from public.transactions where recurring_id=$1',
            [p],
          )
        ).rows[0].subscription_id,
      ).toBe(s);
    });
    it('keeps subscription labels and transaction amounts private to their owner', async () => {
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(
        (
          await db.query('select subscription_id from public.transactions where workspace_id=$1', [
            w,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select title from public.subscriptions where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await asUser(A);
    });
  });
}
