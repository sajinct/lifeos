import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { EducationPage } from './education';
describe('Education page, fee filters and private draft lifecycle', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UiService, useValue: { notify: vi.fn() } }],
    });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(EducationPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  async function create(page: EducationPage) {
    page.create();
    page.form.patchValue({
      name: 'Student example',
      institution: 'Example school',
      class_name: 'Grade 5',
      academic_year: '2026–2027',
      notes: '<script>literal</script>',
    });
    await page.saveStudent();
  }
  async function fee(page: EducationPage) {
    page.startFee();
    page.feeForm.patchValue({
      title: 'Term 1 tuition',
      due_on: '2026-01-01',
      amount: '1000',
      currency: 'INR',
    });
    await page.saveFee();
  }
  async function payment(page: EducationPage) {
    page.startPayment(page.fees()[0]);
    page.paymentForm.patchValue({ amount: '100', paid_on: '2026-01-15', reference: 'Receipt 1' });
    await page.recordPayment();
  }
  it('creates private student profiles, schedules fees and records partial payments with literal notes', async () => {
    const { page, store, fixture } = await setup();
    page.view.set('archived');
    page.search.set('hidden');
    await create(page);
    expect(page.rows()).toHaveLength(1);
    expect(store.educationStudents()[0].visibility).toBe('private');
    await fee(page);
    await payment(page);
    fixture.detectChanges();
    expect(page.totals()[0]).toMatchObject({ remaining: 900, paid: 100, overdue: 900 });
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<script>literal</script>');
    expect(fixture.nativeElement.textContent).toContain('Jan 1, 2026');
    expect(fixture.nativeElement.textContent).toContain('Jan 15, 2026');
  });
  it('filters fees and voided payment history, archives and restores without losing records', async () => {
    const { page, store } = await setup();
    await create(page);
    await fee(page);
    await payment(page);
    await page.voidPayment(page.fees()[0], store.educationPayments()[0]);
    page.paymentView.set('active');
    expect(page.payments(page.fees()[0])).toHaveLength(0);
    page.paymentView.set('voided');
    expect(page.payments(page.fees()[0])).toHaveLength(1);
    await page.voidPayment(page.fees()[0], store.educationPayments()[0]);
    page.feeView.set('paid');
    expect(page.fees()).toHaveLength(0);
    page.feeView.set('overdue');
    expect(page.fees()).toHaveLength(1);
    await page.archive(page.student()!, page.fees()[0]);
    page.feeView.set('archived');
    expect(page.fees()).toHaveLength(1);
    await page.archive(page.student()!, page.fees()[0]);
    await page.archive(page.student()!);
    expect(page.canManage()).toBe(false);
    await page.archive(page.student()!);
    expect(store.educationPayments()[0].voided).toBe(false);
  });
  it('retries frozen payment inputs even if the draft is edited after a failure', async () => {
    const { page, store } = await setup();
    await create(page);
    await fee(page);
    const mock = vi
      .spyOn(page.library, 'recordPayment')
      .mockRejectedValueOnce(new Error('Network failed'));
    await payment(page);
    expect(page.pending()).toBeDefined();
    expect(page.canManage()).toBe(false);
    page.paymentForm.patchValue({ amount: '999', reference: 'Changed after failure' });
    await page.retry();
    expect(mock.mock.calls[1]).toEqual(mock.mock.calls[0]);
    expect(store.educationPayments()[0]).toMatchObject({ amount: 100, reference: 'Receipt 1' });
  });
  it('retains the student revision from the start of a fee draft if sharing changes', async () => {
    const { page, store } = await setup();
    await create(page);
    page.startFee();
    page.feeForm.patchValue({
      title: 'Stale private draft',
      due_on: '2026-12-31',
      amount: '1000',
      currency: 'INR',
    });
    store.educationStudents.update((rows) =>
      rows.map((s) => ({ ...s, revision: s.revision + 1, visibility: 'workspace' })),
    );
    await page.saveFee();
    expect(page.error()).toContain('Student changed');
    expect(store.educationFees()).toHaveLength(0);
  });
  it('clears private drafts and selection on workspace changes while preserving same-workspace retries', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    vi.spyOn(page.library, 'archive').mockRejectedValue(new Error('Refresh failed'));
    await page.archive(page.student()!);
    const pending = page.pending();
    store.workspace.set({ ...store.workspace()! });
    fixture.detectChanges();
    expect(page.pending()).toBe(pending);
    await store.createWorkspace('Another school workspace', 'personal');
    fixture.detectChanges();
    expect(page.pending()).toBeUndefined();
    expect(page.student()).toBeUndefined();
    expect(page.form.controls.notes.value).toBe('');
  });
  it('does not apply a late success to the next workspace', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    let finish!: () => void;
    vi.spyOn(page.library, 'archive').mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const saving = page.archive(page.student()!);
    await store.createWorkspace('New workspace', 'personal');
    fixture.detectChanges();
    finish();
    await saving;
    expect(page.student()).toBeUndefined();
    expect(page.pending()).toBeUndefined();
    expect(TestBed.inject(UiService).notify).not.toHaveBeenCalledWith('Student archived');
  });
  it('gives viewers read access and disables managing students, fees and payments', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    await fee(page);
    const auth = TestBed.inject(AuthService),
      user = store.profile()!.id;
    auth.demo.set(false);
    auth.user.set({ id: user } as NonNullable<ReturnType<typeof auth.user>>);
    store.members.set([{ workspace_id: store.workspace()!.id, user_id: user, role: 'viewer' }]);
    fixture.detectChanges();
    page.selectedId.set(store.educationStudents()[0].id);
    expect(page.student()).toBeDefined();
    expect(page.canManage()).toBe(false);
    page.startFee();
    expect(page.feeEditor()).toBe(false);
  });
});
