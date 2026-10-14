import { Component, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { EmailDeliveryService } from '../../core/services/email-delivery';
import { UiService } from '../../core/services/ui';
@Component({
  selector: 'app-email-settings',
  imports: [ReactiveFormsModule, DatePipe],
  template: `<section class="panel settings-panel">
    <h2>Email reminders & summaries</h2>
    <p>
      Choose what reaches your inbox. These account preferences apply across workspaces; each
      message contains only your own records from one workspace.
    </p>
    @if (email.store.auth.demo()) {
      <p class="form-hint">Demo settings stay in this session. No emails are sent.</p>
    } @else {
      <p class="form-hint">
        Sent to your verified account email: {{ email.store.auth.user()?.email }}
      </p>
    }
    @if (!email.available() && !email.loading()) {
      <p class="form-hint">
        The email sender is temporarily unavailable. Enabled preferences will resume when it is
        ready.
      </p>
    }
    <form [formGroup]="form" (ngSubmit)="save()">
      <label class="reminder-toggle"
        ><input type="checkbox" formControlName="reminder_emails" />Email task, bill, card
        statement, subscription and document reminders</label
      >
      <p class="form-hint">
        Enable the corresponding in-app reminders above first. Only new eligible notices are
        emailed. Read, dismissed, completed or cancelled notices stop queued mail; snoozed notices
        wait. Health and medication alerts stay in-app.
      </p>
      <label class="reminder-toggle"
        ><input type="checkbox" formControlName="daily_digest" />Daily overview of your open tasks
        and events</label
      >
      <label class="reminder-toggle"
        ><input type="checkbox" formControlName="weekly_digest" />Weekly planning for your open
        tasks and upcoming events</label
      >
      <label
        >Financial summary<select formControlName="finance_frequency">
          <option value="off">Off</option>
          <option value="weekly">Previous 7 days</option>
          <option value="monthly">Previous calendar month</option>
        </select></label
      >
      <p class="form-hint">
        Financial summaries include income, expenses and net totals separately for each currency.
        Transfers are excluded. Daily and weekly overviews list up to 20 tasks and 20 events.
      </p>
      <div class="form-grid">
        <label
          >Summary delivery hour<select formControlName="delivery_hour">
            @for (hour of hours; track hour) {
              <option [ngValue]="hour">{{ hour.toString().padStart(2, '0') }}:00</option>
            }
          </select></label
        ><label
          >Weekly delivery day<select formControlName="weekly_day">
            @for (day of days; track $index) {
              <option [ngValue]="$index">{{ day }}</option>
            }
          </select></label
        >
      </div>
      <label
        >Email summary timezone<input
          formControlName="delivery_timezone"
          maxlength="100"
          placeholder="Asia/Kolkata"
      /></label>
      <p class="form-hint">
        Summaries are checked every five minutes after this local hour. Weekly summaries use the
        selected day; monthly financial summaries use the first day of the month. Reminder emails
        follow their in-app timing. Missed prior days are not backfilled.
      </p>
      <p class="form-hint">
        Turning a preference off stops queued messages. Messages already being sent may still
        arrive. Manage these opt-ins here at any time.
      </p>
      @if (error() || email.error()) {
        <p class="error-banner" role="alert">{{ error() || email.error() }}</p>
      }
      <button class="button primary" type="submit" [disabled]="busy() || email.loading()">
        {{ busy() ? 'Saving…' : 'Save email preferences' }}
      </button>
      <button
        class="button subtle"
        type="button"
        (click)="email.load()"
        [disabled]="busy() || email.loading()"
      >
        Refresh email status
      </button>
    </form>
    <h3>Your email history in this workspace</h3>
    <p class="form-hint">
      Latest 50 messages. Accepted means Resend accepted the message; it does not confirm inbox
      delivery. Uncertain means sending stopped to avoid a possible duplicate.
    </p>
    @if (!email.history().length) {
      <p class="empty-state">No email deliveries recorded.</p>
    } @else {
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Message</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            @for (row of email.history(); track row.id) {
              <tr>
                <td>{{ labels[row.kind] }}</td>
                <td>
                  {{ row.status }}
                  @if (row.error_code) {
                    <small>{{ row.error_code }}</small>
                  }
                </td>
                <td>{{ row.attempts }}</td>
                <td>{{ row.created_at | date: 'medium' }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  </section>`,
})
export class EmailSettings {
  readonly email = inject(EmailDeliveryService);
  readonly ui = inject(UiService);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly hours = Array.from({ length: 24 }, (_, i) => i);
  readonly days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  readonly labels = {
    reminder: 'Reminder',
    daily: 'Daily overview',
    weekly: 'Weekly planning',
    financial: 'Financial summary',
  };
  readonly form = inject(FormBuilder).nonNullable.group({
    reminder_emails: false,
    daily_digest: false,
    weekly_digest: false,
    finance_frequency: 'off' as 'off' | 'weekly' | 'monthly',
    delivery_hour: [9, [Validators.required, Validators.min(0), Validators.max(23)]],
    weekly_day: [1, [Validators.required, Validators.min(0), Validators.max(6)]],
    delivery_timezone: ['UTC', [Validators.required, Validators.maxLength(100)]],
  });
  private revision = 0;
  private version = 0;
  constructor() {
    effect(() => {
      const p = this.email.preferences();
      this.revision = p.revision;
      this.form.patchValue(p, { emitEvent: false });
    });
    effect(() => {
      this.email.store.workspace();
      this.email.store.fileSession();
      this.version++;
      this.busy.set(false);
      this.error.set('');
    });
  }
  async save() {
    if (this.busy()) return;
    if (this.form.invalid) {
      this.error.set('Check the summary schedule and timezone.');
      return;
    }
    const version = this.version;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.email.save({
        ...this.email.preferences(),
        ...this.form.getRawValue(),
        revision: this.revision,
        delivery_timezone: this.form.controls.delivery_timezone.value.trim(),
      });
      if (version === this.version)
        this.ui.notify(
          this.email.store.auth.demo()
            ? 'Demo email preferences saved; no mail sent'
            : 'Email preferences saved',
        );
    } catch (e) {
      if (version === this.version) this.error.set(this.email.store.message(e));
    } finally {
      if (version === this.version) this.busy.set(false);
    }
  }
}
