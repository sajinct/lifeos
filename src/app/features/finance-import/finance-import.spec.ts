import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { FinanceImportPage } from './finance-import';

describe('Finance import review lifecycle', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(FinanceImportPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.form.setValue({
      account: store.accounts()[0].id,
      text: 'date,title,kind,amount,currency,category,reference\n2024-02-01,Review purchase,expense,12.50,INR,Other,review-1',
    });
    page.preview();
    fixture.detectChanges();
    return { fixture, page, store };
  }
  it('retains the exact request and locks editing after a failed save', async () => {
    const { fixture, page } = await setup();
    const save = vi
      .spyOn(page.importer, 'save')
      .mockRejectedValueOnce(new Error('Connection failed'))
      .mockResolvedValueOnce({ imported: 1, skipped: 0 });
    await page.save();
    fixture.detectChanges();
    const request = page.pending();
    expect(request).not.toBeNull();
    expect(fixture.nativeElement.querySelector('textarea').disabled).toBe(true);
    expect(page.error()).toContain('Connection failed');
    await page.save();
    fixture.detectChanges();
    expect(save.mock.calls[1][0]).toBe(request);
    expect(page.result()).toEqual({ imported: 1, skipped: 0 });
    expect(page.pending()).toBeNull();
  });
  it('discards pending previews and errors when the workspace session resets', async () => {
    const { fixture, page, store } = await setup();
    vi.spyOn(page.importer, 'save').mockRejectedValue(new Error('Retry later'));
    await page.save();
    store.clear();
    fixture.detectChanges();
    expect(page.pending()).toBeNull();
    expect(page.rows()).toEqual([]);
    expect(page.error()).toBe('');
    expect(page.form.controls.text.value).toBe('');
    expect(page.busy()).toBe(false);
  });
  it('ignores file contents arriving after session reset and clears the busy state', async () => {
    const { fixture, page, store } = await setup();
    let resolve!: (value: ArrayBuffer) => void;
    const input = {
      files: [
        {
          name: 'old.csv',
          size: 20,
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((r) => {
              resolve = r;
            }),
        },
      ],
      value: 'old.csv',
    };
    const read = page.file({ target: input } as unknown as Event);
    store.clear();
    fixture.detectChanges();
    resolve(new TextEncoder().encode('old private data').buffer);
    await read;
    expect(page.form.controls.text.value).toBe('');
    expect(page.busy()).toBe(false);
  });
});
