import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function subscriptionSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private subscriptions and recurring expense boundaries', () => {
    let db: PGlite,
      w: string,
      other: string,
      account: string,
      today: string,
      linked: string,
      trial: string,
      track: string;
    type Row = {
      id: string;
      updated_at: string;
      recurring_id: string | null;
      next_on: string;
      renewal_count: number;
      status: string;
      title: string;
      amount: string;
      currency: string;
    };
    type Input = {
      id?: string;
      workspace?: string;
      revision?: string | null;
      mode?: string;
      price?: number;
      currency?: string;
      date?: string;
      trialEnd?: string | null;
      status?: string;
      schedule?: string | null;
      expenseAccount?: string;
      automatic?: boolean;
      frequency?: string;
      url?: string;
    };
    async function row(id: string) {
      return (
        await db.query<Row>(
          'select id,updated_at::text,recurring_id,next_on::text,renewal_count,status,title,amount,currency from public.subscriptions where id=$1',
          [id],
        )
      ).rows[0];
    }
    async function save(v: Input = {}) {
      const id = v.id ?? randomUUID();
      await db.query(
        'select public.save_subscription($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
        [
          id,
          v.workspace ?? w,
          v.revision ?? null,
          'Synthetic membership',
          v.price ?? 12,
          v.currency ?? 'INR',
          v.frequency ?? 'monthly',
          v.date ?? today,
          v.trialEnd ?? null,
          v.status ?? 'active',
          'Subscriptions',
          v.url ?? '',
          'Synthetic test only',
          v.mode ?? 'track',
          v.expenseAccount ?? account,
          v.schedule ?? null,
          v.automatic ?? false,
        ],
      );
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>("select public.create_workspace('Subscription tests') as id")
      ).rows[0].id;
      account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name) values($1,'Synthetic account') returning id",
          [w],
        )
      ).rows[0].id;
      today = (
        await db.query<{ day: string }>(
          "select (now() at time zone 'Asia/Kolkata')::date::text as day",
        )
      ).rows[0].day;
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      other = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Unrelated subscriptions') as id",
        )
      ).rows[0].id;
      await asUser(A);
    });
    it('requires owner RPCs, validates money and URLs, and permits zero-cost tracking', async () => {
      await asUser(A);
      await expect(
        db.query(
          "insert into public.subscriptions(id,workspace_id,owner_id,title,amount,currency,frequency,anchor_on,next_on,status) values($1,$2,$3,'Bypass',1,'INR','monthly',current_date,current_date,'active')",
          [randomUUID(), w, A],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(save({ price: 1.234 })).rejects.toThrow(/price/);
      await expect(save({ url: 'javascript:alert(1)' })).rejects.toThrow(/HTTPS/);
      await expect(save({ url: 'https://user:password@example.com' })).rejects.toThrow(
        /credentials/,
      );
      track = await save({ price: 0 });
      expect(Number((await row(track)).amount)).toBe(0);
    });
    it('creates one schedule per request and rejects account/currency mismatches', async () => {
      await asUser(A);
      await expect(save({ mode: 'create', currency: 'USD' })).rejects.toThrow(/account/);
      await expect(save({ mode: 'create', price: 0 })).rejects.toThrow(/positive/);
      linked = await save({ mode: 'create', automatic: true });
      const first = await row(linked);
      await save({ id: linked, mode: 'create', automatic: true });
      expect((await row(linked)).recurring_id).toBe(first.recurring_id);
      expect(
        (await db.query('select id from public.recurring_transactions where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(1);
    });
    it('blocks viewer writes, another owner’s ID upserts, and cross-workspace schedule links', async () => {
      await asUser(B);
      expect(
        (await db.query('select id from public.subscriptions where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(save({ workspace: w })).rejects.toThrow(/write access/);
      await expect(save({ id: linked, workspace: other })).rejects.toThrow(/inaccessible/);
      await expect(db.query('select public.cancel_subscription($1)', [linked])).rejects.toThrow(
        /owner/,
      );
      await asUser(A);
      await expect(
        db.query("update public.subscriptions set status='cancelled' where id=$1", [linked]),
      ).rejects.toThrow(/permission denied/);
      expect((await row(linked)).status).toBe('active');
    });
    it('posts once through the linked schedule and synchronizes the next renewal cursor', async () => {
      await asUser(A);
      const s = await row(linked);
      expect(
        Number(
          (
            await db.query<{ n: number }>('select public.post_recurring_due($1) as n', [
              s.recurring_id,
            ])
          ).rows[0].n,
        ),
      ).toBe(1);
      expect(
        Number(
          (
            await db.query<{ n: number }>('select public.post_recurring_due($1) as n', [
              s.recurring_id,
            ])
          ).rows[0].n,
        ),
      ).toBe(0);
      const updated = await row(linked);
      expect(updated.renewal_count).toBe(1);
      expect(updated.next_on > today).toBe(true);
      const r = (
        await db.query<{ next_on: string }>(
          'select next_on::text from public.recurring_transactions where id=$1',
          [s.recurring_id],
        )
      ).rows[0];
      expect(updated.next_on).toBe(r.next_on);
      expect(
        (
          await db.query('select id from public.transactions where recurring_id=$1', [
            s.recurring_id,
          ])
        ).rows,
      ).toHaveLength(1);
    });
    it('cancels atomically, preserves posted history and prevents later recording/resume', async () => {
      await asUser(A);
      const s = await row(linked);
      await db.query('select public.cancel_subscription($1)', [linked]);
      await db.query('select public.cancel_subscription($1)', [linked]);
      expect((await row(linked)).status).toBe('cancelled');
      expect(
        (
          await db.query<{ active: boolean; automatic: boolean }>(
            'select active,automatic from public.recurring_transactions where id=$1',
            [s.recurring_id],
          )
        ).rows[0],
      ).toEqual({ active: false, automatic: false });
      await expect(
        db.query('update public.recurring_transactions set active=true where id=$1', [
          s.recurring_id,
        ]),
      ).rejects.toThrow(/cancelled/);
      expect(
        Number(
          (
            await db.query<{ n: number }>('select public.post_recurring_due($1) as n', [
              s.recurring_id,
            ])
          ).rows[0].n,
        ),
      ).toBe(0);
      expect(
        (
          await db.query('select id from public.transactions where recurring_id=$1', [
            s.recurring_id,
          ])
        ).rows,
      ).toHaveLength(1);
    });
    it('keeps trial schedules paused and prevents history backfill from new expense links', async () => {
      await asUser(A);
      const yesterday = (
        await db.query<{ day: string }>('select ($1::date-1)::text as day', [today])
      ).rows[0].day;
      await expect(save({ mode: 'create', date: yesterday })).rejects.toThrow(/today or later/);
      const end = (await db.query<{ day: string }>('select ($1::date+3)::text as day', [today]))
        .rows[0].day;
      trial = await save({
        mode: 'create',
        status: 'trial',
        date: end,
        trialEnd: end,
        automatic: true,
      });
      const s = await row(trial);
      expect(
        (
          await db.query<{ active: boolean; automatic: boolean }>(
            'select active,automatic from public.recurring_transactions where id=$1',
            [s.recurring_id],
          )
        ).rows[0],
      ).toEqual({ active: false, automatic: false });
      await expect(
        db.query('update public.recurring_transactions set automatic=true where id=$1', [
          s.recurring_id,
        ]),
      ).rejects.toThrow(/Trial/);
      expect(
        Number(
          (
            await db.query<{ n: number }>('select public.post_recurring_due($1) as n', [
              s.recurring_id,
            ])
          ).rows[0].n,
        ),
      ).toBe(0);
    });
    it('delivers separate trial/renewal events, clears old alerts, and preserves new prefs through the old RPC', async () => {
      await asUser(A);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',true,90)",
      );
      await db.query("select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC')");
      expect(
        (
          await db.query<{ subscription_reminders: boolean }>(
            'select subscription_reminders from public.app_settings',
          )
        ).rows[0].subscription_reminders,
      ).toBe(true);
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query(
            "select id from public.notifications where source_id=$1 and source_kind='trial'",
            [trial],
          )
        ).rows,
      ).toHaveLength(1);
      await asUser(A);
      const old = await row(trial);
      await save({
        id: trial,
        revision: old.updated_at,
        mode: 'create',
        date: old.next_on,
        status: 'active',
      });
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query(
            "select id from public.notifications where source_id=$1 and source_kind='trial' and dismissed_at is null",
            [trial],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "select id from public.notifications where source_id=$1 and source_kind='subscription' and dismissed_at is null",
            [trial],
          )
        ).rows,
      ).toHaveLength(1);
      await asUser(A);
    });
    it('rejects stale edits and advances tracking-only dates without duplicate acknowledgements', async () => {
      await asUser(A);
      const s = await row(track);
      await save({ id: track, revision: s.updated_at, price: 20 });
      await expect(save({ id: track, revision: s.updated_at, price: 30 })).rejects.toThrow(
        /changed/,
      );
      const current = await row(track);
      await db.query('select public.advance_subscription($1,$2)', [track, current.next_on]);
      await db.query('select public.advance_subscription($1,$2)', [track, current.next_on]);
      expect((await row(track)).renewal_count).toBe(1);
      expect(
        (
          await db.query(
            'select id from public.transactions where workspace_id=$1 and recurring_id is null',
            [w],
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('allows one owned existing schedule, enforces authoritative price, and pauses it on disconnect', async () => {
      await asUser(A);
      const r = (
        await db.query<{ id: string }>(
          "insert into public.recurring_transactions(workspace_id,account_id,title,amount,kind,frequency,start_on,next_on) values($1,$2,'Existing membership',99,'expense','yearly',$3,$3) returning id",
          [w, account, today],
        )
      ).rows[0].id;
      const id = await save({ mode: 'existing', schedule: r, price: 1 });
      expect(Number((await row(id)).amount)).toBe(99);
      await expect(save({ mode: 'existing', schedule: r })).rejects.toThrow(/already belongs/);
      const s = await row(id);
      await save({ id, revision: s.updated_at, mode: 'track' });
      expect((await row(id)).recurring_id).toBeNull();
      expect(
        (
          await db.query<{ active: boolean }>(
            'select active from public.recurring_transactions where id=$1',
            [r],
          )
        ).rows[0].active,
      ).toBe(false);
    });
    it('keeps member subscriptions private from workspace owners and revokes access on removal', async () => {
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, C]);
      await asUser(C);
      const id = await save({ mode: 'track' });
      await asUser(A);
      expect(
        (await db.query('select id from public.subscriptions where id=$1', [id])).rows,
      ).toHaveLength(0);
      await expect(db.query('select public.cancel_subscription($1)', [id])).rejects.toThrow(
        /owner/,
      );
      await db.query('select public.remove_workspace_member($1,$2)', [w, C]);
      await asUser(C);
      expect(
        (await db.query('select id from public.subscriptions where id=$1', [id])).rows,
      ).toHaveLength(0);
      await expect(save({ id, revision: '2020-01-01T00:00:00Z' })).rejects.toThrow(/write access/);
    });
    it('rejects links to accounts and schedules in another owned workspace', async () => {
      await asUser(A);
      const foreign = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Different owned workspace') as id",
        )
      ).rows[0].id;
      const a = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name) values($1,'Foreign account') returning id",
          [foreign],
        )
      ).rows[0].id;
      const r = (
        await db.query<{ id: string }>(
          "insert into public.recurring_transactions(workspace_id,account_id,title,amount,kind,frequency,start_on,next_on) values($1,$2,'Foreign plan',10,'expense','monthly',$3,$3) returning id",
          [foreign, a, today],
        )
      ).rows[0].id;
      await expect(save({ mode: 'existing', schedule: r })).rejects.toThrow(
        /own monthly or yearly/,
      );
      await expect(save({ mode: 'create', expenseAccount: a })).rejects.toThrow(/own account/);
    });
  });
}
