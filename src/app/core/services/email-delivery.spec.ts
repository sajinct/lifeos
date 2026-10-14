import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { EmailDeliveryService, defaultEmailPreferences } from './email-delivery';
import { EmailSettings } from '../../features/settings/email-settings';
import { UiService } from './ui';
import { createClient } from '@supabase/supabase-js';
import { Database } from '../models/domain';
describe('Email preferences and session isolation', () => {
  let store: LifeStore, email: EmailDeliveryService;
  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: UiService, useValue: { notify: vi.fn() } }],
    });
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    email = TestBed.inject(EmailDeliveryService);
    TestBed.tick();
  });
  it('defaults off, preserves personal opt-ins across workspace switches and clears them on sign-out', async () => {
    expect(email.preferences().daily_digest).toBe(false);
    await email.save({
      ...defaultEmailPreferences(),
      daily_digest: true,
      delivery_timezone: 'Asia/Kolkata',
    });
    await store.createWorkspace('Other workspace', 'personal');
    TestBed.tick();
    expect(email.preferences().daily_digest).toBe(true);
    expect(email.history()).toEqual([]);
    store.clear();
    TestBed.tick();
    expect(email.preferences().daily_digest).toBe(false);
    expect(email.available()).toBe(false);
  });
  it('validates timezones/schedules and permits opting out while the sender is unavailable', async () => {
    await expect(email.save({ ...defaultEmailPreferences(), delivery_hour: 24 })).rejects.toThrow(
      /schedule/,
    );
    await expect(
      email.save({ ...defaultEmailPreferences(), delivery_timezone: 'No/SuchZone' }),
    ).rejects.toThrow(/timezone/);
    email.available.set(false);
    await expect(email.save({ ...defaultEmailPreferences(), daily_digest: true })).rejects.toThrow(
      /unavailable/,
    );
    email.available.set(true);
    await email.save({ ...defaultEmailPreferences(), daily_digest: true, weekly_digest: true });
    email.available.set(false);
    await email.save({ ...email.preferences(), daily_digest: false });
    expect(email.preferences().weekly_digest).toBe(true);
  });
  it('ignores late private preference and history loads after a session reset', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user', email: 'demo@example.test' } as never);
    let finish!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      maybeSingle: () => pending,
      limit: () => pending,
    };
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      from: () => chain,
      rpc: () => pending,
    } as never);
    const loading = email.load();
    store.clear();
    TestBed.tick();
    finish({ data: { ...defaultEmailPreferences(), daily_digest: true }, error: null });
    await loading;
    expect(email.preferences().daily_digest).toBe(false);
    expect(email.history()).toEqual([]);
    expect(email.error()).toBe('');
  });
  it('renders separate opt-ins, saves demo preferences and never requests a send from the browser', async () => {
    const fixture = TestBed.createComponent(EmailSettings);
    fixture.detectChanges();
    fixture.componentInstance.form.patchValue({
      daily_digest: true,
      weekly_digest: true,
      finance_frequency: 'weekly',
      delivery_timezone: 'Asia/Kolkata',
    });
    await fixture.componentInstance.save();
    fixture.detectChanges();
    expect(email.preferences()).toMatchObject({
      daily_digest: true,
      weekly_digest: true,
      finance_frequency: 'weekly',
    });
    expect(fixture.nativeElement.textContent).toContain('No emails are sent');
    expect(fixture.nativeElement.textContent).toContain('Accepted means Resend accepted');
    expect(
      fixture.nativeElement.querySelector('input[formcontrolname="daily_digest"]').checked,
    ).toBe(true);
  });
  it('requests one cloud preference row and preserves the saved state when history refresh fails', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    const prefs = {
      ...defaultEmailPreferences(),
      owner_id: 'demo-user',
      daily_digest: true,
      revision: 1,
    };
    const transport = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const single =
        new Headers(init?.headers).get('Accept') === 'application/vnd.pgrst.object+json';
      return new Response(JSON.stringify(single ? prefs : [prefs]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue(
      createClient<Database>('https://example.test', 'public-test-key', {
        global: { fetch: transport },
      }),
    );
    vi.spyOn(email, 'load').mockImplementation(async () => {
      email.error.set('History offline');
    });
    await email.save({ ...defaultEmailPreferences(), owner_id: 'forged-user', daily_digest: true });
    expect(email.preferences()).toEqual(prefs);
    expect(email.error()).toBe('History offline');
    expect(new Headers(transport.mock.calls[0][1]?.headers).get('Accept')).toBe(
      'application/vnd.pgrst.object+json',
    );
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).not.toHaveProperty('owner_id');
  });
});
