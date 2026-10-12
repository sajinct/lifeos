import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { SubscriptionLibrary } from './subscriptions';
import { Reminders } from './reminders';
import { DEFAULT_REMINDERS, Subscription, SubscriptionInput } from '../models/domain';
import { subscriptionTotals, validateSubscription } from '../../shared/utilities/subscriptions';
import { Backend } from '../supabase/client';
import { User } from '@supabase/supabase-js';
describe('Subscription tracking and expense lifecycle', () => {
  let store: LifeStore, library: SubscriptionLibrary;
  let input: SubscriptionInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(SubscriptionLibrary);
    input = {
      title: 'Sample music',
      amount: '120',
      currency: 'INR',
      frequency: 'monthly',
      next_on: library.today(),
      status: 'active',
      trial_ends_on: '',
      category: 'Music',
      provider_url: '',
      notes: '',
      link_mode: 'track',
      account_id: 'a1',
      recurring_id: '',
      automatic: false,
    };
  });
  it('normalizes estimates by currency, excludes trials/cancellations and validates safe input', async () => {
    await library.save(crypto.randomUUID(), input);
    const base = store.subscriptions()[0];
    const rows: Subscription[] = [
      base,
      { ...base, id: 'yearly', amount: 120, frequency: 'yearly' },
      { ...base, id: 'usd', amount: 10, currency: 'USD' },
      { ...base, id: 'trial', amount: 100000, status: 'trial' },
      { ...base, id: 'cancelled', amount: 100000, status: 'cancelled' },
    ];
    expect(subscriptionTotals(rows)).toEqual([
      { currency: 'INR', annual: 1560, monthly: 130 },
      { currency: 'USD', annual: 120, monthly: 10 },
    ]);
    expect(validateSubscription({ ...input, amount: '0' })).toBe(0);
    for (const patch of [
      { amount: '1.001' },
      { provider_url: 'javascript:alert(1)' },
      { provider_url: 'https://user:password@example.com' },
      { next_on: '2026-02-30' },
    ])
      expect(() => validateSubscription({ ...input, ...patch })).toThrow();
  });
  it('creates and posts one schedule, preserves history on cancellation and blocks resume', async () => {
    const id = crypto.randomUUID(),
      v = { ...input, link_mode: 'create' as const, automatic: true };
    await library.save(id, v);
    await library.save(id, v);
    const row = store.subscriptions()[0];
    expect(store.subscriptions()).toHaveLength(1);
    expect(store.recurring().filter((r) => r.id === row.recurring_id)).toHaveLength(1);
    expect(await library.post(row)).toBe(1);
    expect(await library.post(row)).toBe(0);
    expect(store.subscriptions()[0].next_on > input.next_on).toBe(true);
    await library.cancel(store.subscriptions()[0]);
    const plan = store.recurring().find((r) => r.id === row.recurring_id)!;
    expect(plan.active).toBe(false);
    expect(plan.automatic).toBe(false);
    expect(await library.post(store.subscriptions()[0])).toBe(0);
    await expect(store.setRecurringActive(plan)).rejects.toThrow(/cancelled/);
    expect(store.transactions().filter((t) => t.recurring_id === plan.id)).toHaveLength(1);
  });
  it('keeps trial schedules paused and transitions from trial alerts to renewal alerts', async () => {
    const reminders = TestBed.inject(Reminders);
    await reminders.save({
      ...DEFAULT_REMINDERS,
      subscription_reminders: true,
      subscription_lead_days: 90,
      reminder_hour: 0,
    });
    const id = crypto.randomUUID();
    await library.save(id, {
      ...input,
      status: 'trial',
      trial_ends_on: input.next_on,
      link_mode: 'create',
      automatic: true,
    });
    TestBed.tick();
    const trial = store.subscriptions()[0],
      old = trial.recurring_id;
    expect(store.recurring().find((r) => r.id === old)?.active).toBe(false);
    expect(reminders.visible().some((n) => n.source_kind === 'trial')).toBe(true);
    await library.save(id, { ...input, link_mode: 'create' }, trial);
    TestBed.tick();
    expect(store.subscriptions()[0].recurring_id).not.toBe(old);
    expect(reminders.visible().some((n) => n.source_kind === 'trial')).toBe(false);
    expect(reminders.visible().some((n) => n.source_kind === 'subscription')).toBe(true);
    expect(store.recurring().find((r) => r.id === old)?.active).toBe(false);
  });
  it('preserves month-end anchors and makes a repeated renewal acknowledgement harmless', async () => {
    const anchor = '2025-01-31';
    await library.save(crypto.randomUUID(), { ...input, next_on: anchor });
    const original = store.subscriptions()[0];
    await library.advance(original);
    await library.advance(original);
    expect(store.subscriptions()[0].next_on).toBe(anchor.slice(0, 4) + '-02-28');
    await library.advance(store.subscriptions()[0]);
    expect(store.subscriptions()[0].next_on).toBe(anchor.slice(0, 4) + '-03-31');
  });
  it('uses the existing expense price and prevents a second link, then pauses on disconnect', async () => {
    const plan = store.recurring()[0];
    await library.save(crypto.randomUUID(), {
      ...input,
      link_mode: 'existing',
      recurring_id: plan.id,
    });
    const row = store.subscriptions()[0];
    expect(row.amount).toBe(plan.amount);
    await expect(
      library.save(crypto.randomUUID(), { ...input, link_mode: 'existing', recurring_id: plan.id }),
    ).rejects.toThrow(/already belongs/);
    await library.save(row.id, input, row);
    expect(store.recurring().find((r) => r.id === plan.id)?.active).toBe(false);
  });
  it('keeps subscription records within their workspace and clears them at logout', async () => {
    await library.save(crypto.randomUUID(), input);
    const workspace = store.workspace()!,
      row = store.subscriptions()[0];
    await store.createWorkspace('Other', 'personal');
    expect(store.subscriptions()).toEqual([]);
    await expect(library.cancel(row)).rejects.toThrow(/inaccessible/);
    await store.switchWorkspace(workspace);
    expect(store.subscriptions()).toHaveLength(1);
    store.clear();
    expect(store.subscriptions()).toEqual([]);
  });
});
describe('Subscription requests across session boundaries', () => {
  it('does not reload private records after the user leaves during a save', async () => {
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: Backend, useValue: { requireClient: () => ({ rpc: () => pending }) } },
      ],
    });
    const auth = TestBed.inject(AuthService);
    auth.demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const library = TestBed.inject(SubscriptionLibrary);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    const operation = library.save(crypto.randomUUID(), {
      title: 'Private name',
      amount: '1',
      currency: 'INR',
      frequency: 'monthly',
      next_on: library.today(),
      status: 'active',
      trial_ends_on: '',
      category: 'Other',
      provider_url: '',
      notes: '',
      link_mode: 'track',
      account_id: '',
      recurring_id: '',
      automatic: false,
    });
    store.clear();
    complete({ error: null });
    await operation;
    expect(store.subscriptions()).toEqual([]);
    expect(store.workspace()).toBeNull();
  });
});
