import {
  AfterViewInit,
  Component,
  ElementRef,
  ViewChild,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Capture, CaptureKind } from '../../core/models/domain';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { localDate } from '../utilities/finance';
import { Icon } from './icon';
@Component({
  selector: 'app-capture-dialog',
  imports: [ReactiveFormsModule, Icon],
  template: ` <dialog #dialog class="modal" (cancel)="close()" aria-labelledby="capture-title">
    <div class="modal-heading">
      <div>
        <span class="eyebrow">QUICK CAPTURE</span>
        <h2 id="capture-title">
          Add {{ ['event', 'expense', 'income', 'account'].includes(kind()) ? 'an ' : 'a '
          }}{{ kind() }}
        </h2>
      </div>
      <button class="icon-button" (click)="close()" aria-label="Close dialog">
        <app-icon name="close" />
      </button>
    </div>
    <form [formGroup]="form" (ngSubmit)="save()">
      <label
        >{{ kind() === 'account' ? 'Account name' : 'Title'
        }}<input
          autofocus
          formControlName="title"
          placeholder="What’s on your mind?"
          maxlength="200"
      /></label>
      @if (
        kind() === 'expense' || kind() === 'income' || kind() === 'goal' || kind() === 'account'
      ) {
        <label
          >{{
            kind() === 'goal'
              ? 'Target'
              : kind() === 'account'
                ? 'Opening balance (optional)'
                : 'Amount'
          }}<input formControlName="amount" inputmode="decimal" placeholder="0.00"
        /></label>
      }
      @if (kind() === 'expense' || kind() === 'income') {
        <label
          >Account<select formControlName="account_id">
            <option value="">Choose an account</option>
            @for (a of ownedAccounts(); track a.id) {
              <option [value]="a.id">{{ a.name }} · {{ a.currency }}</option>
            }
          </select></label
        >
        @if (!ownedAccounts().length) {
          <p class="form-hint">Create a financial account from Finance first.</p>
        }
      }
      @if (kind() !== 'note' && kind() !== 'account') {
        <div class="form-row">
          <label
            >{{
              kind() === 'event'
                ? 'Date'
                : kind() === 'expense' || kind() === 'income'
                  ? 'Transaction date'
                  : 'Due date'
            }}<input type="date" formControlName="date"
          /></label>
          @if (kind() === 'event') {
            <label>Start time<input type="time" formControlName="time" /></label>
            <label>End time<input type="time" formControlName="end_time" /></label>
          }
          @if (kind() === 'task') {
            <label
              >Priority<select formControlName="priority">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select></label
            >
          }
        </div>
      }
      @if (kind() === 'expense' || kind() === 'income' || kind() === 'goal') {
        <label
          >{{ kind() === 'goal' ? 'Unit (books, km, INR...)' : 'Category'
          }}<input formControlName="category"
        /></label>
      }
      @if (kind() === 'note' || kind() === 'project' || kind() === 'event') {
        <label
          >{{ kind() === 'event' ? 'Location' : 'Notes'
          }}<textarea
            rows="4"
            formControlName="body"
            placeholder="Add a little context..."
          ></textarea>
        </label>
      }
      @if (kind() === 'task' || kind() === 'note' || kind() === 'event') {
        <label
          >Project (optional)<select formControlName="project_id">
            <option value="">Personal</option>
            @for (p of store.projects(); track p.id) {
              <option [value]="p.id">{{ p.title }}</option>
            }
          </select></label
        >
      }
      @if (kind() !== 'income' && kind() !== 'expense' && kind() !== 'account') {
        <label
          >Who can see this?<select formControlName="visibility">
            <option value="private">Only me</option>
            <option value="workspace">Workspace members</option>
          </select></label
        >
      }
      @if (error()) {
        <p class="form-error" role="alert">{{ error() }}</p>
      }
      <div class="modal-footer">
        <span
          ><app-icon name="lock" />{{
            form.value.visibility === 'workspace'
              ? 'Shared with this workspace'
              : 'Private by default'
          }}</span
        ><button type="submit" class="button primary" [disabled]="saving()">
          {{ saving() ? 'Saving…' : 'Save ' + kind() }}<app-icon name="arrow" />
        </button>
      </div>
    </form>
  </dialog>`,
})
export class CaptureDialog implements AfterViewInit {
  readonly kind = input.required<CaptureKind>();
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly error = signal('');
  readonly saving = signal(false);
  private readonly goalRequest = crypto.randomUUID();
  @ViewChild('dialog') dialog!: ElementRef<HTMLDialogElement>;
  readonly form = inject(FormBuilder).nonNullable.group({
    title: ['', [Validators.required, Validators.maxLength(200)]],
    date: localDate(),
    time: '09:00',
    end_time: '10:00',
    amount: '',
    body: '',
    category: 'Other',
    priority: 'medium',
    visibility: 'private',
    account_id: '',
    project_id: '',
  });
  ngAfterViewInit() {
    this.form.controls.account_id.setValue(this.ownedAccounts()[0]?.id ?? '');
    this.dialog.nativeElement.showModal();
  }
  ownedAccounts() {
    return this.store
      .accounts()
      .filter(
        (a) => a.owner_id === (this.store.auth.demo() ? 'demo-user' : this.store.auth.user()?.id),
      );
  }
  close() {
    if (!this.saving()) this.ui.capture.set(null);
  }
  async save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.error.set('Please enter a title.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    try {
      await this.store.add(
        { ...this.form.getRawValue(), kind: this.kind() } as Capture,
        this.goalRequest,
      );
      this.ui.notify(this.kind().slice(0, 1).toUpperCase() + this.kind().slice(1) + ' added');
      this.ui.capture.set(null);
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.saving.set(false);
    }
  }
}
