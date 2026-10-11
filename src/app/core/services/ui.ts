import { Injectable, signal } from '@angular/core';
import { CaptureKind } from '../models/domain';
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly capture = signal<CaptureKind | null>(null);
  readonly searchOpen = signal(false);
  readonly toast = signal('');
  readonly sidebarOpen = signal(false);
  readonly compact = signal(false);
  readonly mobile = signal(window.matchMedia('(max-width:680px)').matches);
  readonly dark = signal(localStorage.getItem('lifeos-theme') === 'dark');
  readonly online = signal(navigator.onLine);
  private timer?: ReturnType<typeof setTimeout>;
  constructor() {
    this.applyTheme();
    window
      .matchMedia('(max-width:680px)')
      .addEventListener('change', (e) => this.mobile.set(e.matches));
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }
  notify(message: string) {
    this.toast.set(message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.toast.set(''), 4500);
  }
  toggleTheme() {
    this.dark.update((v) => !v);
    localStorage.setItem('lifeos-theme', String(this.dark() ? 'dark' : 'light'));
    this.applyTheme();
  }
  toggleSidebar() {
    if (this.mobile()) this.sidebarOpen.update((v) => !v);
    else this.compact.update((v) => !v);
  }
  private applyTheme() {
    document.documentElement.classList.toggle('dark', this.dark());
  }
}
