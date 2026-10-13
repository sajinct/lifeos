import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function financeJsonSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private additive JSON finance imports', () => {
    let db: PGlite, w: string, bank: string, foreign: string, created: string, batch: string;
    const account = (
      source_id = 'source-bank',
      target_id: string | null = bank,
      patch: Record<string, unknown> = {},
    ) => ({
      source_id,
      target_id,
      name: 'Imported bank',
      currency: 'INR',
      opening_balance: '100.00',
      card_source: false,
      ...patch,
    });
    const tx = (
      source_id = 'source-tx',
      account_source = 'source-bank',
      patch: Record<string, unknown> = {},
    ) => ({
      source_id,
      account_source,
      row: {
        date: '2024-02-01',
        title: 'JSON expense',
        kind: 'expense',
        amount: '12.50',
        currency: 'INR',
        category: 'Other',
        reference: 'json-001',
        ...patch,
      },
    });
    const run = (payload: unknown, id = randomUUID(), workspace = w) =>
      db.query<{ result: Record<string, number> }>(
        'select public.import_finance_json($1,$2,$3::jsonb) result',
        [id, workspace, JSON.stringify(payload)],
      );
    const tally = async () =>
      (
        await db.query<{ accounts: number; transactions: number; batches: number; links: number }>(
          `select (select count(*)::int from public.accounts where workspace_id=$1) accounts,(select count(*)::int from public.transactions where workspace_id=$1) transactions,(select count(*)::int from public.finance_json_batches where workspace_id=$1) batches,(select count(*)::int from public.finance_json_links where workspace_id=$1) links`,
          [w],
        )
      ).rows[0];
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('JSON finance security','family') id",
        )
      ).rows[0].id;
      bank = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency,opening_balance)values($1,'Existing bank','INR',500) returning id",
          [w],
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      foreign = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Member bank','INR') returning id",
          [w],
        )
      ).rows[0].id;
      await asUser(A);
    });
    it('creates mapped accounts and entries atomically and returns the original result on retry', async () => {
      batch = randomUUID();
      const payload = {
        accounts: [account('new-source', null)],
        transactions: [tx('new-tx', 'new-source')],
      };
      expect((await run(payload, batch)).rows[0].result).toEqual({
        accounts_created: 1,
        accounts_reused: 0,
        imported: 1,
        skipped: 0,
      });
      expect((await run(payload, batch)).rows[0].result.imported).toBe(1);
      created = (
        await db.query<{ account_id: string }>(
          "select account_id from public.finance_json_links where workspace_id=$1 and source_kind='account' and source_id='new-source'",
          [w],
        )
      ).rows[0].account_id;
      expect(
        (
          await db.query<{ n: number }>(
            'select count(*)::int n from public.transactions where account_id=$1',
            [created],
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        run({ accounts: [account('new-source', created)], transactions: [] }, batch),
      ).rejects.toThrow(/request reused/);
    });
    it('reuses persisted source mappings and rejects recreation and changed source transaction contents', async () => {
      expect(
        (
          await run({
            accounts: [account('new-source', created)],
            transactions: [tx('new-tx', 'new-source')],
          })
        ).rows[0].result,
      ).toEqual({ accounts_created: 0, accounts_reused: 1, imported: 0, skipped: 1 });
      await expect(
        run({ accounts: [account('new-source', null)], transactions: [] }),
      ).rejects.toThrow(/saved destination/);
      const before = await tally();
      await expect(
        run({
          accounts: [account('new-source', created)],
          transactions: [
            tx('new-tx', 'new-source', { title: 'Changed source', reference: 'new-reference' }),
          ],
        }),
      ).rejects.toThrow(/contents changed/);
      expect(await tally()).toEqual(before);
    });
    it('maps to existing owned accounts without modifying their name or opening balance', async () => {
      expect(
        (await run({ accounts: [account()], transactions: [tx()] })).rows[0].result.imported,
      ).toBe(1);
      expect(
        (await db.query('select name,opening_balance from public.accounts where id=$1', [bank]))
          .rows[0],
      ).toEqual({ name: 'Existing bank', opening_balance: '500.00' });
      expect(
        (
          await run({
            accounts: [account('alias-source')],
            transactions: [tx('alias-tx', 'alias-source')],
          })
        ).rows[0].result,
      ).toMatchObject({ imported: 0, skipped: 1 });
    });
    it('rolls back new accounts, source mappings and preceding ledger entries if any later row fails', async () => {
      const before = await tally();
      for (const patch of [
        { amount: '1.001' },
        { currency: 'USD' },
        { date: '2024-02-30' },
        { kind: 'transfer_out' },
        { owner_id: B },
        { amount: 10 },
      ]) {
        const source = randomUUID();
        await expect(
          run({
            accounts: [account(source, null)],
            transactions: [
              tx(randomUUID(), source, { reference: randomUUID() }),
              tx(randomUUID(), source, patch),
            ],
          }),
        ).rejects.toThrow();
        expect(await tally()).toEqual(before);
      }
    });
    it('rejects foreign accounts and source link remapping even for workspace owners', async () => {
      await expect(
        run({ accounts: [account('foreign-source', foreign)], transactions: [] }),
      ).rejects.toThrow(/own same-currency/);
      await expect(
        run({ accounts: [account('source-bank', created)], transactions: [] }),
      ).rejects.toThrow(/saved destination/);
      await asUser(B);
      expect(
        (await db.query('select id from public.finance_json_links where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.finance_json_batches where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      await expect(run({ accounts: [account()], transactions: [] })).rejects.toThrow(
        /own same-currency/,
      );
      await expect(
        run({ accounts: [account('new-source', created)], transactions: [] }, batch),
      ).rejects.toThrow(/request reused/);
      await asUser(A);
    });
    it('blocks anonymous, viewers, revoked and unrelated users, including batch retries', async () => {
      await db.exec('reset role;set role anon');
      await expect(run({ accounts: [account()], transactions: [] })).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query('select * from public.finance_json_links')).rejects.toThrow(
        /permission denied/,
      );
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(
        run({ accounts: [account('b-source', foreign)], transactions: [] }),
      ).rejects.toThrow(/write access/);
      await asUser(C);
      await expect(run({ accounts: [account()], transactions: [] })).rejects.toThrow(
        /write access/,
      );
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.finance_json_links where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      await expect(run({ accounts: [account()], transactions: [] }, batch)).rejects.toThrow(
        /write access/,
      );
      await asUser(A);
    });
    it('denies direct mutations and forged payload/account columns', async () => {
      await expect(
        db.query("update public.finance_json_links set source_id='forged' where workspace_id=$1", [
          w,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('delete from public.finance_json_batches where id=$1', [batch]),
      ).rejects.toThrow(/permission denied/);
      for (const payload of [
        { accounts: [account('forge', null, { owner_id: B })], transactions: [] },
        { accounts: [account('forge', null, { opening_balance: '1.001' })], transactions: [] },
        { accounts: [account('forge', null, { currency: 'inr' })], transactions: [] },
        {
          accounts: [account('forge', null)],
          transactions: [{ ...tx('forge-tx', 'forge'), project_id: randomUUID() }],
        },
        { accounts: [account()], transactions: [], workspace_id: w },
      ])
        await expect(run(payload)).rejects.toThrow();
    });
    it('requires unique IDs, resolved links and bounded batch sizes', async () => {
      for (const payload of [
        { accounts: [], transactions: [] },
        { accounts: [account('dup'), account('dup')], transactions: [] },
        { accounts: [account('duptx')], transactions: [tx('same', 'duptx'), tx('same', 'duptx')] },
        { accounts: [account('missing')], transactions: [tx('missing-tx', 'unknown')] },
        { accounts: Array.from({ length: 51 }, () => account(randomUUID())), transactions: [] },
        {
          accounts: [account()],
          transactions: Array.from({ length: 501 }, () => tx(randomUUID())),
        },
      ])
        await expect(run(payload)).rejects.toThrow();
    });
    it('prevents orphan card creation and archived or cross-currency destinations', async () => {
      await expect(
        run({ accounts: [account('source-card', null, { card_source: true })], transactions: [] }),
      ).rejects.toThrow(/existing credit cards/);
      await expect(
        run({ accounts: [account('source-card', bank, { card_source: true })], transactions: [] }),
      ).rejects.toThrow(/existing credit cards/);
      await expect(
        run({ accounts: [account('mismatch', bank, { currency: 'USD' })], transactions: [] }),
      ).rejects.toThrow(/same-currency/);
      const card = randomUUID();
      await db.query('select public.save_credit_card($1,$2,null,$3::jsonb)', [
        card,
        w,
        JSON.stringify({
          title: 'JSON card',
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
      const cardAccount = (
        await db.query<{ account_id: string }>(
          'select account_id from public.credit_cards where id=$1',
          [card],
        )
      ).rows[0].account_id;
      await db.query("select public.act_on_card_record($1,'card',1,'archive')", [card]);
      await expect(
        run({ accounts: [account('archived', cardAccount)], transactions: [] }),
      ).rejects.toThrow(/archived/);
    });
    it('rejects altered existing transaction IDs and conflicting references without partial writes', async () => {
      const original = (
        await db.query<{ id: string }>(
          "select id from public.transactions where account_id=$1 and import_reference='json-001'",
          [bank],
        )
      ).rows[0].id;
      const before = await tally();
      await expect(
        run({
          accounts: [account('id-source')],
          transactions: [tx(original, 'id-source', { title: 'Changed identity', reference: '' })],
        }),
      ).rejects.toThrow(/source ID contents changed/);
      expect(await tally()).toEqual(before);
      await expect(
        run({
          accounts: [account('ref-source')],
          transactions: [tx('ref-conflict', 'ref-source', { amount: '99.00' })],
        }),
      ).rejects.toThrow(/Reference/);
      expect(await tally()).toEqual(before);
    });
  });
}
