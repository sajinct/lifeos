import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function loanSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private loans and atomic repayment ledger', () => {
    let db: PGlite, w: string, account: string, today: string, loan: string, other: string;
    async function create(
      v: {
        id?: string;
        workspace?: string;
        account?: string | null;
        rate?: number;
        term?: number;
        principal?: number;
        direction?: string;
        date?: string;
        due?: string;
        currency?: string;
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.create_loan($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [
        id,
        v.workspace ?? w,
        'Synthetic loan',
        'Synthetic lender',
        v.direction ?? 'borrowed',
        v.currency ?? 'INR',
        v.principal ?? 1200,
        v.rate ?? 12,
        v.term ?? 12,
        v.date ?? today,
        v.due ?? today,
        'Test only',
        v.account === undefined ? account : v.account,
      ]);
      return id;
    }
    async function repay(
      l: string,
      p: number,
      i: number,
      id = randomUUID(),
      a: string | null = account,
      date = today,
    ) {
      await db.query('select public.record_loan_repayment($1,$2,$3,$4,$5,$6,$7)', [
        id,
        l,
        p,
        i,
        date,
        a,
        'Test only',
      ]);
      return id;
    }
    async function row(l: string) {
      return (
        await db.query<{
          principal_paid: string;
          interest_paid: string;
          next_due_on: string | null;
          status: string;
        }>(
          'select principal_paid,interest_paid,next_due_on::text,status from public.loans where id=$1',
          [l],
        )
      ).rows[0];
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (await db.query<{ id: string }>("select public.create_workspace('Loan tests') as id"))
        .rows[0].id;
      account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name) values($1,'Loan cash') returning id",
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
        await db.query<{ id: string }>("select public.create_workspace('Other loan owner') as id")
      ).rows[0].id;
      await asUser(A);
    });
    it('validates fixed simple interest, term, currency and immutable table grants', async () => {
      loan = await create();
      const terms = (
        await db.query<{ interest_total: string; installment_amount: string }>(
          'select interest_total,installment_amount from public.loans where id=$1',
          [loan],
        )
      ).rows[0];
      expect(Number(terms.interest_total)).toBe(144);
      expect(Number(terms.installment_amount)).toBe(112);
      await expect(
        db.query('update public.loans set principal=1 where id=$1', [loan]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('delete from public.loan_repayments')).rejects.toThrow(
        /permission denied/,
      );
      for (const v of [
        { rate: -1 },
        { rate: 100.01 },
        { principal: 0 },
        { principal: 1.001 },
        { term: 0 },
        { term: 601 },
        { principal: 0.01, term: 12 },
        { currency: 'USD' },
        { date: '2200-01-01' },
      ])
        await expect(create(v)).rejects.toThrow();
    });
    it('records initial principal once as cash, excluding it from income and expense', async () => {
      await create({ id: loan });
      const entries = (
        await db.query<{ kind: string; amount: string }>(
          'select kind,amount from public.transactions where loan_id=$1',
          [loan],
        )
      ).rows;
      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('transfer_in');
      expect(Number(entries[0].amount)).toBe(1200);
    });
    it('posts principal and interest atomically once, keeps partial due dates and advances after full installment', async () => {
      const nonce = await repay(loan, 50, 6);
      await repay(loan, 50, 6, nonce);
      expect(Number((await row(loan)).principal_paid)).toBe(50);
      expect((await row(loan)).next_due_on).toBe(today);
      const entries = (
        await db.query<{ kind: string; amount: string }>(
          'select kind,amount from public.transactions where loan_repayment_id=$1 order by kind',
          [nonce],
        )
      ).rows;
      expect(entries.map((e) => e.kind)).toEqual(['expense', 'transfer_out']);
      expect(entries.map((e) => Number(e.amount))).toEqual([6, 50]);
      await repay(loan, 50, 6);
      expect((await row(loan)).next_due_on! > today).toBe(true);
      await expect(repay(loan, 1200, 0)).rejects.toThrow(/exceeds/);
      expect(Number((await row(loan)).principal_paid)).toBe(100);
    });
    it('rejects wrong accounts and dates without creating partial ledger or repayments', async () => {
      const usd = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency) values($1,'USD','USD') returning id",
          [w],
        )
      ).rows[0].id;
      const count = async () =>
          Number(
            (
              await db.query<{ n: string }>(
                'select count(*) as n from public.loan_repayments where loan_id=$1',
                [loan],
              )
            ).rows[0].n,
          ),
        before = await count();
      await expect(repay(loan, 10, 1, randomUUID(), usd)).rejects.toThrow(/currency/);
      await expect(repay(loan, 10, 1, randomUUID(), account, '2200-01-01')).rejects.toThrow();
      expect(await count()).toBe(before);
      const elsewhere = await create({ account: null });
      const nonce = await repay(elsewhere, 1, 0);
      await expect(repay(loan, 1, 0, nonce)).rejects.toThrow(/inaccessible/);
    });
    it('settles without duplicates, retains history, supports lent direction and tracking only', async () => {
      const nonce = await repay(loan, 1100, 132);
      expect((await row(loan)).status).toBe('paid');
      expect((await row(loan)).next_due_on).toBeNull();
      await repay(loan, 1100, 132, nonce);
      await expect(repay(loan, 1, 0)).rejects.toThrow();
      const lent = await create({ direction: 'lent', term: 1, rate: 0, principal: 10 });
      const p = await repay(lent, 10, 0);
      expect(
        (
          await db.query<{ kind: string }>(
            'select kind from public.transactions where loan_repayment_id=$1',
            [p],
          )
        ).rows[0].kind,
      ).toBe('transfer_in');
      const track = await create({ account: null });
      const q = await repay(track, 10, 1, randomUUID(), null);
      expect(
        (await db.query('select id from public.transactions where loan_repayment_id=$1', [q])).rows,
      ).toHaveLength(0);
    });
    it('denies viewers, other owners, anonymous callers and cross-workspace account links', async () => {
      await asUser(B);
      expect(
        (await db.query('select id from public.loans where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.loan_repayments where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(repay(loan, 1, 0)).rejects.toThrow(/owner/);
      await expect(create({ workspace: w })).rejects.toThrow(/write/);
      await expect(create({ id: loan, workspace: other, account: null })).rejects.toThrow(
        /inaccessible/,
      );
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      const memberLoan = await create({ workspace: w, account: null });
      await asUser(A);
      expect(
        (await db.query('select id from public.loans where id=$1', [memberLoan])).rows,
      ).toHaveLength(0);
      await expect(repay(memberLoan, 1, 0)).rejects.toThrow(/owner/);
      const second = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Separate loan workspace') as id",
        )
      ).rows[0].id;
      await expect(create({ workspace: second })).rejects.toThrow(/account/);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.loans where id=$1', [memberLoan])).rows,
      ).toHaveLength(0);
      await expect(repay(memberLoan, 1, 0, randomUUID(), null)).rejects.toThrow(/owner/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.loans')).rejects.toThrow(/permission denied/);
      await expect(create()).rejects.toThrow(/permission denied/);
      await asUser(A);
      expect(C).toBeTruthy();
    });
    it('dispatches private upcoming/overdue reminders once and clears notices after full repayment', async () => {
      const due = await create({ principal: 10, term: 1, rate: 0, account: null });
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,true,3)",
      );
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query(
            "select id from public.notifications where source_kind='loan' and source_id=$1 and dismissed_at is null",
            [due],
          )
        ).rows,
      ).toHaveLength(1);
      await asUser(A);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7)",
      );
      expect(
        (
          await db.query<{ loan_reminders: boolean }>(
            'select loan_reminders from public.app_settings where id=$1',
            [A],
          )
        ).rows[0].loan_reminders,
      ).toBe(true);
      await repay(due, 10, 0, randomUUID(), null);
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id=$1 and dismissed_at is null',
            [due],
          )
        ).rows,
      ).toHaveLength(0);
      const overdue = await create({
        principal: 10,
        term: 1,
        rate: 0,
        account: null,
        date: '2025-01-01',
        due: '2025-01-01',
      });
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      expect(
        (
          await db.query<{ title: string; phase: string }>(
            'select title,phase from public.notifications where source_id=$1',
            [overdue],
          )
        ).rows[0],
      ).toMatchObject({ phase: 'overdue', title: 'Loan repayment overdue: Synthetic loan' });
      await asUser(A);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3)",
      );
      expect(
        (
          await db.query(
            "select id from public.notifications where source_kind='loan' and dismissed_at is null and owner_id=$1",
            [A],
          )
        ).rows,
      ).toHaveLength(0);
    });
    it('anchors end-of-month dates and cent-rounded last installments', async () => {
      const l = await create({
        principal: 100,
        term: 3,
        rate: 0,
        account: null,
        date: '2025-01-01',
        due: '2025-01-31',
      });
      await repay(l, 33.34, 0, randomUUID(), null);
      expect((await row(l)).next_due_on).toBe('2025-02-28');
      await repay(l, 33.34, 0, randomUUID(), null);
      expect((await row(l)).next_due_on).toBe('2025-03-31');
      await repay(l, 33.32, 0, randomUUID(), null);
      expect((await row(l)).status).toBe('paid');
    });
  });
}
