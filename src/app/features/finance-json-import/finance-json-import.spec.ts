import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { FinanceJsonImportPage } from './finance-json-import';
describe('JSON import review and retry lifecycle', () => {
  async function setup() {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(FinanceJsonImportPage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.form.controls.text.setValue(
      JSON.stringify({
        accounts: [{ id: 'source', name: 'JSON bank', currency: 'INR', opening_balance: 0 }],
        transactions: [
          {
            id: 'tx',
            account_id: 'source',
            title: 'One expense',
            amount: 12,
            kind: 'expense',
            category: 'Other',
            booked_on: '2024-02-01',
          },
        ],
      }),
    );
    await page.preview();
    page.mapping.set({ source: 'new' });
    page.rebuild();
    fixture.detectChanges();
    return { fixture, page, store };
  }
  it('retains a prepared batch after failure and retries the exact request', async () => {
    const { fixture, page } = await setup();
    const save = vi
      .spyOn(page.importer, 'save')
      .mockRejectedValueOnce(new Error('Network failed'))
      .mockResolvedValueOnce({ accounts_created: 1, accounts_reused: 0, imported: 1, skipped: 0 });
    await page.save();
    fixture.detectChanges();
    const original = page.pending();
    expect(original).not.toBeNull();
    expect(fixture.nativeElement.querySelector('textarea').disabled).toBe(true);
    await page.save();
    expect(save.mock.calls[1][0]).toBe(original);
    expect(page.result()?.imported).toBe(1);
  });
  it('clears private previews and pending batches on session reset', async () => {
    const { fixture, page, store } = await setup();
    vi.spyOn(page.importer, 'save').mockRejectedValue(new Error('Failed'));
    await page.save();
    store.clear();
    fixture.detectChanges();
    expect(page.source()).toBeNull();
    expect(page.pending()).toBeNull();
    expect(page.rows()).toEqual([]);
    expect(page.form.controls.text.value).toBe('');
    expect(page.busy()).toBe(false);
  });
});
