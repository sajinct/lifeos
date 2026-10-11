import { Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { Icon } from '../../shared/components/icon';
@Component({
  selector: 'app-auth',
  imports: [ReactiveFormsModule, Icon],
  template: ` <div class="auth-page">
    <section class="auth-story">
      <a class="brand" href="#/auth"
        ><span class="brand-mark">L<span></span></span
        ><span>Life<span class="brand-light">OS</span></span></a
      >
      <div class="auth-story-main">
        <span class="eyebrow">YOUR LIFE. A LITTLE MORE CONNECTED.</span>
        <h1>Less to keep<br />in your head.<br /><em>More room to live.</em></h1>
        <p>Your tasks, money, projects, and goals.<br />One calm place to bring it all together.</p>
        <div class="auth-illustration">
          <div class="illustration-card">
            <span class="icon-tile purple"><app-icon name="task" /></span
            ><strong>Make a little progress</strong><span class="illustration-check">✓</span>
          </div>
          <div class="illustration-card">
            <span class="icon-tile green"><app-icon name="leaf" /></span
            ><strong>Make space for yourself</strong><span class="illustration-check">✓</span>
          </div>
          <div class="illustration-card">
            <span class="icon-tile orange"><app-icon name="goal" /></span
            ><strong>Keep the big picture in sight</strong><span class="illustration-check">✓</span>
          </div>
        </div>
      </div>
      <small>A little more clarity. A little more life.</small>
    </section>
    <section class="auth-form-section">
      <div class="auth-form">
        <span class="eyebrow">WELCOME TO YOUR EVERYDAY</span>
        <h2>
          {{
            mode() === 'signup'
              ? 'A fresh start.'
              : mode() === 'reset'
                ? 'Let’s get you back in.'
                : mode() === 'password'
                  ? 'Choose a new password.'
                  : 'Welcome home.'
          }}
        </h2>
        <p>
          {{
            mode() === 'signup'
              ? 'Create your own little corner of LifeOS.'
              : mode() === 'reset'
                ? 'We’ll send a secure reset link to your email.'
                : 'A calmer, more organized day starts here.'
          }}
        </p>
        <form [formGroup]="form" (ngSubmit)="submit()">
          @if (mode() === 'signup') {
            <label
              >Your name<input
                autocomplete="name"
                formControlName="name"
                placeholder="What should we call you?"
            /></label>
          }
          @if (mode() !== 'password') {
            <label
              >Email address<input
                type="email"
                autocomplete="email"
                formControlName="email"
                placeholder="you@example.com"
            /></label>
          }
          @if (mode() !== 'reset') {
            <label
              >Password<input
                type="password"
                [attr.autocomplete]="mode() === 'signin' ? 'current-password' : 'new-password'"
                formControlName="password"
                placeholder="At least 8 characters"
            /></label>
          }
          @if (mode() === 'signin') {
            <button type="button" class="text-button forgot-link" (click)="setMode('reset')">
              Forgot password?
            </button>
          }
          @if (error()) {
            <p class="form-error" role="alert">{{ error() }}</p>
          }
          @if (message()) {
            <p class="form-success" role="status">{{ message() }}</p>
          }
          <button
            class="button primary auth-submit"
            type="submit"
            [disabled]="busy() || !auth.backend.configured"
          >
            {{
              busy()
                ? 'One moment…'
                : mode() === 'signup'
                  ? 'Create account'
                  : mode() === 'reset'
                    ? 'Send reset link'
                    : mode() === 'password'
                      ? 'Update password'
                      : 'Sign in'
            }}<app-icon name="arrow" />
          </button>
        </form>
        @if (!auth.backend.configured) {
          <div class="connection-note">
            <app-icon name="lock" />
            <p>
              Account sign-in will be available once a Supabase project is connected. Explore the
              demo below.
            </p>
          </div>
        }
        <div class="auth-mode">
          {{ mode() === 'signin' ? 'New here?' : 'Already have an account?'
          }}<button
            class="text-button"
            (click)="setMode(mode() === 'signin' ? 'signup' : 'signin')"
          >
            {{ mode() === 'signin' ? 'Create an account' : 'Sign in' }}
          </button>
        </div>
        <div class="auth-or"><span></span>or take a look around<span></span></div>
        <button class="button demo-button" (click)="demo()">
          <app-icon name="spark" />Explore a demo workspace<app-icon name="arrow" /></button
        ><small class="auth-private"
          ><app-icon name="lock" />Private by default. Always yours.</small
        >
      </div>
    </section>
  </div>`,
})
export class AuthPage implements OnInit {
  readonly auth = inject(AuthService);
  readonly router = inject(Router);
  readonly store = inject(LifeStore);
  readonly mode = signal<'signin' | 'signup' | 'reset' | 'password'>('signin');
  readonly error = signal('');
  readonly message = signal('');
  readonly busy = signal(false);
  readonly form = inject(FormBuilder).nonNullable.group({
    name: '',
    email: ['', Validators.email],
    password: '',
  });
  async ngOnInit() {
    await this.auth.ready;
    if (this.auth.recovery()) this.mode.set('password');
    else if (this.auth.user() && !this.auth.demo()) await this.router.navigateByUrl('/');
    if (this.auth.initError()) this.error.set(this.auth.initError());
  }
  setMode(mode: 'signin' | 'signup' | 'reset' | 'password') {
    this.mode.set(mode);
    this.error.set('');
    this.message.set('');
  }
  async demo() {
    this.auth.demo.set(true);
    this.store.clear();
    await this.router.navigateByUrl('/');
  }
  async submit() {
    const { name, email, password } = this.form.getRawValue();
    this.error.set('');
    this.message.set('');
    if (this.mode() !== 'password' && (!email || this.form.controls.email.invalid)) {
      this.error.set('Enter a valid email address.');
      return;
    }
    if (this.mode() !== 'reset' && password.length < 8) {
      this.error.set('Use a password with at least 8 characters.');
      return;
    }
    if (this.mode() === 'signup' && !name.trim()) {
      this.error.set('Please enter your name.');
      return;
    }
    this.busy.set(true);
    try {
      switch (this.mode()) {
        case 'signin':
          await this.auth.signIn(email, password);
          await this.router.navigateByUrl('/');
          break;
        case 'signup':
          if (await this.auth.signUp(email, password, name.trim()))
            await this.router.navigateByUrl('/');
          else this.message.set('Check your email to verify your account, then sign in.');
          break;
        case 'reset':
          await this.auth.reset(email);
          this.message.set(
            'If an account exists, you’ll receive a reset link shortly. Open it in this browser.',
          );
          break;
        case 'password':
          await this.auth.changePassword(password);
          await this.router.navigateByUrl('/');
          break;
      }
    } catch (e) {
      this.error.set(this.store.message(e));
    } finally {
      this.busy.set(false);
    }
  }
}
