import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function wealthSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Owner-private investment cash movements and frozen wealth', () => {
    let db: PGlite, w: string, h: string, bank: string, asset: string, card: string;
    const input = {
      title: 'Synthetic fund',
      kind: 'fund',
      currency: 'INR',
      opened_on: '2024-01-01',
      opening_cost: 80,
      opening_value: 100,
      notes: '',
    };
    const save = (id = h, rev: number | null = null, patch: Record<string, unknown> = {}) =>
      db.query('select public.save_investment_holding($1,$2,$3,$4::jsonb)', [
        id,
        w,
        rev,
        JSON.stringify({ ...input, ...patch }),
      ]);
    const row = async (table: string, id: string) =>
      (await db.query<Record<string, unknown>>(`select * from public.${table} where id=$1`, [id]))
        .rows[0];
    const revision = async () => Number((await row('investment_holdings', h)).revision);
    const append = async (
      kind: string,
      amount: number | string,
      basis = 0,
      account: string | null = null,
      date = '2024-02-01',
      id = randomUUID(),
      rev?: number,
    ) => {
      await db.query('select public.append_investment_entry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        id,
        w,
        h,
        rev ?? (await revision()),
        kind,
        amount,
        basis,
        date,
        account,
        'Synthetic',
      ]);
      return id;
    };
    const snapshot = async (id = randomUUID()) => {
      await db.query("select public.capture_wealth_snapshot($1,$2,'Synthetic review')", [id, w]);
      return (await row('wealth_snapshots', id)).totals as Record<string, unknown>[];
    };
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>("select public.create_workspace('Wealth tests','family') id")
      ).rows[0].id;
      h = randomUUID();
      asset = randomUUID();
      card = randomUUID();
      await save();
      bank = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency,opening_balance)values($1,'Wealth bank','INR',1000) returning id",
          [w],
        )
      ).rows[0].id;
      await db.query(
        "select public.save_asset($1,$2,null,'Physical asset','Other','','','','','2024-01-01',300,'INR',null,'','{}')",
        [asset, w],
      );
      await db.query('select public.save_credit_card($1,$2,null,$3::jsonb)', [
        card,
        w,
        JSON.stringify({
          title: 'Card',
          last_four: '',
          currency: 'INR',
          opening_debt: 100,
          credit_limit: 0,
          closing_day: 25,
          due_day: 15,
          notes: '',
          reminders_enabled: false,
        }),
      ]);
      for (const [direction, amount] of [
        ['borrowed', 500],
        ['lent', 200],
      ])
        await db.query(
          "select public.create_loan($1,$2,'Loan','Synthetic',$3,'INR',$4,10,12,'2024-01-01','2024-02-01','',null)",
          [randomUUID(), w, direction, amount],
        );
    });
    it('counts card debt once and uses loan principal without future interest', async () => {
      expect((await snapshot())[0]).toMatchObject({
        currency: 'INR',
        account_assets: 1000,
        account_debt: 100,
        investments: 100,
        physical_assets: 300,
        lent_principal: 200,
        borrowed_principal: 500,
        assets_total: 1600,
        liabilities_total: 600,
        net: 1000,
      });
    });
    it('isolates holdings, movements, exclusions, valuations and snapshots from members and workspace owners', async () => {
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      for (const t of [
        'investment_holdings',
        'investment_entries',
        'wealth_exclusions',
        'wealth_asset_values',
        'wealth_snapshots',
      ])
        expect(
          (await db.query(`select id from public.${t} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(save()).rejects.toThrow(/inaccessible/);
      const member = randomUUID();
      await save(member);
      await asUser(A);
      expect(await row('investment_holdings', member)).toBeUndefined();
      expect((await snapshot())[0].net).toBe(1000);
    });
    it('validates opening balances, dates, direct grants and immutable bindings', async () => {
      await asUser(A);
      await save(h, null, { title: 'Ignored' });
      expect((await row('investment_holdings', h)).title).toBe('Synthetic fund');
      for (const patch of [
        { opening_cost: 'NaN' },
        { opening_value: 1.001 },
        { opened_on: '2099-01-01' },
        { currency: 'bad' },
      ])
        await expect(save(randomUUID(), null, patch)).rejects.toThrow();
      await expect(save(h, 1, { opening_cost: 81 })).rejects.toThrow(/Opening/);
      await save(h, 1, { title: 'Updated fund' });
      await expect(save(h, 1)).rejects.toThrow(/changed/);
      await expect(
        db.query('update public.investment_holdings set current_value=100000 where id=$1', [h]),
      ).rejects.toThrow(/permission/);
      await expect(db.query('delete from public.wealth_snapshots')).rejects.toThrow(/permission/);
    });
    it('funds holdings as transfers, preserves net worth and guards replay and overdrawn withdrawals', async () => {
      const id = await append('contribution', 50, 0, bank);
      await append('contribution', 50, 0, bank, '2024-02-01', id, 2);
      expect(
        (await db.query('select id from public.transactions where transfer_id=$1', [id])).rows,
      ).toHaveLength(1);
      expect((await snapshot())[0].net).toBe(1000);
      expect((await row('investment_holdings', h)).current_cost).toBe('130.00');
      await expect(append('contribution', 51, 0, bank, '2024-02-01', id)).rejects.toThrow(/reused/);
      await expect(append('withdrawal', 151, 1)).rejects.toThrow(/exceeds/);
      await expect(append('valuation', 200, 0, bank)).rejects.toThrow(/Valuation/);
      await expect(append('contribution', 1.001)).rejects.toThrow(/decimals/);
      await expect(append('contribution', 1, 0, null, '2024-01-01')).rejects.toThrow(
        /chronological/,
      );
    });
    it('captures gain and withdrawal cost separately while preserving the valued net worth', async () => {
      const valuation = await append('valuation', 200);
      const withdrawal = await append('withdrawal', 60, 20, bank);
      const r = await row('investment_holdings', h);
      expect(r).toMatchObject({ current_cost: '110.00', current_value: '140.00' });
      expect((await snapshot())[0].net).toBe(1050);
      expect(
        (
          await db.query(
            "select id from public.transactions where workspace_id=$1 and kind in('income','expense')",
            [w],
          )
        ).rows,
      ).toHaveLength(0);
      await expect(
        db.query('select public.undo_investment_entry($1,$2)', [valuation, await revision()]),
      ).rejects.toThrow(/newer/);
      await db.query('select public.undo_investment_entry($1,$2)', [withdrawal, await revision()]);
      await db.query('select public.undo_investment_entry($1,1)', [withdrawal]);
      expect((await row('investment_holdings', h)).current_value).toBe('200.00');
      expect((await snapshot())[0].net).toBe(1050);
      await db.query('select public.undo_investment_entry($1,$2)', [valuation, await revision()]);
      expect((await snapshot())[0].net).toBe(1000);
    });
    it('rejects other-member, foreign currency and card funding accounts', async () => {
      const usd = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'USD','USD')returning id",
          [w],
        )
      ).rows[0].id;
      await expect(append('contribution', 1, 0, usd)).rejects.toThrow(/currency/);
      const cardAccount = String((await row('credit_cards', card)).account_id);
      await expect(append('contribution', 1, 0, cardAccount)).rejects.toThrow(/non-card/);
      await asUser(B);
      const foreign = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name)values($1,'Member')returning id",
          [w],
        )
      ).rows[0].id;
      await asUser(A);
      await expect(append('contribution', 1, 0, foreign)).rejects.toThrow(/own/);
    });
    it('keeps snapshots immutable and supports explicit duplicate-source exclusions and manual asset values', async () => {
      const frozen = randomUUID();
      await snapshot(frozen);
      const exclusion = randomUUID();
      await db.query("select public.set_wealth_exclusion($1,$2,null,'holding',$3,true)", [
        exclusion,
        w,
        h,
      ]);
      await db.query("select public.set_wealth_exclusion($1,$2,null,'holding',$3,true)", [
        exclusion,
        w,
        h,
      ]);
      expect((await snapshot())[0].net).toBe(850);
      expect(((await row('wealth_snapshots', frozen)).totals as { net: number }[])[0].net).toBe(
        1000,
      );
      await db.query("select public.set_wealth_exclusion($1,$2,1,'holding',$3,false)", [
        exclusion,
        w,
        h,
      ]);
      await expect(
        db.query("select public.set_wealth_exclusion($1,$2,1,'holding',$3,true)", [
          exclusion,
          w,
          h,
        ]),
      ).rejects.toThrow(/changed/);
      const mark = randomUUID();
      await db.query(
        "select public.save_wealth_asset_value($1,$2,null,$3,350,'2024-03-01','Manual')",
        [mark, w, asset],
      );
      expect((await snapshot())[0].net).toBe(1050);
      await expect(
        db.query("select public.save_wealth_asset_value($1,$2,1,$3,1,'2023-01-01','')", [
          mark,
          w,
          asset,
        ]),
      ).rejects.toThrow(/date/);
      await db.query(
        "select public.save_wealth_asset_value($1,$2,1,$3,360,'2024-04-01','Manual')",
        [mark, w, asset],
      );
      await expect(
        db.query("select public.save_wealth_asset_value($1,$2,1,$3,370,'2024-04-01','')", [
          mark,
          w,
          asset,
        ]),
      ).rejects.toThrow(/changed/);
      await db.query("select public.capture_wealth_snapshot($1,$2,'Ignored retry')", [frozen, w]);
      expect((await row('wealth_snapshots', frozen)).label).toBe('Synthetic review');
    });
    it('permits zero-proceeds loss disposal and only archives cleared holdings', async () => {
      await expect(
        db.query('select public.archive_investment_holding($1,$2,true)', [h, await revision()]),
      ).rejects.toThrow(/Clear/);
      await append('valuation', 0);
      await append('withdrawal', 0, 130);
      await db.query('select public.archive_investment_holding($1,$2,true)', [h, await revision()]);
      await expect(append('contribution', 1)).rejects.toThrow(/restore/);
      await db.query('select public.archive_investment_holding($1,$2,false)', [
        h,
        await revision(),
      ]);
      expect((await row('investment_holdings', h)).current_value).toBe('0.00');
    });
    it('denies viewers, revoked members, anonymous callers and private total access', async () => {
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      await asUser(C);
      await expect(save(randomUUID())).rejects.toThrow(/write/);
      await expect(db.query('select private.wealth_totals($1,$2)', [A, w])).rejects.toThrow(
        /permission/,
      );
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.investment_holdings where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      await expect(save(randomUUID())).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.wealth_snapshots')).rejects.toThrow(/permission/);
      await asUser(A);
    });
  });
}
