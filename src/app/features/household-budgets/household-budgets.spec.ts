import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { HouseholdBudgetsPage } from './household-budgets';
describe('Household budget page and private contribution drafts', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UiService, useValue: { notify: vi.fn() } }],
    });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(HouseholdBudgetsPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  async function create(page: HouseholdBudgetsPage) {
    page.create();
    page.form.patchValue({
      category: 'Groceries',
      month: '2026-01',
      currency: 'INR',
      amount: '100',
      notes: '<script>literal</script>',
    });
    await page.save();
  }
  async function publish(page: HouseholdBudgetsPage, store: LifeStore) {
    const account = store.accounts()[0];
    store.accounts.update((rows) =>
      rows.map((a) => (a.id === account.id ? { ...a, currency: 'INR' } : a)),
    );
    const tx = {
      ...store.transactions()[0],
      id: crypto.randomUUID(),
      owner_id: store.profile()!.id,
      workspace_id: store.workspace()!.id,
      account_id: account.id,
      title: 'Private merchant',
      kind: 'expense' as const,
      amount: 120,
      booked_on: '2026-01-15',
    };
    store.transactions.update((rows) => [tx, ...rows]);
    page.startContribution(page.budget()!);
    page.contributionForm.patchValue({ expense: tx.id, notes: 'Explicit note' });
    await page.publish();
    return tx;
  }
  it('creates private monthly budgets and explicit overspending without leaking literal markup', async () => {
    const { page, store, fixture } = await setup();
    page.view.set('archived');
    page.search.set('hidden');
    await create(page);
    await publish(page, store);
    fixture.detectChanges();
    expect(page.rows()).toHaveLength(1);
    expect(page.totals()[0]).toMatchObject({ overspent: 20, spent: 120 });
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Jan 2026');
    expect(fixture.nativeElement.textContent).toContain('Jan 15, 2026');
  });
  it('filters over-limit budgets, withdraws and restores spending, and preserves archived histories', async () => {
    const { page, store } = await setup();
    await create(page);
    await publish(page, store);
    page.status.set('over');
    expect(page.rows()).toHaveLength(1);
    await page.withdraw(store.householdSpending()[0]);
    expect(page.rows()).toHaveLength(0);
    page.spendingView.set('withdrawn');
    expect(page.spending()).toHaveLength(1);
    page.startContribution(page.budget()!, store.householdSpending()[0]);
    await page.publish();
    expect(page.spending()).toHaveLength(1);
    await page.archive(page.budget()!);
    expect(page.canPublish(page.budget()!)).toBe(false);
    await page.archive(page.budget()!);
    expect(store.householdSpending()[0].withdrawn).toBe(false);
  });
  it('freezes failed contribution retries even after draft inputs are edited', async () => {
    const { page, store } = await setup();
    await create(page);
    const mock = vi
      .spyOn(page.library, 'publish')
      .mockRejectedValueOnce(new Error('Network failed'));
    await publish(page, store);
    expect(page.pending()).toBeDefined();
    page.contributionForm.controls.notes.setValue('Changed after failure');
    await page.retry();
    expect(mock.mock.calls[1]).toEqual(mock.mock.calls[0]);
    expect(store.householdSpending()[0].notes).toBe('Explicit note');
  });
  it('retains the parent revision from the start of a contribution draft after sharing changes', async () => {
    const { page, store } = await setup();
    await create(page);
    const tx = await publish(page, store);
    await page.withdraw(store.householdSpending()[0]);
    page.startContribution(page.budget()!, store.householdSpending()[0]);
    store.householdBudgets.update((rows) =>
      rows.map((b) => ({ ...b, visibility: 'workspace', revision: b.revision + 1 })),
    );
    page.contributionForm.controls.expense.setValue(tx.id);
    await page.publish();
    expect(page.error()).toContain('budget changed');
    expect(store.householdSpending()[0].withdrawn).toBe(true);
  });
  it('clears private drafts on workspace changes but preserves same-workspace pending retries', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    vi.spyOn(page.library, 'archive').mockRejectedValue(new Error('Refresh failed'));
    await page.archive(page.budget()!);
    const pending = page.pending();
    store.workspace.set({ ...store.workspace()! });
    fixture.detectChanges();
    expect(page.pending()).toBe(pending);
    await store.createWorkspace('Another budget workspace', 'family');
    fixture.detectChanges();
    expect(page.pending()).toBeUndefined();
    expect(page.budget()).toBeUndefined();
    expect(page.form.controls.notes.value).toBe('');
  });
  it('disables publication and withdrawal for viewer roles', async () => {
    const { page, store, fixture } = await setup();
    await create(page);
    await publish(page, store);
    const auth = TestBed.inject(AuthService),
      user = store.profile()!.id;
    auth.demo.set(false);
    auth.user.set({ id: user } as NonNullable<ReturnType<typeof auth.user>>);
    store.members.set([{ workspace_id: store.workspace()!.id, user_id: user, role: 'viewer' }]);
    fixture.detectChanges();
    page.selectedId.set(store.householdBudgets()[0].id);
    expect(page.canPublish(page.budget()!)).toBe(false);
    await page.withdraw(store.householdSpending()[0]);
    expect(store.householdSpending()[0].withdrawn).toBe(false);
  });
});
