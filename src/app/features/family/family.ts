import { Component, computed, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { HouseholdLibrary } from '../../core/services/household';
import { UiService } from '../../core/services/ui';
import { HouseholdMember, HouseholdEntry, Visibility } from '../../core/models/domain';
import { householdCsv } from '../../shared/utilities/household';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-family',
  imports: [DatePipe, RouterLink, ReactiveFormsModule, Icon],
  templateUrl: './family.html',
})
export class FamilyPage {
  readonly library = inject(HouseholdLibrary);
  readonly store = this.library.store;
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  private readonly params = toSignal(inject(ActivatedRoute).queryParamMap);
  readonly reminderId = computed(() => this.params()?.get('reminder'));
  readonly tab = signal<'member' | 'task' | 'date'>('member');
  readonly search = signal('');
  readonly statusFilter = signal('active');
  readonly sharingFilter = signal('all');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly formType = signal<'member' | 'entry' | null>(null);
  readonly editing = signal<HouseholdMember | HouseholdEntry | null>(null);
  readonly months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  readonly members = computed(() =>
    this.store.householdMembers().filter((m) => m.workspace_id === this.store.workspace()?.id),
  );
  readonly entries = computed(() =>
    this.store.householdEntries().filter((e) => e.workspace_id === this.store.workspace()?.id),
  );
  private matches(row: HouseholdMember | HouseholdEntry) {
    if (this.reminderId()) return row.id === this.reminderId();
    const text =
      'name' in row
        ? [row.name, row.relationship, row.notes].join(' ')
        : [row.title, row.notes, this.memberName(row.member_id)].join(' ');
    return (
      (this.statusFilter() === 'all' || row.status === this.statusFilter()) &&
      (this.sharingFilter() === 'all' || row.visibility === this.sharingFilter()) &&
      text.toLowerCase().includes(this.search().trim().toLowerCase())
    );
  }
  readonly shownMembers = computed(() =>
    this.reminderId() || this.tab() === 'member'
      ? this.members()
          .filter((m) => this.matches(m))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [],
  );
  readonly shownEntries = computed(() =>
    this.entries()
      .filter((e) => (!!this.reminderId() || e.kind === this.tab()) && this.matches(e))
      .sort(
        (a, b) =>
          (this.library.occurrence(a) ?? '9999').localeCompare(
            this.library.occurrence(b) ?? '9999',
          ) || a.title.localeCompare(b.title),
      ),
  );
  readonly counts = computed(() => ({
    members: this.members().filter((m) => m.status === 'active').length,
    tasks: this.entries().filter((e) => e.kind === 'task' && e.status === 'active').length,
    dates: this.entries().filter((e) => e.kind === 'date' && e.status === 'active').length,
  }));
  private readonly fb = inject(FormBuilder);
  readonly memberForm = this.fb.nonNullable.group({
    name: '',
    relationship: 'Family member',
    birthday_month: '',
    birthday_day: '',
    notes: '',
    visibility: 'private' as Visibility,
  });
  readonly entryForm = this.fb.nonNullable.group({
    title: '',
    kind: 'task' as HouseholdEntry['kind'],
    due_on: '',
    annual: false,
    member_id: '',
    notes: '',
    visibility: 'private' as Visibility,
  });
  private requestId: string = crypto.randomUUID();
  constructor() {
    effect(() => {
      this.store.workspace();
      this.store.fileSession();
      this.formType.set(null);
      this.editing.set(null);
      this.error.set('');
    });
  }
  memberName(id: string | null) {
    return (
      this.members().find((m) => m.id === id)?.name ?? (id ? 'Unavailable member' : 'Unassigned')
    );
  }
  canChangeSharing() {
    return !this.editing() || this.editing()?.owner_id === this.store.profile()?.id;
  }
  options() {
    const visibility = this.entryForm.controls.visibility.value,
      linked = this.editing();
    return this.members().filter(
      (m) =>
        (m.status === 'active' || (linked && 'member_id' in linked && linked.member_id === m.id)) &&
        (visibility === 'private' || m.visibility === 'workspace'),
    );
  }
  switchTab(tab: 'member' | 'task' | 'date') {
    this.tab.set(tab);
    this.formType.set(null);
    this.editing.set(null);
    this.statusFilter.set('active');
    this.clearReminder();
  }
  add(type: 'member' | 'task' | 'date') {
    this.error.set('');
    this.editing.set(null);
    this.requestId = crypto.randomUUID();
    if (type === 'member') {
      this.memberForm.reset({
        name: '',
        relationship: 'Family member',
        birthday_month: '',
        birthday_day: '',
        notes: '',
        visibility: 'private',
      });
      this.formType.set('member');
    } else {
      this.entryForm.reset({
        title: '',
        kind: type,
        due_on: type === 'date' ? this.library.today() : '',
        annual: false,
        member_id: '',
        notes: '',
        visibility: 'private',
      });
      this.formType.set('entry');
    }
  }
  edit(row: HouseholdMember | HouseholdEntry) {
    this.error.set('');
    this.editing.set(row);
    this.requestId = row.id;
    if ('birthday' in row) {
      this.memberForm.reset({
        name: row.name,
        relationship: row.relationship,
        birthday_month: row.birthday?.slice(0, 2) ?? '',
        birthday_day: row.birthday?.slice(3, 5) ?? '',
        notes: row.notes,
        visibility: row.visibility,
      });
      this.formType.set('member');
    } else {
      this.entryForm.reset({ ...row, due_on: row.due_on ?? '', member_id: row.member_id ?? '' });
      this.formType.set('entry');
    }
  }
  async saveMember() {
    await this.run(async () => {
      const v = this.memberForm.getRawValue();
      await this.library.saveMember(
        this.requestId,
        {
          name: v.name,
          relationship: v.relationship,
          birthday:
            v.birthday_month || v.birthday_day
              ? `${v.birthday_month}-${String(v.birthday_day).padStart(2, '0')}`
              : '',
          notes: v.notes,
          visibility: v.visibility,
        },
        (this.editing() as HouseholdMember) ?? undefined,
      );
      this.formType.set(null);
      this.ui.notify('Household member saved');
    });
  }
  async saveEntry() {
    await this.run(async () => {
      await this.library.saveEntry(
        this.requestId,
        this.entryForm.getRawValue(),
        (this.editing() as HouseholdEntry) ?? undefined,
      );
      this.formType.set(null);
      this.ui.notify('Household entry saved');
    });
  }
  async setStatus(row: HouseholdMember | HouseholdEntry, target: HouseholdEntry['status']) {
    await this.run(async () => {
      await this.library.status(row, target);
      this.ui.notify(
        target === 'archived'
          ? 'Record archived'
          : target === 'done'
            ? 'Responsibility completed'
            : 'Record restored or reopened',
      );
    });
  }
  clearReminder() {
    void this.router.navigate([], {
      queryParams: { reminder: null },
      queryParamsHandling: 'merge',
    });
  }
  export() {
    if (
      this.store.loading() ||
      this.store.error() ||
      (!this.shownMembers().length && !this.shownEntries().length)
    )
      return;
    const text = householdCsv(this.shownMembers(), this.shownEntries(), this.members()),
      url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `lifeos-household-${this.library.today()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.ui.notify('Filtered household records exported');
  }
  private async run(action: () => Promise<void>) {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const w = this.store.workspace()?.id,
      s = this.store.fileSession();
    try {
      await action();
    } catch (e) {
      if (w === this.store.workspace()?.id && s === this.store.fileSession())
        this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
