import { Component, effect, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { ALL_WIDGETS, WorkspaceKind } from '../../core/models/domain';
import { Icon } from '../../shared/components/icon';
import { ReminderSettings } from './reminder-settings';
@Component({
  selector: 'app-settings',
  imports: [ReactiveFormsModule, Icon, ReminderSettings],
  template: ` <section class="page-heading">
      <div>
        <span class="eyebrow">MAKE YOURSELF AT HOME</span>
        <h1>Settings</h1>
        <p>A workspace that feels a little more like you.</p>
      </div>
    </section>
    <div class="settings-grid">
      <app-reminder-settings />
      <section class="panel settings-panel">
        <h2>Your profile</h2>
        <p>The little details that make this yours.</p>
        <form [formGroup]="profileForm" (ngSubmit)="saveProfile()">
          <label>Display name<input formControlName="name" maxlength="100" /></label
          ><label
            >Preferred currency<select formControlName="currency">
              <option value="INR">INR · Indian rupee</option>
              <option value="USD">USD · US dollar</option>
              <option value="EUR">EUR · Euro</option>
              <option value="GBP">GBP · British pound</option>
            </select></label
          >
          <p class="form-hint">
            Summaries include accounts in your selected currency. Original account currencies stay
            unchanged.
          </p>
          <button class="button primary" type="submit" [disabled]="busy()">Save profile</button>
        </form>
      </section>
      <section class="panel settings-panel">
        <h2>Your workspace</h2>
        <p>A separate space for each part of your life.</p>
        <form [formGroup]="workspaceForm" (ngSubmit)="createWorkspace()">
          <label
            >Workspace name<input
              formControlName="name"
              placeholder="e.g. Our family"
              maxlength="80" /></label
          ><label
            >Workspace type<select formControlName="kind">
              <option value="personal">Personal</option>
              <option value="family">Family</option>
              <option value="professional">Professional</option>
              <option value="side_project">Side project</option>
            </select></label
          ><button class="button primary" type="submit" [disabled]="busy()">
            <app-icon name="plus" />Create workspace
          </button>
        </form>
        <div class="workspace-list">
          @for (w of store.workspaces(); track w.id) {
            <button
              (click)="store.switchWorkspace(w)"
              [class.active]="w.id === store.workspace()?.id"
            >
              <app-icon name="family" /><span
                >{{ w.name }}<small>{{ w.kind.replace('_', ' ') }}</small></span
              >
              @if (w.id === store.workspace()?.id) {
                <app-icon name="check" />
              }
            </button>
          }
        </div>
      </section>
      <section class="panel settings-panel">
        <h2>Your overview</h2>
        <p>Choose what you’d like to see on your dashboard.</p>
        <div class="widget-options">
          @for (widget of widgets; track widget) {
            <label
              ><input
                type="checkbox"
                [checked]="store.widgets().includes(widget)"
                (change)="toggleWidget(widget)"
                [disabled]="busy()"
              /><span>{{ widget }}</span></label
            >
          }
        </div>
        <div class="appearance-setting">
          <span
            ><strong>Appearance</strong
            ><small>{{
              ui.dark() ? 'A softer view after dark' : 'A little light in your day'
            }}</small></span
          ><button class="button subtle" (click)="ui.toggleTheme()">
            <app-icon [name]="ui.dark() ? 'sun' : 'moon'" />{{
              ui.dark() ? 'Light mode' : 'Dark mode'
            }}
          </button>
        </div>
      </section>
      <section class="panel settings-panel">
        <h2>Workspace members</h2>
        <p>Private records stay private. Shared records are visible to members.</p>
        @for (m of store.members(); track m.user_id) {
          <div class="member-row">
            <span class="avatar small">{{ m.role.slice(0, 1).toUpperCase() }}</span
            ><span
              >{{ m.user_id === store.profile()?.id ? 'You' : m.user_id
              }}<small>{{ m.role }}</small></span
            >
            @if (store.owner() && m.role !== 'owner') {
              <button
                class="icon-button"
                (click)="removeMember(m.user_id)"
                aria-label="Remove member"
              >
                <app-icon name="close" />
              </button>
            }
          </div>
        }
        @if (store.owner()) {
          <form [formGroup]="memberForm" (ngSubmit)="addMember()">
            <label
              >Existing user’s profile UUID<input
                formControlName="id"
                placeholder="Their account UUID" /></label
            ><label
              >Access<select formControlName="role">
                <option value="viewer">Viewer · shared records only</option>
                <option value="editor">Editor · can create records</option>
              </select></label
            >
            <p class="form-hint">
              The user must already have an account. Only workspace owners can manage membership.
            </p>
            <button class="button subtle" type="submit" [disabled]="busy()">Add member</button>
          </form>
        }
      </section>
      <section class="panel settings-panel">
        <h2>Your data is yours</h2>
        <p>Keep a copy of your records whenever you want.</p>
        <div class="heading-actions">
          <button class="button subtle" (click)="store.download('json')">
            <app-icon name="download" />Workspace JSON</button
          ><button class="button subtle" (click)="store.download('csv')">Finance CSV</button>
        </div>
        <p class="form-hint">
          Uploaded files need a separate Storage backup. See docs/operations.md for full backup and
          restore procedures.
        </p>
      </section>
      <section class="panel settings-panel">
        <h2>What’s next</h2>
        <p>
          The foundation and first productivity tools are ready. LifeOS grows one useful module at a
          time.
        </p>
        <div class="roadmap-list">
          <span>Next: Assets & maintenance</span><span>Then: Career, health & travel</span
          ><span>Later: Imports, AI & integrations</span>
        </div>
      </section>
    </div>
    @if (error()) {
      <p class="error-banner" role="alert">{{ error() }}</p>
    }`,
})
export class SettingsPage {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly widgets = ALL_WIDGETS;
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly fb = inject(FormBuilder);
  readonly profileForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(100)]],
    currency: 'INR',
  });
  readonly workspaceForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(80)]],
    kind: 'personal',
  });
  readonly memberForm = this.fb.nonNullable.group({
    id: ['', [Validators.required, Validators.pattern(/^[0-9a-f-]{36}$/i)]],
    role: 'viewer',
  });
  constructor() {
    effect(() => {
      const p = this.store.profile();
      if (p) this.profileForm.patchValue({ name: p.display_name, currency: p.currency });
    });
  }
  private async run(action: () => Promise<void>, message: string) {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
      this.ui.notify(message);
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
  async saveProfile() {
    if (this.profileForm.invalid) {
      this.error.set('Enter a display name.');
      return;
    }
    const v = this.profileForm.getRawValue();
    await this.run(() => this.store.saveProfile(v.name.trim(), v.currency), 'Profile updated');
  }
  async createWorkspace() {
    if (this.workspaceForm.invalid) {
      this.error.set('Enter a workspace name.');
      return;
    }
    const v = this.workspaceForm.getRawValue();
    await this.run(
      () => this.store.createWorkspace(v.name, v.kind as WorkspaceKind),
      'Workspace created',
    );
    this.workspaceForm.controls.name.reset();
  }
  async toggleWidget(widget: string) {
    const current = this.store.widgets();
    await this.run(
      () =>
        this.store.saveWidgets(
          current.includes(widget) ? current.filter((w) => w !== widget) : [...current, widget],
        ),
      'Dashboard updated',
    );
  }
  async addMember() {
    if (this.memberForm.invalid) {
      this.error.set('Enter a valid profile UUID.');
      return;
    }
    const v = this.memberForm.getRawValue();
    await this.run(() => this.store.setMember(v.id, v.role as 'editor' | 'viewer'), 'Member added');
  }
  async removeMember(id: string) {
    await this.run(() => this.store.removeMember(id), 'Member removed');
  }
}
