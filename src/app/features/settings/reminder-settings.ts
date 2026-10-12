import { Component, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Reminders } from '../../core/services/reminders';
import { UiService } from '../../core/services/ui';
@Component({
  selector: 'app-reminder-settings',
  imports: [ReactiveFormsModule],
  template: `<section class="panel settings-panel">
    <h2>Reminders</h2>
    <p>Choose what gets a gentle nudge. Your settings apply across your workspaces.</p>
    <form [formGroup]="form" (ngSubmit)="save()">
      <label class="reminder-toggle"
        ><input type="checkbox" formControlName="task_reminders" />Task due dates</label
      >
      <label
        >Task reminder lead time (days)<input
          type="number"
          formControlName="task_lead_days"
          min="0"
          max="30"
          step="1"
      /></label>
      <label class="reminder-toggle"
        ><input type="checkbox" formControlName="bill_reminders" />Upcoming and overdue bills</label
      >
      <label
        >Bill reminder lead time (days)<input
          type="number"
          formControlName="bill_lead_days"
          min="0"
          max="30"
          step="1"
      /></label>
      <label class="reminder-toggle"
        ><input type="checkbox" formControlName="document_reminders" />Document expiry dates</label
      >
      <label
        >Document reminder lead time (days)<input
          type="number"
          formControlName="document_lead_days"
          min="0"
          max="90"
          step="1"
      /></label>
      <div class="form-grid">
        <label class="reminder-toggle"
          ><input type="checkbox" formControlName="subscription_reminders" />Subscription renewals
          and trials</label
        >
        <label
          >Subscription reminder lead time (days)<input
            type="number"
            formControlName="subscription_lead_days"
            min="0"
            max="90"
            step="1"
        /></label>
      </div>
      <div class="form-grid">
        <label class="reminder-toggle"
          ><input type="checkbox" formControlName="loan_reminders" />Loan repayments</label
        >
        <label
          >Loan reminder lead time (days)<input
            type="number"
            formControlName="loan_lead_days"
            min="0"
            max="90"
            step="1"
        /></label>
      </div>
      <div class="form-grid">
        <label class="reminder-toggle"
          ><input type="checkbox" formControlName="contact_reminders" />Contact follow-ups</label
        >
        <label
          >Contact reminder lead time (days)<input
            type="number"
            formControlName="contact_lead_days"
            min="0"
            max="90"
            step="1"
        /></label>
      </div>
      <div class="form-grid">
        <label
          >Daily delivery hour<select formControlName="reminder_hour">
            @for (hour of hours; track hour) {
              <option [ngValue]="hour">{{ hour.toString().padStart(2, '0') }}:00</option>
            }
          </select></label
        >
        <label
          >Reminder time zone<input
            formControlName="reminder_timezone"
            list="reminder-timezones"
            maxlength="100"
            placeholder="Asia/Kolkata"
        /></label>
      </div>
      <datalist id="reminder-timezones">
        @for (zone of zones; track zone) {
          <option [value]="zone"></option>
        }
      </datalist>
      <p class="form-hint">
        In-app delivery is checked every five minutes after your chosen local hour. You receive one
        upcoming reminder and one overdue reminder per due date. Completed tasks, paid or cancelled
        bills, archived documents, cancelled subscriptions, and fully repaid loans stop their
        reminders. Archived contacts and completed follow-ups also clear their alerts.
      </p>
      <p class="form-hint">
        Document reminders apply to ready documents with an expiry date. Open a document reminder to
        review its details or upload a renewed version. Snooze for one hour or one day from the
        notification bell.
      </p>
      @if (error()) {
        <p class="error-banner" role="alert">{{ error() }}</p>
      }
      <button type="submit" class="button primary" [disabled]="busy() || store.loading()">
        {{ busy() ? 'Saving…' : 'Save reminders' }}
      </button>
      <p class="form-hint">Delivery happens in LifeOS. Email reminders can be added later.</p>
    </form>
  </section>`,
})
export class ReminderSettings {
  readonly reminders = inject(Reminders);
  readonly store = this.reminders.store;
  readonly ui = inject(UiService);
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly fb = inject(FormBuilder);
  readonly hours = Array.from({ length: 24 }, (_, i) => i);
  readonly zones = [
    'UTC',
    'Asia/Kolkata',
    'Asia/Dubai',
    'Asia/Singapore',
    'Europe/London',
    'Europe/Paris',
    'America/New_York',
    'America/Los_Angeles',
    'Australia/Sydney',
  ];
  readonly form = this.fb.nonNullable.group({
    task_reminders: false,
    bill_reminders: false,
    document_reminders: false,
    subscription_reminders: false,
    loan_reminders: false,
    contact_reminders: false,
    task_lead_days: [1, [Validators.required, Validators.min(0), Validators.max(30)]],
    bill_lead_days: [3, [Validators.required, Validators.min(0), Validators.max(30)]],
    document_lead_days: [30, [Validators.required, Validators.min(0), Validators.max(90)]],
    subscription_lead_days: [7, [Validators.required, Validators.min(0), Validators.max(90)]],
    loan_lead_days: [3, [Validators.required, Validators.min(0), Validators.max(90)]],
    contact_lead_days: [1, [Validators.required, Validators.min(0), Validators.max(90)]],
    reminder_hour: [9, [Validators.required, Validators.min(0), Validators.max(23)]],
    reminder_timezone: ['UTC', [Validators.required, Validators.maxLength(100)]],
  });
  constructor() {
    effect(() => this.form.patchValue(this.store.reminderPreferences()));
  }
  async save() {
    if (this.form.invalid) {
      this.error.set('Check the lead times, hour and time zone.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.reminders.save({
        ...this.form.getRawValue(),
        reminder_timezone: this.form.controls.reminder_timezone.value.trim(),
      });
      this.ui.notify('Reminder preferences saved');
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
