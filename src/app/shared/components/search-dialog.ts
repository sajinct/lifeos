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
        <button (click)="navigate(result.path)">
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
        .map((n) => ({ id: n.id, title: n.title, type: 'Note', icon: 'note', path: '/notes' })),
      ...this.store.events().map((e) => ({
        id: e.id,
        title: e.title,
        type: 'Event',
        icon: 'calendar',
        path: '/calendar',
      })),
    ]
      .filter((r) => r.title.toLowerCase().includes(q))
      .slice(0, 12);
  });
  ngAfterViewInit() {
    this.dialog.nativeElement.showModal();
  }
  navigate(path: string) {
    this.ui.searchOpen.set(false);
    void this.router.navigateByUrl(path, { state: { search: this.query() } });
  }
  capture(kind: CaptureKind) {
    this.ui.searchOpen.set(false);
    this.ui.capture.set(kind);
  }
}
