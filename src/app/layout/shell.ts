import { Component, HostListener, OnInit, inject, signal, computed, effect } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Icon } from '../shared/components/icon';
import { LifeStore } from '../core/services/life-store';
import { UiService } from '../core/services/ui';
import { AuthService } from '../core/auth/auth';
import { CaptureDialog } from '../shared/components/capture-dialog';
import { SearchDialog } from '../shared/components/search-dialog';
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, CaptureDialog, SearchDialog],
  templateUrl: './shell.html',
})
export class Shell implements OnInit {
  readonly store = inject(LifeStore);
  readonly ui = inject(UiService);
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  readonly notices = signal(false);
  readonly unread = computed(() => this.store.notifications().some((n) => !n.read_at));
  readonly primary = [
    { path: '/', name: 'Overview', icon: 'grid' },
    { path: '/inbox', name: 'Inbox', icon: 'inbox' },
    { path: '/tasks', name: 'Tasks', icon: 'task' },
    { path: '/calendar', name: 'Calendar', icon: 'calendar' },
  ];
  readonly life = [
    { path: '/finance', name: 'Finance', icon: 'wallet' },
    { path: '/projects', name: 'Projects', icon: 'project' },
    { path: '/goals', name: 'Goals', icon: 'goal' },
    { path: '/notes', name: 'Notes & knowledge', icon: 'note' },
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
  async read(id: string) {
    const n = this.store.notifications().find((n) => n.id === id);
    if (n) {
      try {
        await this.store.markRead(n);
      } catch (e) {
        this.ui.notify(this.store.message(e));
      }
    }
  }
}
