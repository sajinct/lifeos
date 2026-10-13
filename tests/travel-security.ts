import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function travelSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private trip/event planning and immutable finance links', () => {
    let db: PGlite, w: string, other: string, p: string, q: string, expense: string, income: string;
    const details = () => ({
      kind: 'trip',
      title: 'Synthetic trip',
      location: 'Example destination',
      starts_on: '2026-11-01',
      ends_on: '2026-11-05',
      timezone: 'Asia/Kolkata',
      status: 'planning',
      notes: 'Synthetic only',
    });
    const fields = (kind = 'itinerary') => ({
      kind,
      title: 'Synthetic item',
      date_on: ['itinerary', 'booking'].includes(kind) ? '2026-11-01' : null,
      end_on: null,
      time_at: '',
      end_time: '',
      location: '',
      reference: '',
      cost: null,
      currency: '',
      email: '',
      phone: '',
      guest_count: kind === 'guest' ? 1 : null,
      status:
        kind === 'guest'
          ? 'invited'
          : kind === 'booking'
            ? 'planned'
            : kind === 'checklist'
              ? 'todo'
              : 'scheduled',
      notes: '',
    });
    async function plan(
      id = randomUUID(),
      rev: number | null = null,
      patch: Record<string, unknown> = {},
      workspace = w,
    ) {
      await db.query('select public.save_travel_plan($1,$2,$3,$4::jsonb)', [
        id,
        workspace,
        rev,
        JSON.stringify({ ...details(), ...patch }),
      ]);
      return id;
    }
    async function entry(
      kind = 'itinerary',
      id = randomUUID(),
      rev: number | null = null,
      patch: Record<string, unknown> = {},
      parent = p,
    ) {
      await db.query('select public.save_travel_entry($1,$2,$3,$4,$5::jsonb)', [
        id,
        w,
        rev,
        parent,
        JSON.stringify({ ...fields(kind), ...patch }),
      ]);
      return id;
    }
    async function budget(
      id = randomUUID(),
      rev: number | null = null,
      currency = 'INR',
      amount: number | string = 10000,
      parent = p,
    ) {
      await db.query('select public.save_travel_budget($1,$2,$3,$4,$5,$6)', [
        id,
        w,
        rev,
        parent,
        currency,
        amount,
      ]);
      return id;
    }
    async function link(id = randomUUID(), rev: number | null = null, tx = expense, parent = p) {
      await db.query('select public.save_travel_expense($1,$2,$3,$4,$5,$6)', [
        id,
        w,
        rev,
        parent,
        tx,
        'Synthetic',
      ]);
      return id;
    }
    async function act(id: string, kind: string, rev: number, action: string) {
      await db.query('select public.act_on_travel_record($1,$2,$3,$4)', [id, kind, rev, action]);
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Travel tests','family')as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      p = await plan();
      q = await plan(randomUUID(), null, { kind: 'event', title: 'Synthetic event' });
      const account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Travel costs','INR')returning id",
          [w],
        )
      ).rows[0].id;
      expense = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Synthetic travel expense',1500,'expense','Travel',current_date)as id",
          [w, account],
        )
      ).rows[0].id;
      income = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Income',1500,'income','Other',current_date)as id",
          [w, account],
        )
      ).rows[0].id;
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other travel')as id")
      ).rows[0].id;
      await asUser(A);
    });
    it('denies direct writes, validates plan data and protects creation retries/revisions', async () => {
      for (const table of ['travel_plans', 'travel_entries', 'travel_budgets', 'travel_expenses'])
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
      for (const patch of [
        { title: '' },
        { starts_on: '2026-02-30' },
        { ends_on: '2026-10-01' },
        { timezone: 'Unknown/Zone' },
        { status: 'shared' },
        { notes: 'x'.repeat(4001) },
      ])
        await expect(plan(randomUUID(), null, patch)).rejects.toThrow();
      await plan(p, null, { title: 'Ignored' });
      await plan(p, 1);
      await expect(plan(p, 1)).rejects.toThrow(/changed/);
      await expect(plan(p, 2, { kind: 'event' })).rejects.toThrow();
    });
    it('validates itinerary/booking date and time order and booking cent precision', async () => {
      for (const patch of [
        { date_on: '2026-10-31' },
        { date_on: '2026-11-06' },
        { date_on: '2026-11-02', end_on: '2026-11-01' },
        { time_at: '24:00' },
        { time_at: '12:00', end_time: '11:00' },
        { end_time: '11:00' },
        { email: 'x@example.com' },
      ])
        await expect(entry('itinerary', randomUUID(), null, patch)).rejects.toThrow();
      for (const cost of ['NaN', 'Infinity', -1, 1.001, 1000000000000])
        await expect(
          entry('booking', randomUUID(), null, { cost, currency: 'INR' }),
        ).rejects.toThrow();
      const id = await entry('booking', randomUUID(), null, {
        cost: 0,
        currency: 'INR',
        status: 'confirmed',
        reference: 'ABC',
      });
      await entry('booking', id, null, { title: 'Ignored' });
      expect(
        (await db.query('select cost,revision from public.travel_entries where id=$1', [id]))
          .rows[0],
      ).toEqual({ cost: '0.00', revision: 1 });
    });
    it('keeps dates around archived itinerary rows and fixes child plan/type bindings', async () => {
      const id = await entry();
      await act(id, 'entry', 1, 'archive');
      await expect(plan(p, 2, { starts_on: '2026-11-02' })).rejects.toThrow(/saved itinerary/);
      await expect(entry('itinerary', id, 2, {}, q)).rejects.toThrow(/inaccessible/);
      await expect(entry('guest', id, 2)).rejects.toThrow(/restore|details/);
      await act(id, 'entry', 2, 'restore');
    });
    it('records guest RSVP/party size without exposing contacts or accepting invalid fields', async () => {
      for (const patch of [
        { guest_count: 0 },
        { guest_count: 100001 },
        { email: 'bad' },
        { date_on: '2026-11-01' },
        { cost: 100, currency: 'INR' },
        { status: 'done' },
      ])
        await expect(entry('guest', randomUUID(), null, patch)).rejects.toThrow();
      const id = await entry('guest', randomUUID(), null, {
        guest_count: 2,
        email: 'synthetic@example.com',
        status: 'accepted',
      });
      await expect(act(id, 'entry', 1, 'complete')).rejects.toThrow(/Completion/);
      expect(
        (await db.query('select guest_count,status from public.travel_entries where id=$1', [id]))
          .rows[0],
      ).toEqual({ guest_count: 2, status: 'accepted' });
    });
    it('handles checklist completion/replay/stale reopening and retains completion through archives', async () => {
      const id = await entry('checklist');
      await act(id, 'entry', 1, 'complete');
      await act(id, 'entry', 1, 'complete');
      await expect(act(id, 'entry', 1, 'reopen')).rejects.toThrow(/changed/);
      await act(id, 'entry', 2, 'archive');
      await act(id, 'entry', 3, 'restore');
      expect(
        (
          await db.query('select status,archived,revision from public.travel_entries where id=$1', [
            id,
          ])
        ).rows[0],
      ).toEqual({ status: 'done', archived: false, revision: 4 });
    });
    it('keeps budget currencies immutable and archives/restores each unique currency plan', async () => {
      for (const amount of [0, -1, 1.001, 'NaN'])
        await expect(budget(randomUUID(), null, 'INR', amount)).rejects.toThrow();
      const id = await budget();
      await budget(id);
      await expect(budget()).rejects.toThrow(/exists/);
      await expect(budget(id, 1, 'USD')).rejects.toThrow(/immutable/);
      await budget(id, 1, 'INR', 20000);
      await expect(act(id, 'budget', 1, 'archive')).rejects.toThrow(/changed/);
      await act(id, 'budget', 2, 'archive');
      await act(id, 'budget', 3, 'restore');
      await budget(randomUUID(), null, 'USD', 500);
    });
    it('links only owned expenses without ledger changes and prevents duplicate active attribution', async () => {
      const before = (
          await db.query(
            'select amount,kind,account_id,project_id from public.transactions where id=$1',
            [expense],
          )
        ).rows[0],
        id = await link();
      await link(id);
      await expect(link(randomUUID(), null, expense, q)).rejects.toThrow(/already linked/);
      await expect(link(randomUUID(), null, income)).rejects.toThrow(/recorded expense/);
      await act(id, 'expense', 1, 'archive');
      const moved = await link(randomUUID(), null, expense, q);
      await expect(act(id, 'expense', 2, 'restore')).rejects.toThrow(/active under/);
      await act(moved, 'expense', 1, 'archive');
      await act(id, 'expense', 2, 'restore');
      expect(
        (
          await db.query(
            'select amount,kind,account_id,project_id from public.transactions where id=$1',
            [expense],
          )
        ).rows[0],
      ).toEqual(before);
    });
    it('freezes planning details for closed/archived plans while preserving financial history', async () => {
      await plan(p, 2, { status: 'completed' });
      await expect(entry()).rejects.toThrow(/Reopen/);
      await budget(randomUUID(), null, 'EUR', 200);
      await act(p, 'plan', 3, 'archive');
      await act(p, 'plan', 3, 'archive');
      await expect(budget(randomUUID(), null, 'GBP', 100)).rejects.toThrow(/Restore/);
      await act(p, 'plan', 4, 'restore');
      expect(
        (await db.query('select status,archived from public.travel_plans where id=$1', [p]))
          .rows[0],
      ).toEqual({ status: 'completed', archived: false });
      await plan(p, 5);
    });
    it('hides all planning rows from members/owners and blocks viewers, cross-workspace and revoked access', async () => {
      await expect(plan(randomUUID(), null, {}, other)).rejects.toThrow(/write/);
      await asUser(B);
      for (const table of ['travel_plans', 'travel_entries', 'travel_budgets', 'travel_expenses'])
        expect(
          (await db.query(`select id from public.${table} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(entry()).rejects.toThrow(/owner/);
      const owned = await plan();
      await asUser(A);
      expect(
        (await db.query('select id from public.travel_plans where id=$1', [owned])).rows,
      ).toHaveLength(0);
      await expect(act(owned, 'plan', 1, 'archive')).rejects.toThrow(/owner/);
      await asUser(C);
      await expect(plan()).rejects.toThrow(/write/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.travel_plans where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(plan()).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.travel_plans')).rejects.toThrow(
        /permission denied/,
      );
      await expect(plan()).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
