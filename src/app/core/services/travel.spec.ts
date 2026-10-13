import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { TravelLibrary } from './travel';
import { TravelPlan, TravelPlanInput } from '../models/domain';
import {
  emptyTravelEntry,
  validateTravelPlan,
  validateTravelEntry,
  travelTotals,
  travelEntriesCsv,
} from '../../shared/utilities/travel';
describe('Private travel and event planning', () => {
  let store: LifeStore, library: TravelLibrary, p: TravelPlan;
  const input: TravelPlanInput = {
    kind: 'trip',
    title: 'Example trip',
    location: 'Example destination',
    starts_on: '2026-11-01',
    ends_on: '2026-11-05',
    timezone: 'Asia/Kolkata',
    status: 'planning',
    notes: '',
  };
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(TravelLibrary);
    await library.savePlan('plan', input);
    p = store.travelPlans()[0];
  });
  it('validates plan dates/zones and protects replay/revisions', async () => {
    for (const patch of [
      { title: '' },
      { ends_on: '2026-10-01' },
      { starts_on: '2026-02-30' },
      { timezone: 'Unknown/Zone' },
    ])
      expect(() => validateTravelPlan({ ...input, ...patch })).toThrow();
    await library.savePlan('plan', { ...input, title: 'Ignored' });
    expect(store.travelPlans()[0].title).toBe('Example trip');
    await library.savePlan('plan', { ...input, title: 'Changed' }, p);
    await expect(library.savePlan('plan', input, p)).rejects.toThrow(/changed/);
    await expect(
      library.savePlan('plan', { ...input, kind: 'event' }, store.travelPlans()[0]),
    ).rejects.toThrow(/kind/);
  });
  it('validates itinerary bounds, time ordering and booking precision', () => {
    const v = emptyTravelEntry('booking', p);
    for (const patch of [
      { date_on: '2026-10-31' },
      { date_on: '2026-11-06' },
      { time_at: '24:00' },
      { time_at: '12:00', end_time: '11:00' },
      { cost: '1.001', currency: 'INR' },
      { cost: 'NaN', currency: 'INR' },
      { cost: '100', currency: '' },
    ])
      expect(() => validateTravelEntry({ ...v, title: 'Booking', ...patch }, p)).toThrow();
    expect(
      validateTravelEntry({ ...v, title: 'Booking', cost: '0', currency: 'INR' }, p).cost,
    ).toBe(0);
  });
  it('keeps plan dates around archived entries and preserves booking state', async () => {
    const v = {
      ...emptyTravelEntry('booking', p),
      title: 'Hotel',
      cost: '5000',
      currency: 'INR',
      status: 'confirmed',
    };
    await library.saveEntry('booking', p, v);
    const old = store.travelEntries()[0];
    await library.saveEntry('booking', p, { ...v, title: 'Ignored' });
    await library.act(old, 'entry', 'archive');
    await expect(
      library.savePlan('plan', { ...input, starts_on: '2026-11-02' }, p),
    ).rejects.toThrow(/saved itinerary/);
    await library.act(store.travelEntries()[0], 'entry', 'restore');
    expect(store.travelEntries()[0].status).toBe('confirmed');
    await expect(library.act(store.travelEntries()[0], 'entry', 'complete')).rejects.toThrow(
      /Completion/,
    );
  });
  it('records guest party size/RSVP and escapes export contact labels', async () => {
    const v = {
      ...emptyTravelEntry('guest', p),
      title: '=Guest party',
      email: 'synthetic@example.com',
      guest_count: '2',
      status: 'accepted',
    };
    for (const patch of [
      { guest_count: '0' },
      { guest_count: '1.5' },
      { email: 'bad' },
      { date_on: '2026-11-01' },
    ])
      expect(() => validateTravelEntry({ ...v, ...patch }, p)).toThrow();
    await library.saveEntry('guest', p, v);
    expect(store.travelEntries()[0]).toMatchObject({ guest_count: 2, status: 'accepted' });
    const text = travelEntriesCsv(store.travelEntries());
    expect(text).toContain("'=Guest party");
    expect(text).toContain('synthetic@example.com');
  });
  it('keeps checklist completion independent and rejects stale reopening', async () => {
    await library.saveEntry('check', p, {
      ...emptyTravelEntry('checklist', p),
      title: 'Pack charger',
    });
    const old = store.travelEntries()[0];
    await library.act(old, 'entry', 'complete');
    await library.act(old, 'entry', 'complete');
    await expect(library.act(old, 'entry', 'reopen')).rejects.toThrow(/changed/);
    await library.act(store.travelEntries()[0], 'entry', 'archive');
    await library.act(store.travelEntries()[0], 'entry', 'restore');
    expect(store.travelEntries()[0].status).toBe('done');
    expect(store.travelPlans()[0].status).toBe('planning');
  });
  it('preserves unique budget currencies and rejects stale edits', async () => {
    await library.saveBudget('budget', p, 'INR', '10000');
    const old = store.travelBudgets()[0];
    await library.saveBudget('budget', p, 'INR', '20000');
    expect(store.travelBudgets()[0].amount).toBe(10000);
    await expect(library.saveBudget('duplicate', p, 'INR', '100')).rejects.toThrow(/exists/);
    await expect(library.saveBudget('budget', p, 'USD', '100', old)).rejects.toThrow(/immutable/);
    await library.saveBudget('budget', p, 'INR', '20000', old);
    await expect(library.act(old, 'budget', 'archive')).rejects.toThrow(/changed/);
  });
  it('links an expense once without changing balances and safely moves its archived attribution', async () => {
    const expense = store.transactions().find((t) => t.kind === 'expense')!,
      before = store.transactions();
    await library.saveExpense('link', p, expense.id, '');
    await library.saveExpense('link', p, expense.id, 'Ignored');
    await library.savePlan('other', { ...input, kind: 'event' });
    const other = store.travelPlans()[0];
    await expect(library.saveExpense('duplicate', other, expense.id, '')).rejects.toThrow(
      /already linked/,
    );
    await library.act(store.travelExpenses()[0], 'expense', 'archive');
    await library.saveExpense('moved', other, expense.id, '');
    await expect(
      library.act(
        store.travelExpenses().find((r) => r.id === 'link')!,
        'expense',
        'restore',
      ),
    ).rejects.toThrow(/active under/);
    expect(store.transactions()).toEqual(before);
  });
  it('uses cents and separate currencies and excludes booking quotes and other owners', async () => {
    const expense = store.transactions().find((t) => t.kind === 'expense')!,
      account = store.accounts().find((a) => a.id === expense.account_id)!;
    await library.saveBudget('inr', p, 'INR', '1');
    await library.saveBudget('usd', p, 'USD', '5');
    await library.saveExpense('link', p, expense.id, '');
    await library.saveEntry('booking', p, {
      ...emptyTravelEntry('booking', p),
      title: 'Quoted hotel',
      cost: '9999',
      currency: 'INR',
    });
    const transaction = { ...expense, amount: 0.3 };
    const totals = travelTotals(
      p,
      store.travelBudgets(),
      store.travelExpenses(),
      [transaction, { ...transaction, id: 'other', owner_id: 'other', amount: 5000 }],
      [{ ...account, currency: 'INR' }],
      store.profile()!.id,
    );
    expect(totals).toEqual([
      { currency: 'INR', planned: 1, spent: 0.3, remaining: 0.7 },
      { currency: 'USD', planned: 5, spent: 0, remaining: 5 },
    ]);
  });
  it('freezes closed/archived plan details and isolates workspace caches', async () => {
    await library.savePlan('plan', { ...input, status: 'completed' }, p);
    await expect(
      library.saveEntry('child', store.travelPlans()[0], {
        ...emptyTravelEntry('checklist', p),
        title: 'Pack',
      }),
    ).rejects.toThrow(/Reopen/);
    await library.saveBudget('budget', store.travelPlans()[0], 'INR', '100');
    await library.act(store.travelPlans()[0], 'plan', 'archive');
    await expect(library.saveBudget('other', store.travelPlans()[0], 'USD', '100')).rejects.toThrow(
      /Restore/,
    );
    await library.act(store.travelPlans()[0], 'plan', 'restore');
    expect(store.travelPlans()[0].status).toBe('completed');
    const original = store.workspace()!;
    await store.createWorkspace('Other', 'family');
    expect(store.travelPlans()).toHaveLength(0);
    await expect(library.saveBudget('wrong', p, 'INR', '100')).rejects.toThrow(/inaccessible/);
    await store.switchWorkspace(original);
    expect(store.travelPlans()).toHaveLength(1);
    store.clear();
    expect(store.travelPlans()).toHaveLength(0);
    expect(store.travelBudgets()).toHaveLength(0);
    expect(store.travelEntries()).toHaveLength(0);
    expect(store.travelExpenses()).toHaveLength(0);
  });
  it('does not reload late cloud travel saves after signout', async () => {
    const auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'demo-user' } as User);
    auth.demo.set(false);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace'),
      pending = library.savePlan('pending', input);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.travelPlans()).toHaveLength(0);
  });
});
