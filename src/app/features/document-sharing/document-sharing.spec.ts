import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { DocumentSharingPage } from './document-sharing';
describe('Document sharing screen', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(DocumentSharingPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  it('shows the privacy boundary and a usable empty state with a simulated sample', async () => {
    const { fixture, page } = await setup();
    expect(fixture.nativeElement.textContent).toContain('Copies already saved cannot be recalled');
    expect(fixture.nativeElement.textContent).toContain('Add sample document');
    await page.sample();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('select[name="document"]')).not.toBeNull();
  });
  it('shares, revokes and restores the selected version while keeping filenames literal', async () => {
    const { fixture, page, store } = await setup();
    await page.sample();
    store.attachments.update((rows) =>
      rows.map((a) => ({ ...a, name: '<img src=x onerror=alert(1)>.txt' })),
    );
    page.source.set(page.library.choices()[0].id);
    page.recipient.set('demo-reader');
    await page.share();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<img src=x onerror=alert(1)>.txt');
    await page.change(page.library.rows()[0]);
    page.filter.set('all');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Revoked');
    await page.change(page.library.rows()[0]);
    fixture.detectChanges();
    expect(page.library.rows()[0].revoked).toBe(false);
  });
  it('keeps an interrupted share request unchanged for an exact retry', async () => {
    const { page } = await setup();
    await page.sample();
    page.source.set(page.library.choices()[0].id);
    page.recipient.set('demo-reader');
    const spy = vi
      .spyOn(page.library, 'set')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce();
    await page.share();
    await page.share();
    expect(spy.mock.calls[1]).toEqual(spy.mock.calls[0]);
  });
  it('clears a private draft when the workspace changes', async () => {
    const { fixture, page, store } = await setup();
    await page.sample();
    page.source.set(page.library.choices()[0].id);
    page.recipient.set('demo-reader');
    await store.createWorkspace('Other', 'personal');
    fixture.detectChanges();
    expect(page.source()).toBe('');
    expect(page.recipient()).toBe('');
  });
});
