import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { LifeStore } from '../../core/services/life-store';
import { ContactLibrary } from '../../core/services/contacts';
import { UiService } from '../../core/services/ui';
import { Contact, ContactLink } from '../../core/models/domain';
import { contactsCsv } from '../../shared/utilities/contacts';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-contacts',
  imports: [DatePipe, RouterLink, ReactiveFormsModule, Icon],
  templateUrl: './contacts.html',
})
export class ContactsPage {
  readonly store = inject(LifeStore);
  readonly library = inject(ContactLibrary);
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly reminderId = computed(() => this.params()?.get('reminder'));
  readonly search = signal(String(history.state?.search ?? ''));
  readonly status = signal('active');
  readonly kind = signal('all');
  readonly follow = signal('all');
  readonly own = computed(() =>
    this.store
      .contacts()
      .filter(
        (c) =>
          c.owner_id === this.store.profile()?.id && c.workspace_id === this.store.workspace()?.id,
      ),
  );
  readonly rows = computed(() =>
    this.own()
      .filter((c) =>
        this.reminderId()
          ? c.id === this.reminderId()
          : (this.status() === 'all' || c.status === this.status()) &&
            (this.kind() === 'all' || c.kind === this.kind()) &&
            (this.follow() === 'all' ||
              (this.follow() === 'due'
                ? !!c.next_follow_up && c.next_follow_up <= this.library.today()
                : !!c.next_follow_up)) &&
            [c.name, c.organization, c.category, c.email, c.phone, c.notes]
              .join(' ')
              .toLowerCase()
              .includes(this.search().trim().toLowerCase()),
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  readonly counts = computed(() => ({
    people: this.own().filter((c) => c.status === 'active' && c.kind === 'person').length,
    organizations: this.own().filter((c) => c.status === 'active' && c.kind === 'organization')
      .length,
    due: this.own().filter(
      (c) => c.status === 'active' && c.next_follow_up && c.next_follow_up <= this.library.today(),
    ).length,
  }));
  readonly loans = computed(() =>
    this.store
      .loans()
      .filter(
        (l) =>
          l.owner_id === this.store.profile()?.id && l.workspace_id === this.store.workspace()?.id,
      ),
  );
  readonly busy = signal(false);
  readonly error = signal('');
  readonly showForm = signal(false);
  readonly editing = signal<Contact | null>(null);
  private requestId: string = crypto.randomUUID();
  readonly form = inject(FormBuilder).nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(200)]],
    kind: 'person' as Contact['kind'],
    organization: '',
    category: 'Personal',
    email: '',
    phone: '',
    website: '',
    address: '',
    notes: '',
    next_follow_up: '',
    follow_up_note: '',
    last_contacted_on: '',
    project_ids: new FormControl<string[]>([], { nonNullable: true }),
    loan_ids: new FormControl<string[]>([], { nonNullable: true }),
  });
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.showForm.set(false);
      this.editing.set(null);
      this.error.set('');
    });
  }
  links(c: Contact) {
    return this.store
      .contactLinks()
      .filter(
        (l) =>
          l.contact_id === c.id && l.owner_id === c.owner_id && l.workspace_id === c.workspace_id,
      );
  }
  projectName(id: string) {
    return this.library.projects().find((p) => p.id === id)?.title ?? 'Linked project';
  }
  loanName(id: string) {
    return this.loans().find((l) => l.id === id)?.title ?? 'Linked loan';
  }
  async add() {
    await this.run(async () => {
      await this.library.loadProjects();
      this.editing.set(null);
      this.requestId = crypto.randomUUID();
      this.form.reset({
        name: '',
        kind: 'person',
        organization: '',
        category: 'Personal',
        email: '',
        phone: '',
        website: '',
        address: '',
        notes: '',
        next_follow_up: '',
        follow_up_note: '',
        last_contacted_on: '',
        project_ids: [],
        loan_ids: [],
      });
      this.showForm.set(true);
    });
  }
  async edit(c: Contact) {
    await this.run(async () => {
      await this.library.loadProjects();
      this.editing.set(c);
      this.requestId = c.id;
      const links = this.links(c);
      this.form.reset({
        name: c.name,
        kind: c.kind,
        organization: c.organization,
        category: c.category,
        email: c.email,
        phone: c.phone,
        website: c.website,
        address: c.address,
        notes: c.notes,
        next_follow_up: c.next_follow_up ?? '',
        follow_up_note: c.follow_up_note,
        last_contacted_on: c.last_contacted_on ?? '',
        project_ids: links.filter((l) => l.project_id).map((l) => l.project_id!),
        loan_ids: links.filter((l) => l.loan_id).map((l) => l.loan_id!),
      });
      this.showForm.set(true);
    });
  }
  selectLink(type: 'project_ids' | 'loan_ids', id: string, checked: boolean) {
    const control = this.form.controls[type];
    control.setValue(
      checked ? [...new Set([...control.value, id])] : control.value.filter((v) => v !== id),
    );
  }
  async save() {
    await this.run(async () => {
      await this.library.save(this.requestId, this.form.getRawValue(), this.editing() ?? undefined);
      this.showForm.set(false);
      this.editing.set(null);
      this.ui.notify('Contact saved');
    });
  }
  async statusChange(c: Contact) {
    await this.run(async () => {
      const target = c.status === 'active' ? 'archived' : 'active';
      await this.library.setStatus(c, target);
      this.ui.notify(target === 'archived' ? 'Contact archived' : 'Contact restored');
    });
  }
  async contacted(c: Contact) {
    await this.run(async () => {
      await this.library.contacted(c);
      this.ui.notify('Marked contacted today; follow-up cleared');
    });
  }
  async openLink(l: ContactLink) {
    await this.run(async () => {
      if (l.project_id) {
        if (await this.library.openProject(l.project_id))
          await this.router.navigate(['/projects'], { queryParams: { linked: l.project_id } });
      } else if (l.loan_id)
        await this.router.navigate(['/loans'], { queryParams: { linked: l.loan_id } });
    });
  }
  clearReminder() {
    void this.router.navigate([], {
      queryParams: { reminder: null },
      queryParamsHandling: 'merge',
    });
  }
  export() {
    if (this.store.loading() || this.store.error() || !this.rows().length) return;
    const text = contactsCsv(
        this.rows(),
        this.store.contactLinks(),
        this.library.projects(),
        this.loans(),
      ),
      url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-contacts-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.ui.notify('Filtered contacts exported');
  }
  private async run(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
