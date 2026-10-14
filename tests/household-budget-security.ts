import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function householdBudgetSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Household budget publication and private source expenses', () => {
    let db: PGlite,
      w: string,
      budget: string,
      spending: string,
      aExpense: string,
      bExpense: string,
      aAccount: string,
      bAccount: string;
    type Budget = {
      id: string;
      revision: number;
      visibility: string;
      amount: number;
      archived: boolean;
    };
    type Spending = {
      id: string;
      revision: number;
      amount: number;
      withdrawn: boolean;
      owner_id: string;
      currency: string;
    };
    async function b(id = budget) {
      return (await db.query<Budget>('select * from public.household_budgets where id=$1', [id]))
        .rows[0];
    }
    async function s(id = spending) {
      return (await db.query<Spending>('select * from public.household_spending where id=$1', [id]))
        .rows[0];
    }
    async function save(
      id = randomUUID(),
      revision: number | null = null,
      changes: Record<string, unknown> = {},
      request = randomUUID(),
    ) {
      const v = {
        category: 'Groceries',
        month: '2026-01-01',
        currency: 'INR',
        amount: 100,
        notes: 'Literal <script>notes</script>',
        sharing: 'private',
        ...changes,
      };
      await db.query('select public.save_household_budget($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        request,
        id,
        w,
        revision,
        v.category,
        v.month,
        v.currency,
        v.amount,
        v.notes,
        v.sharing,
      ]);
      return { id, request };
    }
    async function publish(
      id = randomUUID(),
      parent = budget,
      expense = aExpense,
      revision: number | null = null,
      parentRevision?: number,
      request = randomUUID(),
      notes = 'Explicit shared note',
    ) {
      const pr = parentRevision ?? (await b(parent)).revision;
      await db.query('select public.save_household_spending($1,$2,$3,$4,$5,$6,$7)', [
        request,
        id,
        parent,
        revision,
        pr,
        expense,
        notes,
      ]);
      return { id, request, pr };
    }
    async function withdraw(id = spending, revision?: number, request = randomUUID()) {
      const rev = revision ?? (await s(id)).revision;
      await db.query('select public.withdraw_household_spending($1,$2,$3)', [request, id, rev]);
      return { request, rev };
    }
    async function archive(id = budget, value = true, revision?: number, request = randomUUID()) {
      await db.query('select public.set_household_budget_archive($1,$2,$3,$4)', [
        request,
        id,
        revision ?? (await b(id)).revision,
        value,
      ]);
    }
    async function expense(account: string, amount = 80, date = '2026-01-15', kind = 'expense') {
      return (
        await db.query<{ id: string }>(
          'select public.record_transaction($1,$2,$3,$4,$5,$6,$7) id',
          [w, account, 'Private merchant detail', amount, kind, 'Food', date],
        )
      ).rows[0].id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Household budget test','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      aAccount = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Private household cash','INR')returning id",
          [w],
        )
      ).rows[0].id;
      aExpense = await expense(aAccount);
      budget = (await save()).id;
      await asUser(B);
      bAccount = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Member private cash','INR')returning id",
          [w],
        )
      ).rows[0].id;
      bExpense = await expense(bAccount, 30);
    });
    it('keeps private budgets and snapshots hidden from other workspace members', async () => {
      await asUser(A);
      spending = (await publish()).id;
      await asUser(B);
      expect(await b()).toBeUndefined();
      expect(await s()).toBeUndefined();
      await expect(publish(randomUUID(), budget, bExpense, null, 2)).rejects.toThrow(
        /inaccessible/,
      );
      await asUser(C);
      expect(await b()).toBeUndefined();
      expect(await s()).toBeUndefined();
    });
    it('shares only published amounts/dates/notes and lets editors contribute owned expenses', async () => {
      await asUser(A);
      await save(budget, (await b()).revision, { sharing: 'workspace' });
      await asUser(B);
      expect(await s()).toMatchObject({ amount: '80.00', currency: 'INR' });
      expect(
        (await db.query('select * from public.household_spending_links where id=$1', [spending]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.transactions where id=$1', [aExpense])).rows,
      ).toHaveLength(0);
      const x = await publish(randomUUID(), budget, bExpense);
      expect(await s(x.id)).toMatchObject({ owner_id: B, amount: '30.00' });
      expect(
        (
          await db.query<{ sum: string }>(
            'select sum(amount)::text sum from public.household_spending where budget_id=$1 and not withdrawn',
            [budget],
          )
        ).rows[0].sum,
      ).toBe('110.00');
    });
    it('restricts budget metadata/archive and sharing changes to their authorized roles', async () => {
      await asUser(B);
      await expect(save(budget, (await b()).revision, { sharing: 'workspace' })).rejects.toThrow(
        /inaccessible/,
      );
      await expect(archive()).rejects.toThrow(/inaccessible/);
      const x = (
        await save(randomUUID(), null, { sharing: 'workspace', category: 'Member utilities' })
      ).id;
      await asUser(A);
      await save(x, 1, { sharing: 'workspace', category: 'Member utilities', amount: 200 });
      await expect(
        save(x, 2, { sharing: 'private', category: 'Member utilities' }),
      ).rejects.toThrow(/Only the budget creator/);
    });
    it('denies linking another person’s expenses or mismatched month, currency and type', async () => {
      await asUser(B);
      await expect(publish(randomUUID(), budget, aExpense)).rejects.toThrow(/your own expense/);
      const feb = await expense(bAccount, 20, '2026-02-15');
      await expect(publish(randomUUID(), budget, feb)).rejects.toThrow(/budget month/);
      const income = await expense(bAccount, 20, '2026-01-15', 'income');
      await expect(publish(randomUUID(), budget, income)).rejects.toThrow(/own expense/);
      await asUser(A);
      const usd = (await save(randomUUID(), null, { currency: 'USD' })).id;
      await expect(publish(randomUUID(), usd, aExpense)).rejects.toThrow(/currency/);
    });
    it('keeps exact retries single and protects both parent and snapshot revisions', async () => {
      await asUser(A);
      const extra = await expense(aAccount, 10),
        x = await publish(randomUUID(), budget, extra),
        parent = await b();
      await publish(x.id, budget, extra, null, x.pr, x.request);
      expect((await b()).revision).toBe(parent.revision);
      await expect(publish(x.id, budget, extra, null, x.pr, x.request, 'Changed')).rejects.toThrow(
        /another change/,
      );
      await expect(publish(x.id, budget, extra, 1, x.pr)).rejects.toThrow(/budget changed/);
      await publish(x.id, budget, extra, 1);
      await expect(publish(x.id, budget, extra, 1)).rejects.toThrow(/contribution changed/);
    });
    it('prevents active duplicate expense inclusion and reuses it only after withdrawal', async () => {
      await asUser(A);
      await expect(publish(randomUUID(), budget, aExpense)).rejects.toThrow(/already included/);
      const x = await withdraw();
      expect((await s()).withdrawn).toBe(true);
      const other = (await save(randomUUID(), null, { category: 'Another category' })).id;
      const linked = await publish(randomUUID(), other, aExpense);
      await expect(publish(spending, budget, aExpense, (await s()).revision)).rejects.toThrow(
        /already included/,
      );
      await withdraw(linked.id);
      await publish(spending, budget, aExpense, (await s()).revision);
      await withdraw(spending, x.rev, x.request);
      expect((await s()).withdrawn).toBe(false);
    });
    it('lets contributors withdraw after a budget becomes private while hiding its details', async () => {
      await asUser(B);
      const owned = (
        await db.query<Spending>(
          'select * from public.household_spending where budget_id=$1 and owner_id=$2',
          [budget, B],
        )
      ).rows[0];
      await asUser(A);
      await save(budget, (await b()).revision, { sharing: 'private' });
      await asUser(B);
      expect(await b()).toBeUndefined();
      expect(await s(owned.id)).toBeDefined();
      expect(
        (await db.query('select id from public.household_spending_links where id=$1', [owned.id]))
          .rows,
      ).toHaveLength(1);
      await withdraw(owned.id);
      await asUser(A);
      expect(await s(owned.id)).toBeUndefined();
      await save(budget, (await b()).revision, { sharing: 'workspace' });
    });
    it('does not let owners change another contributor’s snapshot or Finance link', async () => {
      await asUser(A);
      const owned = (
        await db.query<Spending>(
          'select * from public.household_spending where budget_id=$1 and owner_id=$2',
          [budget, A],
        )
      ).rows[0];
      await asUser(B);
      await expect(withdraw(owned.id, owned.revision)).rejects.toThrow(/Your contribution/);
      await expect(publish(owned.id, budget, bExpense, owned.revision)).rejects.toThrow(
        /inaccessible/,
      );
    });
    it('freezes archive additions but permits withdrawal and preserves snapshots on restore', async () => {
      await asUser(A);
      await archive();
      await expect(publish(randomUUID(), budget, aExpense)).rejects.toThrow(/Restore the budget/);
      await withdraw();
      await archive(budget, false);
      expect((await s()).withdrawn).toBe(true);
      await publish(spending, budget, aExpense, (await s()).revision);
    });
    it('keeps category/month/currency fixed after withdrawn history and enforces unique identities including archives', async () => {
      await asUser(A);
      await expect(
        save(budget, (await b()).revision, { category: 'Changed', sharing: 'workspace' }),
      ).rejects.toThrow(/cannot change/);
      await expect(save(randomUUID(), null, { category: 'groceries' })).rejects.toThrow(
        /household_budget_identity/,
      );
      const x = (await save(randomUUID(), null, { category: 'Archived category' })).id;
      await archive(x);
      await expect(save(randomUUID(), null, { category: 'Archived category' })).rejects.toThrow(
        /household_budget_identity/,
      );
    });
    it('rechecks viewer/removal authorization before replaying receipts', async () => {
      await asUser(B);
      const extra = await expense(bAccount, 12),
        x = await publish(randomUUID(), budget, extra);
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await s(x.id)).toBeDefined();
      await expect(publish(x.id, budget, extra, null, x.pr, x.request)).rejects.toThrow(
        /inaccessible/,
      );
      await expect(withdraw(x.id)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(await s(x.id)).toBeUndefined();
      expect((await db.query('select * from public.household_spending_links')).rows).toHaveLength(
        0,
      );
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('rejects direct writes, private receipts, invalid values and anonymous calls', async () => {
      await asUser(A);
      await expect(
        db.query('update public.household_spending set amount=1 where id=$1', [spending]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from private.household_budget_requests')).rejects.toThrow(
        /permission denied/,
      );
      for (const changes of [
        { amount: 0 },
        { amount: 0.001 },
        { amount: 1000000001 },
        { amount: 'NaN' },
        { month: '2026-01-02' },
        { month: null },
        { currency: 'inr' },
        { category: '' },
        { notes: 'x'.repeat(2001) },
      ])
        await expect(save(randomUUID(), null, changes)).rejects.toThrow(/valid household budget/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.household_budgets')).rejects.toThrow(
        /permission denied/,
      );
      await expect(save()).rejects.toThrow(/permission denied/);
    });
    it('limits contributions including withdrawn history', async () => {
      await asUser(A);
      const x = (await save(randomUUID(), null, { category: 'Large history' })).id;
      await db.exec('reset role');
      await db.query(
        "insert into public.household_spending(id,workspace_id,owner_id,budget_id,currency,amount,booked_on,withdrawn)select gen_random_uuid(),$1,$2,$3,'INR',1,'2026-01-15',true from generate_series(1,500)",
        [w, A, x],
      );
      await asUser(A);
      await expect(publish(randomUUID(), x, aExpense)).rejects.toThrow(/already included/);
      const fresh = await expense(aAccount, 1);
      await expect(publish(randomUUID(), x, fresh)).rejects.toThrow(/500 contributions/);
    });
    it('refreshes only explicitly and keeps snapshots when the Finance expense is deleted', async () => {
      await asUser(A);
      const old = await s();
      await db.exec('reset role');
      await db.query('update public.transactions set amount=90 where id=$1', [aExpense]);
      await asUser(A);
      expect((await s()).amount).toBe(old.amount);
      await publish(spending, budget, aExpense, old.revision);
      expect((await s()).amount).toBe('90.00');
      await db.exec('reset role');
      await db.query('delete from public.transactions where id=$1', [aExpense]);
      await asUser(A);
      expect((await s()).amount).toBe('90.00');
      expect(
        (
          await db.query<{ transaction_id: string | null }>(
            'select transaction_id from public.household_spending_links where id=$1',
            [spending],
          )
        ).rows[0].transaction_id,
      ).toBeNull();
      await withdraw();
      expect((await s()).withdrawn).toBe(true);
    });
  });
}
