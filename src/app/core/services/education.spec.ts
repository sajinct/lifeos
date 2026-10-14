import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { EducationLibrary } from './education';
import { HouseholdLibrary } from './household';
import { EducationStudentInput, EducationFeeInput, EducationPaymentInput } from '../models/domain';
import {
  validateFee,
  validatePayment,
  educationTotals,
  educationCsv,
  educationPaymentsCsv,
} from '../../shared/utilities/education';
describe('Education fees, currency boundaries and safe retries', () => {
  let store: LifeStore, library: EducationLibrary;
  const student: EducationStudentInput = {
    name: ' Student example ',
    institution: 'Example school',
    class_name: 'Grade 5',
    academic_year: '2026–2027',
    member_id: '',
    notes: ' <script>literal</script> ',
    visibility: 'private',
  };
  const fee: EducationFeeInput = {
    title: 'Term 1 tuition',
    amount: '1000.00',
    currency: 'INR',
    due_on: '2026-12-31',
    notes: '',
  };
  const payment: EducationPaymentInput = {
    amount: '100',
    paid_on: '2026-01-15',
    reference: 'Receipt 1',
    notes: 'Already paid',
    expense: '',
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(EducationLibrary);
  });
  async function create() {
    const id = crypto.randomUUID();
    await library.saveStudent(crypto.randomUUID(), id, student);
    return id;
  }
  function s(id: string) {
    return store.educationStudents().find((s) => s.id === id)!;
  }
  function f(id: string) {
    return store.educationFees().find((f) => f.id === id)!;
  }
  async function add(id: string, input = fee) {
    const fid = crypto.randomUUID();
    await library.saveFee(crypto.randomUUID(), fid, s(id), input);
    return fid;
  }
  async function pay(id: string, fid: string, input = payment) {
    const pid = crypto.randomUUID();
    await library.recordPayment(crypto.randomUUID(), pid, s(id), f(fid), input);
    return pid;
  }
  it('validates amounts, real dates, currency normalization and past payment dates', () => {
    expect(validateFee({ ...fee, currency: ' inr ' }).currency).toBe('INR');
    for (const amount of ['0', '-1', '1e3', 'NaN', 'Infinity', '1,000', '1000000001', '0.001'])
      expect(() => validateFee({ ...fee, amount })).toThrow(/positive amount/);
    expect(() => validateFee({ ...fee, due_on: '2026-02-30' })).toThrow(/valid due/);
    expect(() => validatePayment({ ...payment, paid_on: '2100-12-31' }, '2026-10-14')).toThrow(
      /today or earlier/,
    );
  });
  it('records partial payments and sums balances independently by currency', async () => {
    const id = await create(),
      inr = await add(id),
      usd = await add(id, { ...fee, currency: 'USD', amount: '10' });
    await pay(id, inr, { ...payment, amount: '100.01' });
    await pay(id, inr, { ...payment, amount: '99.99' });
    await pay(id, usd, { ...payment, amount: '2.5' });
    expect(educationTotals(library.fees(s(id)), store.educationPayments(), '2027-01-01')).toEqual([
      { currency: 'INR', amount: 1000, paid: 200, remaining: 800, overdue: 800 },
      { currency: 'USD', amount: 10, paid: 2.5, remaining: 7.5, overdue: 7.5 },
    ]);
  });
  it('rejects overpayments, currency changes and amounts below paid history', async () => {
    const id = await create(),
      fid = await add(id);
    await pay(id, fid, { ...payment, amount: '500' });
    await expect(pay(id, fid, { ...payment, amount: '500.01' })).rejects.toThrow(/outstanding/);
    await expect(
      library.saveFee(crypto.randomUUID(), fid, s(id), { ...fee, amount: '499' }, f(fid)),
    ).rejects.toThrow(/below recorded/);
    await expect(
      library.saveFee(crypto.randomUUID(), fid, s(id), { ...fee, currency: 'USD' }, f(fid)),
    ).rejects.toThrow(/Currency cannot change/);
  });
  it('keeps payment content immutable, voids and restores without altering the ledger', async () => {
    const id = await create(),
      fid = await add(id),
      pid = await pay(id, fid),
      before = structuredClone(store.transactions());
    await library.voidPayment(
      crypto.randomUUID(),
      s(id),
      f(fid),
      store.educationPayments()[0],
      true,
    );
    expect(library.balance(f(fid)).remaining).toBe(1000);
    await library.voidPayment(
      crypto.randomUUID(),
      s(id),
      f(fid),
      store.educationPayments()[0],
      false,
    );
    expect(library.balance(f(fid)).remaining).toBe(900);
    expect(store.educationPayments()[0]).toMatchObject({ id: pid, amount: 100, revision: 3 });
    expect(store.transactions()).toEqual(before);
  });
  it('rejects restoring voided payments after replacements fill the fee', async () => {
    const id = await create(),
      fid = await add(id, { ...fee, amount: '100' }),
      pid = await pay(id, fid);
    await library.voidPayment(
      crypto.randomUUID(),
      s(id),
      f(fid),
      store.educationPayments()[0],
      true,
    );
    await pay(id, fid);
    await expect(
      library.voidPayment(
        crypto.randomUUID(),
        s(id),
        f(fid),
        store.educationPayments().find((p) => p.id === pid)!,
        false,
      ),
    ).rejects.toThrow(/Restored payment exceeds/);
  });
  it('links matching owned expenses without posting and flags changed or missing Finance rows', async () => {
    const id = await create(),
      fid = await add(id),
      account = store.accounts().find((a) => a.currency === 'INR') ?? store.accounts()[0];
    store.accounts.update((rows) =>
      rows.map((a) => (a.id === account.id ? { ...a, currency: 'INR' } : a)),
    );
    const tx = {
      ...store.transactions()[0],
      id: crypto.randomUUID(),
      owner_id: store.profile()!.id,
      workspace_id: store.workspace()!.id,
      account_id: account.id,
      kind: 'expense' as const,
      amount: 100,
      booked_on: payment.paid_on,
      title: 'Tuition expense',
    };
    store.transactions.update((rows) => [tx, ...rows]);
    const count = store.transactions().length;
    await pay(id, fid, { ...payment, expense: tx.id });
    expect(store.transactions()).toHaveLength(count);
    const p = store.educationPayments()[0];
    expect(library.linkStatus(p, f(fid))).toContain('Linked expense: Tuition expense');
    await expect(pay(id, fid, { ...payment, expense: tx.id })).rejects.toThrow(/matching amount/);
    store.transactions.update((rows) =>
      rows.map((t) => (t.id === tx.id ? { ...t, amount: 101 } : t)),
    );
    expect(library.linkStatus(p, f(fid))).toContain('changed');
    store.educationPaymentLinks.update((rows) =>
      rows.map((l) => ({ ...l, owner_id: 'another-user' })),
    );
    expect(library.link(p)).toBeUndefined();
  });
  it('prevents sharing a student linked to a private household member and keeps the member-sharing guard in demo', async () => {
    const id = await create(),
      member = crypto.randomUUID(),
      household = TestBed.inject(HouseholdLibrary),
      input = {
        name: 'Family student',
        relationship: 'Child',
        birthday: '',
        notes: '',
        visibility: 'private' as const,
      };
    await household.saveMember(member, input);
    await expect(
      library.saveStudent(
        crypto.randomUUID(),
        id,
        { ...student, member_id: member, visibility: 'workspace' },
        s(id),
      ),
    ).rejects.toThrow(/matching sharing/);
    await household.saveMember(
      member,
      { ...input, visibility: 'workspace' },
      store.householdMembers().find((m) => m.id === member)!,
    );
    await library.saveStudent(
      crypto.randomUUID(),
      id,
      { ...student, member_id: member, visibility: 'workspace' },
      s(id),
    );
    await expect(
      household.saveMember(
        member,
        input,
        store.householdMembers().find((m) => m.id === member)!,
      ),
    ).rejects.toThrow(/linked education/);
  });
  it('preserves archived histories, demo caches and clears records on logout', async () => {
    const id = await create(),
      fid = await add(id);
    await pay(id, fid);
    await library.archive(crypto.randomUUID(), s(id), true);
    await expect(pay(id, fid)).rejects.toThrow(/Restore the student/);
    const first = store.workspace()!;
    await store.createWorkspace('Independent education', 'personal');
    expect(store.educationStudents()).toHaveLength(0);
    await store.switchWorkspace(first);
    expect(store.educationPayments()).toHaveLength(1);
    await library.archive(crypto.randomUUID(), s(id), false);
    expect(library.balance(f(fid)).paid).toBe(100);
    store.clear();
    expect(store.educationStudents()).toHaveLength(0);
    expect(store.educationPayments()).toHaveLength(0);
  });
  it('keeps exact retries single, rejects changed payloads and guards stale student revisions', async () => {
    const id = await create(),
      fid = await add(id),
      request = crypto.randomUUID(),
      pid = crypto.randomUUID(),
      parent = s(id),
      previous = f(fid);
    await library.recordPayment(request, pid, parent, previous, payment);
    await library.recordPayment(request, pid, parent, previous, payment);
    expect(store.educationPayments()).toHaveLength(1);
    await expect(
      library.recordPayment(request, pid, parent, previous, { ...payment, amount: '101' }),
    ).rejects.toThrow(/another change/);
    await expect(
      library.recordPayment(crypto.randomUUID(), crypto.randomUUID(), parent, previous, payment),
    ).rejects.toThrow(/Student changed/);
  });
  it('protects CSV formulas, separates payment history and ignores foreign children', async () => {
    const id = await create(),
      fid = await add(id, { ...fee, title: '=SUM(A1)' });
    await pay(id, fid, { ...payment, reference: '+receipt' });
    const csv = educationCsv(
      [s(id)],
      [f(fid), { ...f(fid), student_id: 'foreign' }],
      store.educationPayments(),
    );
    expect(csv).toContain("'=SUM(A1)");
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(educationPaymentsCsv([f(fid)], store.educationPayments())).toContain("'+receipt");
  });
  it('reissues exact RPC requests after saved changes fail to refresh', async () => {
    const id = await create(),
      old = s(id),
      auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: store.profile()!.id } as NonNullable<ReturnType<typeof auth.user>>);
    const rpc = vi.fn().mockResolvedValue({ error: null });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc,
    } as unknown as ReturnType<Backend['requireClient']>);
    vi.spyOn(store, 'switchWorkspace').mockImplementation(async () => {
      store.members.set([]);
      store.educationStudents.set([]);
      store.error.set('Refresh failed');
    });
    const request = crypto.randomUUID();
    await expect(
      library.saveStudent(request, id, { ...student, institution: 'New school' }, old),
    ).rejects.toThrow(/refresh failed/);
    await expect(
      library.saveStudent(request, id, { ...student, institution: 'New school' }, old),
    ).rejects.toThrow(/refresh failed/);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
