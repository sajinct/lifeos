import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { EmailPreferences, EmailDelivery } from '../models/domain';
export const defaultEmailPreferences = (): EmailPreferences => ({
  owner_id: '',
  reminder_emails: false,
  daily_digest: false,
  weekly_digest: false,
  finance_frequency: 'off',
  delivery_hour: 9,
  weekly_day: 1,
  delivery_timezone: 'UTC',
  revision: 0,
});
@Injectable({ providedIn: 'root' })
export class EmailDeliveryService {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  readonly preferences = signal(defaultEmailPreferences());
  readonly history = signal<EmailDelivery[]>([]);
  readonly available = signal(false);
  readonly loading = signal(false);
  readonly error = signal('');
  private generation = 0;
  private stamp = '';
  constructor() {
    effect(() => {
      const user = this.store.profile()?.id,
        workspace = this.store.workspace()?.id,
        session = this.store.fileSession();
      untracked(() => {
        const stamp = `${user}:${session}`;
        if (stamp !== this.stamp) {
          this.preferences.set(defaultEmailPreferences());
          this.available.set(false);
          this.stamp = stamp;
        }
        this.history.set([]);
        this.error.set('');
        this.generation++;
        if (user && workspace) void this.load();
      });
    });
  }
  private context() {
    const user = this.store.profile()?.id,
      workspace = this.store.workspace()?.id,
      session = this.store.fileSession();
    if (!user || !workspace || (!this.store.auth.demo() && this.store.auth.user()?.id !== user))
      throw new Error('Sign in and select a workspace.');
    return { user, workspace, session };
  }
  private current(c: ReturnType<EmailDeliveryService['context']>) {
    return (
      c.user === this.store.profile()?.id &&
      c.workspace === this.store.workspace()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || c.user === this.store.auth.user()?.id)
    );
  }
  async load() {
    const run = ++this.generation;
    this.loading.set(true);
    try {
      const c = this.context();
      if (this.store.auth.demo()) {
        this.available.set(true);
        return;
      }
      const client = this.backend.requireClient();
      const [prefs, ready, history] = await Promise.all([
        client.from('email_preferences').select('*').eq('owner_id', c.user).maybeSingle(),
        client.rpc('email_delivery_available'),
        client
          .from('email_deliveries')
          .select('id,workspace_id,owner_id,kind,status,attempts,accepted_at,error_code,created_at')
          .eq('workspace_id', c.workspace)
          .eq('owner_id', c.user)
          .order('created_at', { ascending: false })
          .order('id')
          .limit(50),
      ]);
      if (prefs.error) throw prefs.error;
      if (ready.error) throw ready.error;
      if (history.error) throw history.error;
      if (run !== this.generation || !this.current(c)) return;
      this.preferences.set(prefs.data ?? { ...defaultEmailPreferences(), owner_id: c.user });
      this.available.set(ready.data === true);
      this.history.set(history.data);
      this.error.set('');
    } catch (e) {
      if (run === this.generation) this.error.set(this.store.message(e));
    } finally {
      if (run === this.generation) this.loading.set(false);
    }
  }
  async save(input: EmailPreferences) {
    const c = this.context();
    if (
      !Number.isInteger(input.delivery_hour) ||
      input.delivery_hour < 0 ||
      input.delivery_hour > 23 ||
      !Number.isInteger(input.weekly_day) ||
      input.weekly_day < 0 ||
      input.weekly_day > 6 ||
      !['off', 'weekly', 'monthly'].includes(input.finance_frequency)
    )
      throw new Error('Check email schedule.');
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.delivery_timezone }).format();
    } catch {
      throw new Error('Choose a valid IANA timezone.');
    }
    const previous = this.preferences();
    if (
      !this.available() &&
      ((input.reminder_emails && !previous.reminder_emails) ||
        (input.daily_digest && !previous.daily_digest) ||
        (input.weekly_digest && !previous.weekly_digest) ||
        (input.finance_frequency !== 'off' &&
          input.finance_frequency !== previous.finance_frequency))
    )
      throw new Error('Email sender is unavailable.');
    if (this.store.auth.demo()) {
      this.preferences.set({
        ...input,
        owner_id: c.user,
        revision: this.preferences().revision + 1,
      });
      return;
    }
    const { data, error } = await this.backend.requireClient().rpc('save_email_preferences', {
      expected_revision: input.revision,
      reminders_enabled: input.reminder_emails,
      daily_enabled: input.daily_digest,
      weekly_enabled: input.weekly_digest,
      finance_schedule: input.finance_frequency,
      hour: input.delivery_hour,
      weekday: input.weekly_day,
      timezone: input.delivery_timezone.trim(),
    });
    if (error) throw error;
    if (this.current(c)) {
      this.preferences.set(data);
      await this.load();
    }
  }
}
