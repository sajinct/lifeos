import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { AuthService } from '../../core/auth/auth';
import { LifeStore } from '../../core/services/life-store';
import { AssetInsurancePage } from './asset-insurance';
describe('Asset insurance editing and history', () => {
  async function setup() {
    const params = new BehaviorSubject(convertToParamMap({}));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { queryParamMap: params } },
      ],
    });
    TestBed.inject(AuthService).demo.set(true);
    const store = TestBed.inject(LifeStore);
    await store.initialize();
    const fixture = TestBed.createComponent(AssetInsurancePage),
      page = fixture.componentInstance;
    vi.spyOn(page.library.assets, 'today').mockReturnValue('2026-01-15');
    await page.library.assets.save('asset', {
      name: 'Synthetic car',
      category: 'Vehicle',
      manufacturer: '',
      model: '',
      serial_number: '',
      location: '',
      purchased_on: '',
      purchase_price: '',
      currency: 'INR',
      warranty_until: '',
      notes: '',
      document_ids: [],
    });
    fixture.detectChanges();
    return { fixture, page, store, params };
  }
  async function create(page: AssetInsurancePage) {
    await page.add();
    page.form.patchValue({
      asset_id: 'asset',
      title: '<script>Policy</script>',
      provider: 'Example insurer',
      policy_number: 'P-100',
      starts_on: '2026-01-01',
      ends_on: '2026-01-31',
      coverage_amount: '10000',
      premium_amount: '125.25',
      currency: 'INR',
      premium_frequency: 'yearly',
    });
    await page.save();
  }
  it('saves literal policy details, displays India date boundaries correctly and derives expiry counts', async () => {
    const { fixture, page } = await setup();
    await create(page);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('<script>Policy</script>');
    expect(fixture.nativeElement.querySelector('script')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('1 Jan 2026');
    expect(fixture.nativeElement.textContent).toContain('31 Jan 2026');
    expect(page.counts()).toMatchObject({ current: 1, ending: 1, ended: 0 });
  });
  it('keeps invalid form input editable without creating a frozen server request', async () => {
    const { page } = await setup();
    await page.add();
    page.form.patchValue({
      asset_id: 'asset',
      title: 'Policy',
      provider: 'Example',
      starts_on: '2026-02-30',
      ends_on: '2026-12-31',
    });
    await page.save();
    expect(page.pending()).toBeNull();
    expect(page.opened()).toBe(true);
    expect(page.error()).toContain('dates');
  });
  it('creates a renewal draft with empty dates and documents while retaining the older policy', async () => {
    const { page, store } = await setup();
    await create(page);
    const old = page.library.rows()[0];
    await page.add(old, true);
    expect(page.editing()).toBeNull();
    expect(page.form.controls.starts_on.value).toBe('');
    expect(page.form.controls.ends_on.value).toBe('');
    expect(page.form.controls.document_ids.value).toEqual([]);
    page.form.patchValue({ starts_on: '2027-01-01', ends_on: '2027-12-31' });
    await page.save();
    expect(store.assetInsurance()).toHaveLength(2);
    expect(page.library.rows().find((p) => p.id === old.id)?.starts_on).toBe('2026-01-01');
  });
  it('retains exact retry payloads and clears them when switching workspace', async () => {
    const { fixture, page, store } = await setup();
    await page.add();
    page.form.patchValue({
      asset_id: 'asset',
      title: 'Policy',
      provider: 'Example',
      starts_on: '2026-01-01',
      ends_on: '2026-12-31',
    });
    const spy = vi.spyOn(page.library, 'save').mockRejectedValue(new Error('Offline'));
    await page.save();
    const first = spy.mock.calls[0];
    await page.retry();
    expect(spy.mock.calls[1]).toEqual(first);
    await store.createWorkspace('Other', 'personal');
    fixture.detectChanges();
    expect(page.pending()).toBeNull();
    expect(page.opened()).toBe(false);
  });
  it('shows reversible cancellation/archive history and opens exact search links', async () => {
    const { fixture, page, params } = await setup();
    await create(page);
    let p = page.library.rows()[0];
    await page.state(p, true, true);
    page.view.set('archived');
    expect(page.rows()).toHaveLength(1);
    p = page.library.rows()[0];
    await page.state(p, false, false);
    page.view.set('cancelled');
    expect(page.rows()).toHaveLength(0);
    params.next(convertToParamMap({ linked: p.id }));
    fixture.detectChanges();
    expect(page.rows()).toHaveLength(1);
    expect(fixture.nativeElement.textContent).toContain('Showing the selected policy');
  });
});
