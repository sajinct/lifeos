import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function educationSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Education sharing, fees, payment history and private Finance links', () => {
    let db: PGlite,
      w: string,
      student: string,
      fee: string,
      memberStudent: string,
      member: string,
      expense: string,
      account: string,
      payment: string;
    type Student = {
      id: string;
      revision: number;
      visibility: string;
      archived: boolean;
      owner_id: string;
      member_id: string | null;
    };
    type Fee = {
      id: string;
      revision: number;
      amount: number;
      currency: string;
      archived: boolean;
      student_id: string;
    };
    type Payment = {
      id: string;
      revision: number;
      amount: number;
      paid_on: string;
      voided: boolean;
      owner_id: string;
      fee_id: string;
    };
    async function srow(id = student) {
      return (await db.query<Student>('select * from public.education_students where id=$1', [id]))
        .rows[0];
    }
    async function frow(id = fee) {
      return (await db.query<Fee>('select * from public.education_fees where id=$1', [id])).rows[0];
    }
    async function prow(id = payment) {
      return (await db.query<Payment>('select * from public.education_payments where id=$1', [id]))
        .rows[0];
    }
    async function studentSave(
      id = randomUUID(),
      revision: number | null = null,
      changes: Record<string, unknown> = {},
      request = randomUUID(),
    ) {
      const v = {
        name: 'Student example',
        school: 'Example school',
        class: 'Grade 5',
        year: '2026–2027',
        notes: '  <script>literal</script>  ',
        member: null,
        visibility: 'private',
        ...changes,
      };
      await db.query('select public.save_education_student($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        request,
        id,
        w,
        revision,
        v.name,
        v.school,
        v.class,
        v.year,
        v.notes,
        v.member,
        v.visibility,
      ]);
      return { id, request };
    }
    async function feeSave(
      id = randomUUID(),
      parent = student,
      revision: number | null = null,
      changes: Record<string, unknown> = {},
      parentRevision?: number,
      request = randomUUID(),
    ) {
      const v = {
          title: 'Term 1 tuition',
          date: '2026-12-31',
          amount: 1000,
          currency: 'INR',
          notes: 'Scheduled installment',
          ...changes,
        },
        pr = parentRevision ?? (await srow(parent)).revision;
      await db.query('select public.save_education_fee($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        request,
        id,
        parent,
        revision,
        pr,
        v.title,
        v.date,
        v.amount,
        v.currency,
        v.notes,
      ]);
      return { id, request, pr };
    }
    async function pay(
      id = randomUUID(),
      parent = fee,
      changes: Record<string, unknown> = {},
      fr?: number,
      sr?: number,
      request = randomUUID(),
    ) {
      const v = {
        amount: 100,
        date: '2026-01-15',
        reference: 'Receipt 1',
        notes: 'Already paid',
        expense: null,
        ...changes,
      };
      const f = await frow(parent),
        feeRevision = fr ?? f.revision,
        studentRevision = sr ?? (await srow(f.student_id)).revision;
      await db.query('select public.record_education_payment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [
        request,
        id,
        parent,
        feeRevision,
        studentRevision,
        v.amount,
        v.date,
        v.reference,
        v.notes,
        v.expense,
      ]);
      return { id, request, fr: feeRevision, sr: studentRevision };
    }
    async function archive(
      id: string,
      kind = 'student',
      value = true,
      revision?: number,
      sr?: number,
      request = randomUUID(),
    ) {
      const s = kind === 'student' ? await srow(id) : await srow((await frow(id)).student_id),
        r = revision ?? (kind === 'student' ? s.revision : (await frow(id)).revision);
      await db.query('select public.set_education_archive($1,$2,$3,$4,$5,$6)', [
        request,
        id,
        kind,
        r,
        sr ?? s.revision,
        value,
      ]);
      return { request, r, sr: s.revision };
    }
    async function voided(
      id = payment,
      value = true,
      revision?: number,
      fr?: number,
      sr?: number,
      request = randomUUID(),
    ) {
      const p = await prow(id),
        f = await frow(p.fee_id);
      await db.query('select public.set_education_payment_void($1,$2,$3,$4,$5,$6)', [
        request,
        id,
        revision ?? p.revision,
        fr ?? f.revision,
        sr ?? (await srow(f.student_id)).revision,
        value,
      ]);
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Education test','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      student = (await studentSave()).id;
      fee = (await feeSave()).id;
      account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency,opening_balance) values($1,'School account','INR',10000) returning id",
          [w],
        )
      ).rows[0].id;
      expense = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Paid tuition',100,'expense','Education','2026-01-15') as id",
          [w, account],
        )
      ).rows[0].id;
    });
    it('keeps student, fees and payments private even in shared workspaces', async () => {
      await asUser(A);
      payment = (await pay(randomUUID(), fee, { expense })).id;
      await asUser(B);
      expect(await srow()).toBeUndefined();
      expect(await frow()).toBeUndefined();
      expect(await prow()).toBeUndefined();
      expect(
        (await db.query('select * from public.education_payment_links where id=$1', [payment]))
          .rows,
      ).toHaveLength(0);
      await asUser(C);
      expect(await srow()).toBeUndefined();
      await expect(studentSave()).rejects.toThrow(/write access/);
    });
    it('shares education details without exposing underlying private expense links', async () => {
      await asUser(A);
      await studentSave(student, (await srow()).revision, { visibility: 'workspace' });
      await asUser(B);
      expect(await srow()).toBeDefined();
      expect(await frow()).toBeDefined();
      expect(await prow()).toBeDefined();
      expect(
        (await db.query('select * from public.education_payment_links where id=$1', [payment]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.transactions where id=$1', [expense])).rows,
      ).toHaveLength(0);
      await expect(feeSave()).rejects.toThrow(/inaccessible/);
      await expect(pay(randomUUID(), fee, {}, 1, 1)).rejects.toThrow(/inaccessible/);
      await expect(archive(student)).rejects.toThrow(/inaccessible/);
    });
    it('lets a workspace owner manage shared member education but only the creator changes sharing and household link', async () => {
      await asUser(B);
      memberStudent = (await studentSave(randomUUID(), null, { visibility: 'workspace' })).id;
      await asUser(A);
      await studentSave(memberStudent, 1, {
        visibility: 'workspace',
        school: 'Updated by workspace owner',
      });
      await expect(studentSave(memberStudent, 2, { visibility: 'private' })).rejects.toThrow(
        /Only the student creator/,
      );
      const ownedFee = (await feeSave(randomUUID(), memberStudent)).id;
      await pay(randomUUID(), ownedFee);
      expect((await frow(ownedFee)).revision).toBe(2);
      await asUser(B);
      await studentSave(memberStudent, (await srow(memberStudent)).revision, {
        visibility: 'private',
      });
      await asUser(A);
      expect(await srow(memberStudent)).toBeUndefined();
      expect(await frow(ownedFee)).toBeUndefined();
    });
    it('serializes household links and prevents private member details from being published indirectly', async () => {
      await asUser(A);
      member = randomUUID();
      await db.query(
        "select public.save_household_member($1,$2,null,'Household student','Child',null,'','private')",
        [member, w],
      );
      await expect(
        studentSave(randomUUID(), null, { member, visibility: 'workspace' }),
      ).rejects.toThrow(/matching sharing/);
      await db.query(
        "select public.save_household_member($1,$2,1,'Household student','Child',null,'','workspace')",
        [member, w],
      );
      const linked = (await studentSave(randomUUID(), null, { member, visibility: 'workspace' }))
        .id;
      await expect(
        db.query(
          "select public.save_household_member($1,$2,2,'Household student','Child',null,'','private')",
          [member, w],
        ),
      ).rejects.toThrow(/linked education/);
      await studentSave(linked, 1, { member, visibility: 'private' });
      await db.query(
        "select public.save_household_member($1,$2,2,'Household student','Child',null,'','private')",
        [member, w],
      );
      await expect(studentSave(linked, 2, { member, visibility: 'workspace' })).rejects.toThrow(
        /matching sharing/,
      );
    });
    it('keeps exact payment retries single and rejects changed payloads or reused payment IDs', async () => {
      await asUser(A);
      const x = await pay();
      const pr = await prow(x.id),
        s = await srow();
      await pay(x.id, fee, {}, x.fr, x.sr, x.request);
      expect((await srow()).revision).toBe(s.revision);
      expect((await prow(x.id)).revision).toBe(pr.revision);
      await expect(pay(x.id, fee, { amount: 101 }, x.fr, x.sr, x.request)).rejects.toThrow(
        /another change/,
      );
      await expect(pay(x.id)).rejects.toThrow(/already used/);
    });
    it('rejects overpayments, lowering fees below payments, and currency changes after any history', async () => {
      await asUser(A);
      await expect(pay(randomUUID(), fee, { amount: 901 })).rejects.toThrow(/outstanding/);
      await expect(feeSave(fee, student, (await frow()).revision, { amount: 199 })).rejects.toThrow(
        /below recorded/,
      );
      await expect(
        feeSave(fee, student, (await frow()).revision, { currency: 'USD' }),
      ).rejects.toThrow(/Currency cannot change/);
    });
    it('requires both parent and fee revisions so a stale private draft cannot save after publication', async () => {
      await asUser(A);
      const f = await frow(),
        s = await srow();
      await studentSave(student, s.revision, { visibility: 'private' });
      await expect(pay(randomUUID(), fee, {}, f.revision, s.revision)).rejects.toThrow(
        /Student changed/,
      );
      await feeSave(fee, student, f.revision, { amount: 1200 });
      await expect(feeSave(fee, student, f.revision)).rejects.toThrow(/Fee changed/);
      await studentSave(student, (await srow()).revision, { visibility: 'workspace' });
    });
    it('keeps immutable payment history and voids/restores without modifying Finance', async () => {
      await asUser(A);
      const before = (
        await db.query('select amount,booked_on from public.transactions where id=$1', [expense])
      ).rows[0];
      await voided();
      expect((await prow()).voided).toBe(true);
      await voided(payment, false);
      expect((await prow()).voided).toBe(false);
      expect(
        (await db.query('select amount,booked_on from public.transactions where id=$1', [expense]))
          .rows[0],
      ).toEqual(before);
      await expect(
        db.query('update public.education_payments set amount=1 where id=$1', [payment]),
      ).rejects.toThrow(/permission denied/);
    });
    it('does not restore a voided payment if replacements would exceed the fee', async () => {
      await asUser(A);
      const s = (await studentSave()).id,
        f = (await feeSave(randomUUID(), s, null, { amount: 100 })).id,
        x = (await pay(randomUUID(), f)).id;
      await voided(x);
      await pay(randomUUID(), f);
      await expect(voided(x, false)).rejects.toThrow(/Restored payment exceeds/);
    });
    it('validates Finance link owner, type, amount, date and currency and reserves links even after voiding', async () => {
      await asUser(A);
      for (const change of [
        { amount: 50, expense },
        { date: '2026-01-16', expense },
      ])
        await expect(pay(randomUUID(), fee, change)).rejects.toThrow(/matching amount/);
      await expect(pay(randomUUID(), fee, { expense })).rejects.toThrow(/already linked/);
      const foreign = (await studentSave()).id,
        foreignFee = (await feeSave(randomUUID(), foreign, null, { currency: 'USD' })).id;
      await expect(pay(randomUUID(), foreignFee, { expense })).rejects.toThrow(/matching amount/);
      await asUser(B);
      const own = (await studentSave()).id,
        ownFee = (await feeSave(randomUUID(), own)).id;
      await expect(pay(randomUUID(), ownFee, { expense })).rejects.toThrow(/own expense/);
    });
    it('archives and restores student and fee history while freezing payments', async () => {
      await asUser(A);
      const x = await archive(student);
      await expect(pay()).rejects.toThrow(/Restore the student/);
      await expect(feeSave()).rejects.toThrow(/Restore the student/);
      await archive(student, 'student', false);
      await archive(student, 'student', true, x.r, x.sr, x.request);
      expect((await srow()).archived).toBe(false);
      await archive(fee, 'fee');
      await expect(pay()).rejects.toThrow(/Restore the student and fee/);
      await expect(voided()).rejects.toThrow(/Restore the student and fee/);
      await archive(fee, 'fee', false);
      expect(await prow()).toBeDefined();
    });
    it('rechecks current roles before cached replay and denies removed owners and outsiders', async () => {
      await asUser(B);
      const x = await studentSave();
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      expect(await srow(x.id)).toBeDefined();
      await expect(studentSave(x.id, null, {}, x.request)).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(await srow(x.id)).toBeUndefined();
      await expect(studentSave(x.id, null, {}, x.request)).rejects.toThrow(/write access/);
      await asUser(C);
      expect(await frow()).toBeUndefined();
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('rejects direct writes, private request reads, cross-parent fees and anonymous RPC access', async () => {
      await asUser(A);
      await expect(
        db.query('delete from public.education_fees where id=$1', [fee]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from private.education_requests')).rejects.toThrow(
        /permission denied/,
      );
      const other = (await studentSave()).id;
      await expect(feeSave(fee, other, (await frow()).revision)).rejects.toThrow(/inaccessible/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.education_students')).rejects.toThrow(
        /permission denied/,
      );
      await expect(studentSave()).rejects.toThrow(/permission denied/);
    });
    it('validates bounded decimal amounts, dates and literal text', async () => {
      await asUser(A);
      for (const changes of [
        { amount: 0 },
        { amount: -1 },
        { amount: 1000000001 },
        { amount: 'NaN' },
        { amount: 'Infinity' },
        { amount: 0.001 },
        { currency: 'inr' },
        { date: null },
        { notes: 'x'.repeat(2001) },
      ])
        await expect(feeSave(randomUUID(), student, null, changes)).rejects.toThrow(/valid fee/);
      for (const changes of [
        { amount: 0 },
        { amount: 0.001 },
        { date: '2100-12-31' },
        { date: null },
        { reference: 'x'.repeat(121) },
      ])
        await expect(pay(randomUUID(), fee, changes)).rejects.toThrow(/valid payment/);
      await expect(studentSave(randomUUID(), null, { year: '' })).rejects.toThrow(/valid student/);
      expect(
        (
          await db.query<{ notes: string }>(
            'select notes from public.education_students where id=$1',
            [student],
          )
        ).rows[0].notes,
      ).toContain('<script>literal</script>');
    });
    it('limits installments and payment history including archived or voided records', async () => {
      await asUser(A);
      const s = (await studentSave()).id;
      await db.exec('reset role');
      await db.query(
        "insert into public.education_fees(id,workspace_id,owner_id,student_id,title,due_on,amount,currency,archived) select gen_random_uuid(),$1,$2,$3,'Fixture','2026-12-31',1000,'INR',true from generate_series(1,200)",
        [w, A, s],
      );
      await asUser(A);
      await expect(feeSave(randomUUID(), s)).rejects.toThrow(/200 fees/);
      const s2 = (await studentSave()).id,
        f2 = (await feeSave(randomUUID(), s2)).id;
      await db.exec('reset role');
      await db.query(
        "insert into public.education_payments(id,workspace_id,owner_id,fee_id,amount,paid_on,voided) select gen_random_uuid(),$1,$2,$3,1,'2026-01-15',true from generate_series(1,200)",
        [w, A, f2],
      );
      await asUser(A);
      await expect(pay(randomUUID(), f2)).rejects.toThrow(/200 payments/);
    });
  });
}
