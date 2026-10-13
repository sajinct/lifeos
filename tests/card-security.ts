import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function cardSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private credit-card statements and atomic transfer payments', () => {
    let db: PGlite, w: string, card: string, account: string, bank: string, statement: string;
    const input = {
      title: 'Synthetic card',
      last_four: '1234',
      currency: 'INR',
      opening_debt: 1000,
      credit_limit: 5000,
      closing_day: 31,
      due_day: 15,
      notes: '',
      reminders_enabled: true,
    };
    const fields = {
      cycle_end: '2024-01-31',
      due_on: '2024-02-15',
      amount: 1000,
      minimum_due: 100,
      notes: '',
    };
    const save = (id = card, revision: number | null = null, patch: Record<string, unknown> = {}) =>
      db.query('select public.save_credit_card($1,$2,$3,$4::jsonb)', [
        id,
        w,
        revision,
        JSON.stringify({ ...input, ...patch }),
      ]);
    const stmt = (
      id = statement,
      revision: number | null = null,
      patch: Record<string, unknown> = {},
    ) =>
      db.query('select public.save_card_statement($1,$2,$3,$4,$5::jsonb)', [
        id,
        w,
        revision,
        card,
        JSON.stringify({ ...fields, ...patch }),
      ]);
    const pay = (id: string, amount = 250, source = bank, date = '2024-02-01') =>
      db.query('select public.record_card_payment($1,$2,$3,$4,$5,$6,$7)', [
        id,
        w,
        statement,
        source,
        amount,
        date,
        'Synthetic',
      ]);
    const row = async (table: string, id: string) =>
      (await db.query<Record<string, unknown>>(`select * from public.${table} where id=$1`, [id]))
        .rows[0];
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>("select public.create_workspace('Card tests','family') id")
      ).rows[0].id;
      card = randomUUID();
      statement = randomUUID();
      await save();
      account = String((await row('credit_cards', card)).account_id);
      bank = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency,opening_balance)values($1,'Bank','INR',2000) returning id",
          [w],
        )
      ).rows[0].id;
      await stmt();
    });
    it('creates a negative debt account exactly once and protects private records from members and workspace owners', async () => {
      await save(card, null, { title: 'Ignored' });
      expect((await row('credit_cards', card)).title).toBe('Synthetic card');
      expect(Number((await row('accounts', account)).opening_balance)).toBe(-1000);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      for (const table of ['credit_cards', 'card_statements', 'card_payments'])
        expect(
          (await db.query(`select * from public.${table} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(save()).rejects.toThrow(/inaccessible/);
      await expect(stmt()).rejects.toThrow(/inaccessible/);
      const own = randomUUID();
      await save(own);
      await asUser(A);
      expect(await row('credit_cards', own)).toBeUndefined();
      await expect(
        db.query('select public.act_on_card_record($1,$2,1,$3)', [own, 'card', 'archive']),
      ).rejects.toThrow(/inaccessible/);
    });
    it('rejects direct writes, invalid precision, guessed bindings and stale edits', async () => {
      await asUser(A);
      await expect(
        db.query('update public.card_statements set amount=0 where id=$1', [statement]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('delete from public.card_payments')).rejects.toThrow(
        /permission denied/,
      );
      for (const patch of [
        { credit_limit: 'NaN' },
        { credit_limit: 1.001 },
        { last_four: '123456' },
        { closing_day: 0 },
        { opening_debt: -1 },
      ])
        await expect(save(randomUUID(), null, patch)).rejects.toThrow();
      for (const patch of [
        { amount: 1.001 },
        { minimum_due: 1001 },
        { cycle_end: '2099-01-01' },
        { due_on: '2024-01-31' },
      ])
        await expect(stmt(randomUUID(), null, patch)).rejects.toThrow();
      await save(card, 1, { title: 'Updated card' });
      await expect(save(card, 1)).rejects.toThrow(/changed/);
      await stmt(statement, 1, { amount: 1000 });
      await expect(stmt(statement, 1)).rejects.toThrow(/changed/);
      await expect(
        stmt(statement, 2, { cycle_end: '2024-02-29', due_on: '2024-03-15' }),
      ).rejects.toThrow(/cycle/);
    });
    it('posts partial payments exactly once as transfers without adding expenses or changing combined account value', async () => {
      const id = randomUUID();
      await pay(id);
      await pay(id);
      const legs = (
        await db.query<{ kind: string; amount: string }>(
          'select kind,amount from public.transactions where transfer_id=$1',
          [id],
        )
      ).rows;
      expect(legs.map((r) => r.kind).sort()).toEqual(['transfer_in', 'transfer_out']);
      expect(legs.every((r) => Number(r.amount) === 250)).toBe(true);
      expect(
        (
          await db.query(
            "select id from public.transactions where account_id=$1 and kind='expense'",
            [account],
          )
        ).rows,
      ).toHaveLength(0);
      await db.exec('reset role');
      expect(
        Number(
          (
            await db.query<{ n: string }>(
              'select private.card_balance($1)+private.card_balance($2) n',
              [account, bank],
            )
          ).rows[0].n,
        ),
      ).toBe(1000);
      await asUser(A);
      await expect(pay(id, 251)).rejects.toThrow(/reused/);
      await expect(pay(randomUUID(), 751)).rejects.toThrow(/remaining/);
      await expect(pay(randomUUID(), 1, account)).rejects.toThrow(/bank account/);
      await expect(pay(randomUUID(), 1, bank, '2024-01-31')).rejects.toThrow(/date/);
      await expect(stmt(statement, 3, { amount: 249, minimum_due: 0 })).rejects.toThrow(/below/);
    });
    it('keeps only the latest confirmed bank total due and preserves carried-balance history', async () => {
      const second = randomUUID();
      await stmt(second, null, { cycle_end: '2024-02-29', due_on: '2024-03-15', amount: 750 });
      expect((await row('card_statements', statement)).status).toBe('superseded');
      expect((await row('card_statements', second)).amount).toBe('750.00');
      await expect(pay(randomUUID(), 1)).rejects.toThrow(/current/);
      const payment = (
        await db.query<{ id: string }>(
          'select id from public.card_payments where statement_id=$1',
          [statement],
        )
      ).rows[0].id;
      await expect(db.query('select public.void_card_payment($1)', [payment])).rejects.toThrow(
        /newer/,
      );
      await db.query("select public.act_on_card_record($1,'statement',1,'cancel')", [second]);
      await db.query("select public.act_on_card_record($1,'statement',1,'cancel')", [second]);
      expect((await row('card_statements', statement)).status).toBe('open');
    });
    it('reverses mistaken payments once, retaining the original and returning the debt and bank balances', async () => {
      const p = (
        await db.query<{ id: string }>(
          'select id from public.card_payments where statement_id=$1',
          [statement],
        )
      ).rows[0].id;
      await db.query('select public.void_card_payment($1)', [p]);
      await db.query('select public.void_card_payment($1)', [p]);
      expect((await row('card_payments', p)).voided).toBe(true);
      const reversal = (await row('card_payments', p)).reversal_id;
      expect(
        (await db.query('select id from public.transactions where transfer_id=$1', [reversal]))
          .rows,
      ).toHaveLength(2);
      await db.exec('reset role');
      expect(
        Number(
          (await db.query<{ n: string }>('select private.card_balance($1) n', [account])).rows[0].n,
        ),
      ).toBe(-1000);
      await asUser(A);
      await expect(
        db.query("select public.act_on_card_record($1,'card',2,'archive')", [card]),
      ).rejects.toThrow(/Clear/);
    });
    it('rejects payments above recorded debt and foreign-currency or other-member accounts', async () => {
      await stmt(statement, 6, { amount: 1100 });
      await expect(pay(randomUUID(), 1001)).rejects.toThrow(/recorded card debt/);
      const foreign = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'USD bank','USD') returning id",
          [w],
        )
      ).rows[0].id;
      await expect(pay(randomUUID(), 1, foreign)).rejects.toThrow(/currency/);
      await asUser(B);
      const member = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Member bank','INR') returning id",
          [w],
        )
      ).rows[0].id;
      await asUser(A);
      await expect(pay(randomUUID(), 1, member)).rejects.toThrow(/bank account/);
      await stmt(statement, 7, { amount: 1000 });
    });
    it('uses bill opt-in for due reminders, clears on full payment or opt-out, and archives only cleared cards', async () => {
      await db.query("select public.save_reminder_preferences(false,true,false,1,3,30,0,'UTC')");
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query(
            "select id from public.notifications where source_kind='card_statement' and source_id=$1 and dismissed_at is null",
            [statement],
          )
        ).rows,
      ).toHaveLength(1);
      await asUser(A);
      const id = randomUUID();
      await pay(id, 1000);
      expect(
        (
          await db.query(
            "select id from public.notifications where source_kind='card_statement' and source_id=$1 and dismissed_at is null",
            [statement],
          )
        ).rows,
      ).toHaveLength(0);
      await db.query("select public.act_on_card_record($1,'card',2,'archive')", [card]);
      await expect(
        db.query("select public.record_transaction($1,$2,'Archived spend',1,'expense')", [
          w,
          account,
        ]),
      ).rejects.toThrow(/Restore/);
      await db.query("select public.act_on_card_record($1,'card',3,'restore')", [card]);
      await db.query('select public.void_card_payment($1)', [id]);
      await db.query("select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC')");
      expect(
        (
          await db.query(
            "select id from public.notifications where source_kind='card_statement' and source_id=$1 and dismissed_at is null",
            [statement],
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('applies payments after closing to a newer statement and prevents unallocated generic transfers', async () => {
      const late = randomUUID();
      await pay(late, 250, bank, '2024-03-01');
      const newer = randomUUID();
      await stmt(newer, null, { cycle_end: '2024-02-29', due_on: '2024-03-15', amount: 1000 });
      await expect(
        db.query("select public.record_card_payment($1,$2,$3,$4,751,'2024-03-02','')", [
          randomUUID(),
          w,
          newer,
          bank,
        ]),
      ).rejects.toThrow(/remaining/);
      await expect(
        stmt(newer, 1, {
          cycle_end: '2024-02-29',
          due_on: '2024-03-15',
          amount: 249,
          minimum_due: 0,
        }),
      ).rejects.toThrow(/below/);
      await expect(
        db.query('select public.transfer_funds($1,$2,$3,1,$4)', [w, bank, account, randomUUID()]),
      ).rejects.toThrow(/Credit cards/);
      await db.query("select public.act_on_card_record($1,'statement',1,'cancel')", [newer]);
      await db.query('select public.void_card_payment($1)', [late]);
    });
    it('revokes access after membership removal and denies viewers and private helper calls', async () => {
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      await asUser(C);
      await expect(save(randomUUID())).rejects.toThrow(/write/);
      await expect(db.query('select private.card_balance($1)', [account])).rejects.toThrow(
        /permission/,
      );
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.credit_cards where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(save(randomUUID())).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.credit_cards')).rejects.toThrow(/permission/);
      await asUser(A);
    });
  });
}
