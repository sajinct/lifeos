import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { ShoppingImportPage } from './shopping-import';
import { shoppingImportTemplate } from '../../shared/utilities/shopping-import';
describe('Shopping JSON review and import screen', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(ShoppingImportPage);
    fixture.detectChanges();
    return { fixture, page: fixture.componentInstance, store };
  }
  it('previews literal titles and item states, selects lists and displays import counts', async () => {
    const { fixture, page, store } = await setup();
    const root = JSON.parse(shoppingImportTemplate());
    root.shoppingLists[0].title = '<img src=x onerror=alert(1)>';
    root.shoppingItems[0].checked = true;
    page.form.controls.text.setValue(JSON.stringify(root));
    await page.preview();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('img')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(fixture.nativeElement.textContent).toContain('1 checked');
    await page.save();
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Import complete');
    expect(store.shoppingLists()[0].visibility).toBe('private');
  });
  it('withholds duplicates, invalid rows and unselected lists', async () => {
    const { page, store } = await setup();
    page.form.controls.text.setValue(shoppingImportTemplate());
    await page.preview();
    page.toggle(0);
    await page.save();
    expect(store.shoppingLists()).toEqual([]);
    expect(page.error()).toContain('Select');
    page.discard();
    page.form.controls.text.setValue(shoppingImportTemplate());
    await page.preview();
    await page.save();
    page.form.controls.text.setValue(shoppingImportTemplate());
    await page.preview();
    expect(page.ready()).toBe(0);
    expect(page.selected().size).toBe(0);
  });
  it('freezes a failed batch and retries it unchanged', async () => {
    const { page } = await setup();
    page.form.controls.text.setValue(shoppingImportTemplate());
    await page.preview();
    const spy = vi
      .spyOn(page.importer, 'save')
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ lists_imported: 1, items_imported: 1, skipped: 0 });
    await page.save();
    const request = page.pending();
    page.toggle(0);
    expect(page.selected().size).toBe(1);
    await page.save();
    expect(spy.mock.calls[1][0]).toBe(request);
    expect(page.pending()).toBeNull();
  });
  it('clears file previews and frozen requests on workspace changes', async () => {
    const { fixture, page, store } = await setup();
    page.form.controls.text.setValue(shoppingImportTemplate());
    await page.preview();
    vi.spyOn(page.importer, 'save').mockRejectedValue(new Error('Offline'));
    await page.save();
    expect(page.pending()).not.toBeNull();
    await store.createWorkspace('Other', 'personal');
    fixture.detectChanges();
    expect(page.pending()).toBeNull();
    expect(page.source()).toBeNull();
    expect(page.form.controls.text.value).toBe('');
  });
});
