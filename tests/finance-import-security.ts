import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function financeImportSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Atomic, private finance imports', () => {
    let db: PGlite, w: string, account: string, otherAccount: string, batch: string;
    const row = (patch: Record<string, unknown> = {}) => ({
      date: '2024-02-01',
      title: 'Imported groceries',
      kind: 'expense',
      amount: '12.50',
      currency: 'INR',
      category: 'Food',
      reference: 'bank-001',
      ...patch,
    });
    const run = (rows: unknown[], id = randomUUID(), bank = account, workspace = w) =>
      db.query<{ result: { imported: number; skipped: number } }>(
        'select public.import_finance_csv($1,$2,$3,$4::jsonb) result',
        [id, workspace, bank, JSON.stringify(rows)],
      );
    const count = async () =>
      Number(
        (
          await db.query<{ n: string }>(
            'select count(*) n from public.transactions where account_id=$1',
            [account],
          )
        ).rows[0].n,
      );
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Import security','family') id",
        )
      ).rows[0].id;
      account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency,opening_balance)values($1,'CSV bank','INR',100) returning id",
          [w],
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      otherAccount = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Other bank','INR') returning id",
          [w],
        )
      ).rows[0].id;
      await asUser(A);
    });
    it('posts normal income/expense entries once and preserves opening balances', async () => {
      batch = randomUUID();
      const rows = [
        row(),
        row({
          kind: 'income',
          title: 'Imported pay',
          amount: '100.00',
          category: 'Salary',
          reference: 'bank-002',
        }),
      ];
      expect((await run(rows, batch)).rows[0].result).toEqual({ imported: 2, skipped: 0 });
      expect((await run(rows, batch)).rows[0].result).toEqual({ imported: 2, skipped: 0 });
      expect(await count()).toBe(2);
      expect(
        (
          await db.query<{ opening_balance: string }>(
            'select opening_balance from public.accounts where id=$1',
            [account],
          )
        ).rows[0].opening_balance,
      ).toBe('100.00');
      expect(
        (
          await db.query(
            'select id from public.transactions where account_id=$1 and transfer_id is not null',
            [account],
          )
        ).rows,
      ).toHaveLength(0);
      await expect(run([row()], batch)).rejects.toThrow(/request reused/);
    });
    it('skips reuploads, duplicate rows and previously entered manual transactions', async () => {
      expect((await run([row()])).rows[0].result).toEqual({ imported: 0, skipped: 1 });
      const repeated = row({ title: 'Repeated', reference: '' });
      expect((await run([repeated, repeated])).rows[0].result).toEqual({ imported: 1, skipped: 1 });
      await db.query(
        "select public.record_transaction($1,$2,'Manual purchase',4.50,'expense','Other','2024-02-01')",
        [w, account],
      );
      expect(
        (
          await run([
            row({ title: 'Manual purchase', amount: '4.50', category: 'Other', reference: '' }),
          ])
        ).rows[0].result,
      ).toEqual({ imported: 0, skipped: 1 });
    });
    it('rejects changed reference payloads and rolls back every preceding row', async () => {
      const before = await count(),
        id = randomUUID();
      await expect(
        run(
          [row({ title: 'Would insert', reference: 'new-reference' }), row({ amount: '99.00' })],
          id,
        ),
      ).rejects.toThrow(/Reference/);
      expect(await count()).toBe(before);
      expect(
        (await db.query('select id from public.finance_import_batches where id=$1', [id])).rows,
      ).toHaveLength(0);
    });
    it('rejects rounding, bad dates, currency mismatches, transfers and forged columns atomically', async () => {
      const before = await count();
      for (const patch of [
        { amount: '1.001' },
        { amount: 'NaN' },
        { amount: '0' },
        { amount: '1000000000000' },
        { date: '2024-02-30' },
        { date: '1899-01-01' },
        { date: '2100-01-01' },
        { currency: 'USD' },
        { kind: 'transfer_out' },
        { owner_id: B },
        { amount: 12.5 },
        { title: '' },
        { category: 'x'.repeat(101) },
      ])
        await expect(
          run([row({ title: 'Rollback candidate', reference: randomUUID() }), row(patch)]),
        ).rejects.toThrow();
      expect(await count()).toBe(before);
    });
    it('enforces current-account ownership for members and workspace owners', async () => {
      await expect(run([row()], randomUUID(), otherAccount)).rejects.toThrow(/own account/);
      await asUser(B);
      expect(
        (await db.query('select id from public.finance_import_batches where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.transactions where account_id=$1', [account])).rows,
      ).toHaveLength(0);
      await expect(run([row()])).rejects.toThrow(/own account/);
      await expect(run([row()], batch)).rejects.toThrow(/request reused/);
      expect((await run([row()], randomUUID(), otherAccount)).rows[0].result.imported).toBe(1);
      await asUser(A);
      expect(
        (
          await db.query('select id from public.finance_import_batches where account_id=$1', [
            otherAccount,
          ])
        ).rows,
      ).toHaveLength(0);
    });
    it('blocks viewer, revoked and unrelated membership, including retries', async () => {
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(run([row()], randomUUID(), otherAccount)).rejects.toThrow(/write access/);
      await asUser(C);
      await expect(run([row()])).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.finance_import_batches where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      await expect(run([row()], randomUUID(), otherAccount)).rejects.toThrow(/write access/);
      await asUser(A);
    });
    it('rejects direct batch and ledger mutations and anonymous access', async () => {
      await expect(
        db.query("update public.finance_import_batches set result='{}' where id=$1", [batch]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('delete from public.finance_import_batches where id=$1', [batch]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query(
          "update public.transactions set import_reference='forged' where import_batch_id=$1",
          [batch],
        ),
      ).rejects.toThrow(/permission denied/);
      await db.exec('reset role;set role anon');
      await expect(run([row()])).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from public.finance_import_batches')).rejects.toThrow(
        /permission denied/,
      );
      await asUser(A);
    });
    it('bounds batch size and rejects cross-workspace accounts', async () => {
      await expect(run([])).rejects.toThrow(/1 to 500/);
      await expect(run(Array.from({ length: 501 }, () => row()))).rejects.toThrow(/1 to 500/);
      const other = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Other import workspace') id",
        )
      ).rows[0].id;
      await expect(run([row()], randomUUID(), account, other)).rejects.toThrow(/own account/);
    });
    it('honors profile-local today and archived card restrictions', async () => {
      const card = randomUUID();
      await db.query('select public.save_credit_card($1,$2,null,$3::jsonb)', [
        card,
        w,
        JSON.stringify({
          title: 'Import card',
          last_four: '',
          currency: 'INR',
          opening_debt: 0,
          credit_limit: 0,
          closing_day: 25,
          due_day: 15,
          notes: '',
          reminders_enabled: false,
        }),
      ]);
      const bank = (
        await db.query<{ account_id: string }>(
          'select account_id from public.credit_cards where id=$1',
          [card],
        )
      ).rows[0].account_id;
      await db.query("select public.act_on_card_record($1,'card',1,'archive')", [card]);
      await expect(run([row()], randomUUID(), bank)).rejects.toThrow(/archived/);
      const today = (
        await db.query<{ today: string }>(
          'select (now() at time zone (select timezone from public.profiles where id=auth.uid()))::date::text today',
        )
      ).rows[0].today;
      expect(
        (await run([row({ date: today, title: 'Today', reference: 'today' })])).rows[0].result
          .imported,
      ).toBe(1);
    });
  });
}
