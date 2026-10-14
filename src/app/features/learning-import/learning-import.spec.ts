import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { LearningImportPage } from './learning-import';
import { learningImportTemplate } from '../../shared/utilities/learning-import';
describe('Learning JSON import page', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(LearningImportPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  it('previews selected learning and renders a completed import with lessons', async () => {
    const { fixture, page, store } = await setup();
    page.form.controls.text.setValue(learningImportTemplate());
    await page.preview();
    expect(page.ready()).toBe(1);
    await page.save();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Import complete');
    expect(store.learningUnits()).toHaveLength(1);
  });
  it('freezes a failed batch and retries exactly the same payload and request ID', async () => {
    const { page } = await setup();
    page.form.controls.text.setValue(learningImportTemplate());
    await page.preview();
    const save = vi
      .spyOn(page.importer, 'save')
      .mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce({ items_imported: 1, lessons_imported: 1, skipped: 0 });
    await page.save();
    expect(page.pending()).not.toBeNull();
    page.toggle(0);
    await page.save();
    expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
    expect(page.pending()).toBeNull();
  });
  it('clears private previews, drafts and pending batches on workspace changes', async () => {
    const { fixture, page, store } = await setup();
    page.form.controls.text.setValue(learningImportTemplate());
    await page.preview();
    await store.createWorkspace('Another import', 'personal');
    fixture.detectChanges();
    expect(page.form.controls.text.value).toBe('');
    expect(page.source()).toBeNull();
    expect(page.pending()).toBeNull();
    expect(page.selected().size).toBe(0);
  });
  it('allows invalid rows to remain visible while excluding them from selection', async () => {
    const { page } = await setup(),
      root = JSON.parse(learningImportTemplate());
    root.learningItems.push({
      ...root.learningItems[0],
      id: 'invalid',
      title: '',
      due_on: '2026-02-30',
    });
    page.form.controls.text.setValue(JSON.stringify(root));
    await page.preview();
    expect(page.source()?.rows).toHaveLength(2);
    expect(page.selected().size).toBe(1);
    expect(page.source()?.rows[1].error).not.toBe('');
  });
});
