import { Component, HostListener, OnInit, inject, signal, computed, effect } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Icon } from '../shared/components/icon';
import { LifeStore } from '../core/services/life-store';
import { UiService } from '../core/services/ui';
import { AuthService } from '../core/auth/auth';
import { CaptureDialog } from '../shared/components/capture-dialog';
import { SearchDialog } from '../shared/components/search-dialog';
import { Reminders } from '../core/services/reminders';
import { Notification } from '../core/models/domain';
@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    Icon,
    CaptureDialog,
    SearchDialog,
    DatePipe,
  ],
  templateUrl: './shell.html',
})
export class Shell implements OnInit {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  readonly notices = signal(false);
  readonly reminders = inject(Reminders);
  readonly snoozedView = signal(false);
  readonly unread = this.reminders.unread;
  readonly snoozed = computed(() =>
    this.store
      .notifications()
      .filter(
        (n) =>
          !n.dismissed_at && n.snoozed_until && Date.parse(n.snoozed_until) > this.reminders.now(),
      ),
  );
  readonly noticeList = computed(() =>
    this.snoozedView() ? this.snoozed() : this.reminders.visible(),
  );
  readonly primary = [
    { path: '/', name: 'Overview', icon: 'grid' },
    { path: '/inbox', name: 'Inbox', icon: 'inbox' },
    { path: '/tasks', name: 'Tasks', icon: 'task' },
    { path: '/calendar', name: 'Calendar', icon: 'calendar' },
  ];
  readonly life = [
    { path: '/finance', name: 'Finance', icon: 'wallet' },
    { path: '/family', name: 'Family & household', icon: 'family' },
    { path: '/career', name: 'Career', icon: 'project' },
    { path: '/assets', name: 'Assets & maintenance', icon: 'project' },
    { path: '/contacts', name: 'Contacts', icon: 'contacts' },
    { path: '/loans', name: 'Loans & repayments', icon: 'wallet' },
    { path: '/subscriptions', name: 'Subscriptions', icon: 'repeat' },
    { path: '/projects', name: 'Projects', icon: 'project' },
    { path: '/goals', name: 'Goals & habits', icon: 'goal' },
    { path: '/notes', name: 'Notes & knowledge', icon: 'note' },
    { path: '/documents', name: 'Documents & receipts', icon: 'file' },
  ];
  constructor() {
    effect(() => {
      if (!this.auth.user() && !this.auth.demo()) {
        this.store.clear();
        this.ui.capture.set(null);
        this.ui.searchOpen.set(false);
        void this.router.navigateByUrl('/auth');
      }
    });
  }
  async ngOnInit() {
    await this.store.initialize();
  }
  async toggleNotices() {
    this.notices.set(!this.notices());
    if (this.notices()) await this.reminders.refresh();
  }
  async openNotice(n: Notification) {
    const workspace = this.store.workspace()?.id;
    const session = this.store.fileSession();
    if (!(await this.reminders.resolveSource(n))) return;
    await this.reminders.act(n, 'read');
    if (
      this.reminders.error() ||
      workspace !== this.store.workspace()?.id ||
      session !== this.store.fileSession()
    )
      return;
    this.notices.set(false);
    await this.router.navigate([this.reminders.path(n)], {
      queryParams: { reminder: n.source_id },
    });
  }
  @HostListener('window:keydown', ['$event']) shortcut(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      this.ui.searchOpen.set(!this.ui.searchOpen());
    }
  }
  switch(event: Event) {
    const w = this.store
      .workspaces()
      .find((w) => w.id === (event.target as HTMLSelectElement).value);
    if (w) void this.store.switchWorkspace(w);
  }
  async logout() {
    try {
      await this.auth.signOut();
      this.store.clear();
      await this.router.navigateByUrl('/auth');
    } catch (e) {
      this.ui.notify(this.store.message(e));
    }
  }
}
