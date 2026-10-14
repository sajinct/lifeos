import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { ProgressReportsPage } from './progress';
describe('Progress report page safety', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(ProgressReportsPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  it('labels snapshots separately from dated activity and provides monthly figures', async () => {
    const { fixture } = await setup();
    expect(fixture.nativeElement.textContent).toContain('Current snapshot');
    expect(fixture.nativeElement.textContent).toContain('Recorded time');
    expect(fixture.nativeElement.textContent).toContain('Task completion dates are not inferred');
  });
  it('hides totals and disables exports while workspace records are loading or failed', async () => {
    const { fixture, store } = await setup();
    store.loading.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Current snapshot');
    expect(fixture.nativeElement.querySelector('button').disabled).toBe(true);
    store.loading.set(false);
    store.error.set('Failed to load');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Failed to load');
    expect(fixture.nativeElement.textContent).not.toContain('Current snapshot');
  });
  it('resets dates and replaces owned totals after switching workspaces', async () => {
    const { fixture, page, store } = await setup();
    page.from.set('2000-01-01');
    await store.createWorkspace('Other reporting workspace', 'personal');
    fixture.detectChanges();
    expect(page.from()).not.toBe('2000-01-01');
    expect(page.result().report?.snapshot.tasks).toBe(0);
  });
  it('shows invalid date errors without rendering or exporting a report', async () => {
    const { fixture, page } = await setup();
    page.from.set('2026-02-30');
    fixture.detectChanges();
    expect(page.result().report).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Current snapshot');
  });
});
