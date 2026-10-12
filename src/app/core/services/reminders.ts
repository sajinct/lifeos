import { Injectable, inject, signal, computed, effect, untracked, DestroyRef } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { Notification, ReminderPreferences } from '../models/domain';
import {
  notificationVisible,
  reminderClock,
  reminderPhase,
  reminderSources,
  reminderTitle,
} from '../../shared/utilities/reminders';

@Injectable({ providedIn: 'root' })
export class Reminders {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  readonly now = signal(Date.now());
  readonly busy = signal(false);
  readonly error = signal('');
  readonly visible = computed(() =>
    this.store.notifications().filter((n) => notificationVisible(n, this.now())),
  );
  readonly unread = computed(() => this.visible().some((n) => !n.read_at));
  private refreshing = false;
  constructor() {
    effect(() => {
      this.store.fileSession();
      this.store.workspace();
      this.error.set('');
    });
    effect(() => {
      const demo = this.store.auth.demo();
      const sources = reminderSources(
        this.store.reminderPreferences(),
        this.store.tasks(),
        this.store.bills(),
        this.store.attachments(),
        this.store.subscriptions(),
        this.store.loans(),
        this.store.contacts(),
      );
      const prefs = this.store.reminderPreferences();
      const workspace = this.store.workspace();
      const now = this.now();
      if (demo && workspace) untracked(() => this.reconcileDemo(sources, prefs, now));
    });
    const timer = setInterval(() => {
      this.now.set(Date.now());
      if (typeof document === 'undefined' || document.visibilityState === 'visible')
        void this.refresh();
    }, 60000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  private reconcileDemo(
    sources: ReturnType<typeof reminderSources>,
    p: ReminderPreferences,
    now: number,
  ) {
    const clock = reminderClock(new Date(now), p.reminder_timezone);
    const existing = this.store.notifications();
    const list = existing.map((n) =>
      n.source_kind &&
      !n.dismissed_at &&
      !sources.some(
        (s) => s.id === n.source_id && s.kind === n.source_kind && s.date === n.occurrence_on,
      )
        ? { ...n, dismissed_at: new Date(now).toISOString(), snoozed_until: null }
        : n,
    );
    if (clock.hour >= p.reminder_hour)
      for (const s of sources) {
        if (s.owner_id !== 'demo-user') continue;
        const phase = reminderPhase(s, clock.day);
        if (
          !phase ||
          list.some(
            (n) =>
              n.source_kind === s.kind &&
              n.source_id === s.id &&
              n.occurrence_on === s.date &&
              n.phase === phase,
          )
        )
          continue;
        const time = new Date(now).toISOString();
        list.unshift({
          id: crypto.randomUUID(),
          workspace_id: s.workspace_id,
          owner_id: s.owner_id,
          visibility: 'private',
          created_at: time,
          updated_at: time,
          title: reminderTitle(s, phase),
          reminder_id: null,
          read_at: null,
          source_kind: s.kind,
          source_id: s.id,
          occurrence_on: s.date,
          phase,
          dismissed_at: null,
          snoozed_until: null,
        });
      }
    if (JSON.stringify(existing) !== JSON.stringify(list)) this.store.notifications.set(list);
  }
  async refresh() {
    this.now.set(Date.now());
    if (
      this.store.auth.demo() ||
      !this.store.auth.user() ||
      !this.store.workspace() ||
      this.refreshing
    )
      return;
    const workspace = this.store.workspace()!.id;
    const user = this.store.auth.user()!.id;
    const session = this.store.fileSession();
    this.refreshing = true;
    try {
      const { data, error } = await this.backend
        .requireClient()
        .from('notifications')
        .select('*')
        .eq('workspace_id', workspace)
        .is('dismissed_at', null)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      if (
        workspace === this.store.workspace()?.id &&
        user === this.store.auth.user()?.id &&
        session === this.store.fileSession()
      ) {
        this.store.notifications.set(data);
        this.error.set('');
      }
    } catch (e) {
      if (
        workspace === this.store.workspace()?.id &&
        user === this.store.auth.user()?.id &&
        session === this.store.fileSession()
      )
        this.error.set(this.store.message(e));
    } finally {
      this.refreshing = false;
    }
  }
  async save(p: ReminderPreferences) {
    reminderClock(new Date(), p.reminder_timezone);
    for (const [value, max] of [
      [p.task_lead_days, 30],
      [p.bill_lead_days, 30],
      [p.document_lead_days, 90],
      [p.subscription_lead_days, 90],
      [p.loan_lead_days, 90],
      [p.contact_lead_days, 90],
      [p.reminder_hour, 23],
    ])
      if (!Number.isInteger(value) || value < 0 || value > max)
        throw new Error('Check reminder timing values.');
    const user = this.store.profile()?.id;
    const session = this.store.fileSession();
    const authUser = this.store.auth.user()?.id;
    if (!user || (!this.store.auth.demo() && authUser !== user)) throw new Error('Sign in first.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_reminder_preferences', {
        tasks_enabled: p.task_reminders,
        bills_enabled: p.bill_reminders,
        documents_enabled: p.document_reminders,
        task_days: p.task_lead_days,
        bill_days: p.bill_lead_days,
        document_days: p.document_lead_days,
        delivery_hour: p.reminder_hour,
        delivery_timezone: p.reminder_timezone,
        subscriptions_enabled: p.subscription_reminders,
        subscription_days: p.subscription_lead_days,
        loans_enabled: p.loan_reminders,
        loan_days: p.loan_lead_days,
        contacts_enabled: p.contact_reminders,
        contact_days: p.contact_lead_days,
      });
      if (error) throw error;
    }
    if (
      user === this.store.profile()?.id &&
      session === this.store.fileSession() &&
      authUser === this.store.auth.user()?.id
    )
      this.store.reminderPreferences.set({ ...p });
    await this.refresh();
  }
  async resolveSource(n: Notification) {
    if (!n.source_kind || !n.source_id) return false;
    if (this.store.auth.demo()) return true;
    const workspace = this.store.workspace()?.id;
    const user = this.store.auth.user()?.id;
    const session = this.store.fileSession();
    if (!workspace || !user || n.workspace_id !== workspace || n.owner_id !== user) return false;
    this.busy.set(true);
    this.error.set('');
    try {
      const c = this.backend.requireClient();
      // Fetch the exact source even when it falls outside a screen's newest-500 window.
      const table =
        n.source_kind === 'task'
          ? 'tasks'
          : n.source_kind === 'bill'
            ? 'bills'
            : n.source_kind === 'document'
              ? 'attachments'
              : n.source_kind === 'loan'
                ? 'loans'
                : n.source_kind === 'contact'
                  ? 'contacts'
                  : 'subscriptions';
      const { data, error } = await c
        .from(table)
        .select('*')
        .eq('workspace_id', workspace)
        .eq('owner_id', user)
        .eq('id', n.source_id)
        .maybeSingle();
      if (error) throw error;
      if (
        workspace !== this.store.workspace()?.id ||
        user !== this.store.auth.user()?.id ||
        session !== this.store.fileSession()
      )
        return false;
      if (!data)
        throw new Error('This record is no longer available. You can dismiss its reminder.');
      if (table === 'tasks' && 'due_date' in data)
        this.store.tasks.update((rows) => [...rows.filter((r) => r.id !== data.id), data]);
      else if (table === 'bills' && 'due_on' in data)
        this.store.bills.update((rows) => [...rows.filter((r) => r.id !== data.id), data]);
      else if ('object_path' in data)
        this.store.attachments.update((rows) => [...rows.filter((r) => r.id !== data.id), data]);
      else if ('next_follow_up' in data)
        this.store.contacts.update((rows) => [...rows.filter((r) => r.id !== data.id), data]);
      else if ('principal_paid' in data)
        this.store.loans.update((rows) => [...rows.filter((r) => r.id !== data.id), data]);
      else if ('anchor_on' in data)
        this.store.subscriptions.update((rows) => [...rows.filter((r) => r.id !== data.id), data]);
      return true;
    } catch (e) {
      if (
        workspace === this.store.workspace()?.id &&
        user === this.store.auth.user()?.id &&
        session === this.store.fileSession()
      )
        this.error.set(this.store.message(e));
      return false;
    } finally {
      this.busy.set(false);
    }
  }
  async act(n: Notification, action: 'read' | 'dismiss' | 'snooze', minutes = 60) {
    if (this.busy()) return;
    if (action === 'snooze' && ![60, 1440].includes(minutes))
      throw new Error('Choose one hour or one day.');
    const workspace = this.store.workspace()?.id;
    const session = this.store.fileSession();
    const user = this.store.auth.user()?.id;
    if (n.workspace_id !== workspace || n.owner_id !== this.store.profile()?.id)
      throw new Error('Notification is inaccessible.');
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.store.auth.demo() && action === 'snooze') {
        const current = this.store.notifications().find((row) => row.id === n.id);
        if (!current || current.dismissed_at) throw new Error('Notification was dismissed.');
      }
      if (!this.store.auth.demo()) {
        const { error } = await this.backend
          .requireClient()
          .rpc('act_on_notification', { notice: n.id, action, snooze_minutes: minutes });
        if (error) throw error;
      }
      const now = Date.now();
      if (
        workspace === this.store.workspace()?.id &&
        session === this.store.fileSession() &&
        user === this.store.auth.user()?.id
      )
        this.store.notifications.update((list) =>
          list.map((row) =>
            row.id !== n.id
              ? row
              : {
                  ...row,
                  read_at:
                    action === 'read'
                      ? new Date(now).toISOString()
                      : action === 'snooze'
                        ? null
                        : row.read_at,
                  dismissed_at:
                    action === 'dismiss' ? new Date(now).toISOString() : row.dismissed_at,
                  snoozed_until:
                    action === 'snooze'
                      ? new Date(now + minutes * 60000).toISOString()
                      : action === 'dismiss'
                        ? null
                        : row.snoozed_until,
                },
          ),
        );
      this.now.set(now);
    } catch (e) {
      if (
        workspace === this.store.workspace()?.id &&
        session === this.store.fileSession() &&
        user === this.store.auth.user()?.id
      )
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  path(n: Notification) {
    return n.source_kind === 'task'
      ? '/tasks'
      : n.source_kind === 'bill'
        ? '/finance'
        : n.source_kind === 'document'
          ? '/documents'
          : n.source_kind === 'loan'
            ? '/loans'
            : n.source_kind === 'contact'
              ? '/contacts'
              : '/subscriptions';
  }
}
