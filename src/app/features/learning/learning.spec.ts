import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { UiService } from '../../core/services/ui';
import { LearningPage } from './learning';
describe('Learning page lifecycle and private drafts', () => {
  async function setup() {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: UiService, useValue: { notify: vi.fn() } }],
    });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(LearningPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  async function create(page: LearningPage) {
    page.create();
    page.form.patchValue({
      title: 'Learn Angular',
      goal: 'Build <script>literal</script>',
      notes: 'Private notes',
    });
    await page.save();
  }
  it('creates private learning, reveals saved rows after restrictive filters and renders literal text', async () => {
    const { fixture, page, store } = await setup();
    page.view.set('archived');
    page.kind.set('book');
    page.search.set('unrelated');
    await create(page);
    fixture.detectChanges();
    expect(page.rows()).toHaveLength(1);
    expect(store.learningItems()[0].visibility).toBe('private');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<script>literal</script>');
  });
  it('adds and completes a lesson, pauses/resumes and archives/restores through page actions', async () => {
    const { page, store } = await setup();
    await create(page);
    page.startUnit();
    page.unitForm.controls.title.setValue('Signals');
    await page.saveUnit();
    const lesson = store.learningUnits()[0];
    await page.changeUnit(lesson);
    expect(page.item()?.status).toBe('completed');
    await page.changeState(page.item()!, 'active');
    await page.changeState(page.item()!, 'paused');
    expect(page.canProgress()).toBe(false);
    await page.changeState(page.item()!, 'active');
    await page.changeState(page.item()!, 'active', true);
    expect(page.canProgress()).toBe(false);
    await page.changeState(page.item()!, 'active', false);
    expect(page.item()?.archived).toBe(false);
    expect(store.learningUnits()[0].done).toBe(true);
  });
  it('moves a file between reference and certificate purposes without duplicate selections', async () => {
    const { page } = await setup();
    page.toggleFile('file', 'reference', true);
    page.toggleFile('file', 'certificate', true);
    expect(page.selectedDocuments()).toEqual([]);
    expect(page.selectedCertificates()).toEqual(['file']);
    page.toggleFile('file', 'certificate', false);
    expect(page.selectedCertificates()).toEqual([]);
  });
  it('keeps failed actions frozen and retries with identical lesson revisions and request IDs', async () => {
    const { page } = await setup();
    await create(page);
    page.startUnit();
    page.unitForm.controls.title.setValue('Retry lesson');
    const unit = vi
      .spyOn(page.library, 'unit')
      .mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce(undefined);
    await page.saveUnit();
    expect(page.pending()).toBeDefined();
    page.unitForm.controls.title.setValue('Changed after failure');
    await page.retry();
    expect(unit.mock.calls[0]).toEqual(unit.mock.calls[1]);
    expect(page.pending()).toBeUndefined();
  });
  it('clears item/lesson drafts, selected links and retry closures on a workspace change', async () => {
    const { fixture, page, store } = await setup();
    await create(page);
    page.edit(page.item()!);
    page.form.controls.notes.setValue('Private unsaved draft');
    page.selectedNotes.set(['old-note']);
    page.selectedCertificates.set(['old-certificate']);
    page.unitForm.controls.notes.setValue('Private lesson draft');
    page.pending.set({ run: async () => {}, message: 'Old session' });
    await store.createWorkspace('Another learning workspace', 'personal');
    fixture.detectChanges();
    expect(page.editing()).toBe(false);
    expect(page.form.controls.notes.value).toBe('');
    expect(page.unitForm.controls.notes.value).toBe('');
    expect(page.pending()).toBeUndefined();
    expect(page.selectedCertificates()).toEqual([]);
    expect(page.selectedNotes()).toEqual([]);
    expect(page.item()).toBeUndefined();
  });
  it('blocks unsafe resource links even in legacy cached rows', async () => {
    const { page } = await setup();
    expect(page.safeUrl('javascript:alert(1)')).toBe('');
    expect(page.safeUrl('https://user:password@example.com')).toBe('');
    expect(page.safeUrl('https://example.com/@course')).toBe('https://example.com/@course');
  });
});
