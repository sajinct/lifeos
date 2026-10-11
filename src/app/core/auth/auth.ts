import { Injectable, inject, signal } from '@angular/core';
import { User } from '@supabase/supabase-js';
import { Backend } from '../supabase/client';
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly backend = inject(Backend);
  readonly user = signal<User | null>(null);
  readonly demo = signal(false);
  readonly recovery = signal(false);
  readonly initError = signal('');
  readonly ready: Promise<void>;
  constructor() {
    const client = this.backend.client;
    this.ready = client
      ? this.initialize().catch((e) => {
          this.initError.set(e instanceof Error ? e.message : 'Session restoration failed');
        })
      : Promise.resolve();
    client?.auth.onAuthStateChange((event, session) => {
      this.user.set(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') this.recovery.set(true);
    });
  }
  private async initialize() {
    const client = this.backend.requireClient();
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code) {
      const { error } = await client.auth.exchangeCodeForSession(code);
      history.replaceState(null, '', location.pathname + '#/auth');
      if (error) throw error;
      this.recovery.set(params.get('flow') === 'recovery');
    }
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    this.user.set(data.session?.user ?? null);
  }
  redirectUrl() {
    return location.origin + location.pathname;
  }
  async signIn(email: string, password: string) {
    const { error } = await this.backend
      .requireClient()
      .auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.demo.set(false);
  }
  async signUp(email: string, password: string, name: string) {
    const { data, error } = await this.backend.requireClient().auth.signUp({
      email,
      password,
      options: { data: { display_name: name }, emailRedirectTo: this.redirectUrl() },
    });
    if (error) throw error;
    this.demo.set(false);
    return Boolean(data.session);
  }
  async reset(email: string) {
    const { error } = await this.backend
      .requireClient()
      .auth.resetPasswordForEmail(email, { redirectTo: this.redirectUrl() + '?flow=recovery' });
    if (error) throw error;
  }
  async changePassword(password: string) {
    const { error } = await this.backend.requireClient().auth.updateUser({ password });
    if (error) throw error;
    this.recovery.set(false);
  }
  async signOut() {
    if (!this.demo()) {
      const { error } = await this.backend.requireClient().auth.signOut();
      if (error) throw error;
    }
    this.demo.set(false);
    this.user.set(null);
  }
}
