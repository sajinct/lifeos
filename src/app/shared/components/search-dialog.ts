import {
  AfterViewInit,
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { CaptureKind } from '../../core/models/domain';
import { Icon } from './icon';
@Component({
  selector: 'app-search-dialog',
  imports: [Icon],
  template: `<dialog
    #dialog
    class="modal search-modal"
    (cancel)="ui.searchOpen.set(false)"
    aria-label="Search and commands"
  >
    <div class="search-input">
      <app-icon name="search" /><input
        autofocus
        aria-label="Search records"
        placeholder="Search your life, or find an action…"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
      /><button class="icon-button" (click)="ui.searchOpen.set(false)" aria-label="Close search">
        <app-icon name="close" />
      </button>
    </div>
    <div class="search-results">
      <span class="eyebrow">{{ query() ? 'RESULTS' : 'QUICK ACTIONS' }}</span>
      @for (result of results(); track result.id) {
        <button (click)="navigate(result)">
          <span class="icon-tile purple"><app-icon [name]="result.icon" /></span>
          <div>
            <strong>{{ result.title }}</strong
            ><small>{{ result.type }}</small>
          </div>
          <app-icon name="arrow" />
        </button>
      } @empty {
        <p class="empty-state">
          {{ query() ? 'No matching records.' : 'What would you like to do?' }}
        </p>
      }
      @if (!query()) {
        @for (action of actions; track action.kind) {
          <button (click)="capture(action.kind)">
            <app-icon name="plus" /><strong>{{ action.title }}</strong>
          </button>
        }
      }
    </div>
    <div class="search-footer">Searches your current workspace.<kbd>esc</kbd> to close</div>
  </dialog>`,
})
export class SearchDialog implements AfterViewInit {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly router = inject(Router);
  readonly query = signal('');
  @ViewChild('dialog') dialog!: ElementRef<HTMLDialogElement>;
  readonly actions: { kind: CaptureKind; title: string }[] = [
    { kind: 'task', title: 'Add a task' },
    { kind: 'expense', title: 'Record an expense' },
    { kind: 'note', title: 'Capture a note' },
  ];
  readonly results = computed(() => {
    const q = this.query().toLowerCase().trim();
    if (!q) return [];
    return [
      ...this.store
        .investmentHoldings()
        .filter((h) => !h.archived && h.owner_id === this.store.profile()?.id)
        .map((h) => ({
          id: h.id,
          title: h.title,
          type: 'Investment holding',
          icon: 'wallet',
          path: '/wealth',
        })),
      ...this.store
        .creditCards()
        .filter((c) => !c.archived && c.owner_id === this.store.profile()?.id)
        .map((c) => ({
          id: c.id,
          title: c.title,
          type: 'Credit card',
          icon: 'wallet',
          path: '/cards',
        })),
      ...this.store
        .goals()
        .filter((g) => g.status === 'active')
        .map((g) => ({ id: g.id, title: g.title, type: 'Goal', icon: 'goal', path: '/goals' })),
      ...this.store
        .habits()
        .filter((h) => h.status === 'active')
        .map((h) => ({
          id: h.id,
          title: h.title + ' · ' + (h.routine || 'Habit'),
          type: 'Habit',
          icon: 'repeat',
          path: '/goals',
        })),
      ...this.store
        .travelPlans()
        .filter((r) => r.owner_id === this.store.profile()?.id && !r.archived)
        .map((r) => ({
          id: r.id,
          title: r.title,
          type: r.kind === 'trip' ? 'Trip' : 'Personal event',
          icon: 'calendar',
          path: '/travel',
        })),
      ...this.store
        .medicationPlans()
        .filter((r) => r.owner_id === this.store.profile()?.id && !r.archived)
        .map((r) => ({
          id: r.id,
          title: r.title,
          type: 'Medication schedule',
          icon: 'goal',
          path: '/health',
        })),
      ...this.store
        .healthAppointments()
        .filter((r) => r.owner_id === this.store.profile()?.id)
        .map((r) => ({
          id: r.id,
          title: r.title,
          type: 'Health appointment',
          icon: 'goal',
          path: '/health',
        })),
      ...this.store
        .careerRecords()
        .filter((r) => r.status !== 'archived')
        .map((r) => ({
          id: r.id,
          title: r.title + ' · ' + r.organization,
          type: 'Career',
          icon: 'project',
          path: '/career',
        })),
      ...this.store
        .assets()
        .filter((a) => a.status === 'active')
        .map((a) => ({ id: a.id, title: a.name, type: 'Asset', icon: 'project', path: '/assets' })),
      ...this.store
        .householdMembers()
        .filter((m) => m.status === 'active')
        .map((m) => ({
          id: m.id,
          title: m.name,
          type: 'Household member',
          icon: 'family',
          path: '/family',
        })),
      ...this.store
        .householdEntries()
        .filter((e) => e.status === 'active')
        .map((e) => ({
          id: e.id,
          title: e.title,
          type: e.kind === 'task' ? 'Household responsibility' : 'Important date',
          icon: 'family',
          path: '/family',
        })),
      ...this.store
        .contacts()
        .filter((c) => c.status === 'active')
        .map((c) => ({
          id: c.id,
          title: c.name + ' · ' + c.organization,
          type: 'Contact',
          icon: 'contacts',
          path: '/contacts',
        })),
      ...this.store.loans().map((s) => ({
        id: s.id,
        title: s.title + ' · ' + s.counterparty,
        type: 'Loan',
        icon: 'wallet',
        path: '/loans',
      })),
      ...this.store.subscriptions().map((s) => ({
        id: s.id,
        title: s.title,
        type: 'Subscription',
        icon: 'repeat',
        path: '/subscriptions',
      })),
      ...this.store
        .tasks()
        .map((t) => ({ id: t.id, title: t.title, type: 'Task', icon: 'task', path: '/tasks' })),
      ...this.store.projects().map((p) => ({
        id: p.id,
        title: p.title,
        type: 'Project',
        icon: 'project',
        path: '/projects',
      })),
      ...this.store
        .notes()
        .filter((n) => !n.archived)
        .map((n) => ({ id: n.id, title: n.title, type: 'Note', icon: 'note', path: '/notes' })),
      ...this.store.events().map((e) => ({
        id: e.id,
        title: e.title,
        type: 'Event',
        icon: 'calendar',
        path: '/calendar',
      })),
      ...this.store
        .attachments()
        .filter((a) => a.status === 'ready')
        .map((a) => ({
          id: a.id,
          title: a.name,
          type: a.bucket_id === 'financial-receipts' ? 'Receipt' : 'Document',
          icon: 'file',
          path: '/documents',
          bucket: a.bucket_id,
        })),
    ]
      .filter((r) => r.title.toLowerCase().includes(q))
      .slice(0, 12);
  });
  ngAfterViewInit() {
    this.dialog.nativeElement.showModal();
  }
  navigate(result: { id: string; path: string; bucket?: string }) {
    this.ui.searchOpen.set(false);
    void this.router.navigateByUrl(
      result.path === '/notes' ||
        result.path === '/projects' ||
        result.path === '/travel' ||
        result.path === '/cards' ||
        result.path === '/wealth'
        ? result.path + '?linked=' + encodeURIComponent(result.id)
        : result.path === '/family' ||
            result.path === '/assets' ||
            result.path === '/health' ||
            result.path === '/career' ||
            result.path === '/goals' ||
            result.path === '/tasks'
          ? result.path + '?reminder=' + encodeURIComponent(result.id)
          : result.path,
      {
        state: { search: this.query(), bucket: result.bucket },
      },
    );
  }
  capture(kind: CaptureKind) {
    this.ui.searchOpen.set(false);
    this.ui.capture.set(kind);
  }
}
