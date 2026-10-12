import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { AssetLibrary } from './assets';
import { FileLibrary } from './file-library';
import { Backend } from '../supabase/client';
import { AssetInput, MaintenanceInput, DEFAULT_REMINDERS } from '../models/domain';
import {
  assetMoney,
  validateAsset,
  nextService,
  assetsCsv,
  maintenanceCsv,
} from '../../shared/utilities/assets';
import { reminderSources, reminderTitle } from '../../shared/utilities/reminders';
describe('Asset lifecycle and scheduled maintenance', () => {
  let store: LifeStore, library: AssetLibrary, input: AssetInput, plan: MaintenanceInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(AssetLibrary);
    input = {
      name: 'Sample washer',
      category: 'Appliance',
      manufacturer: 'Example',
      model: 'Sample A',
      serial_number: 'SAMPLE-1',
      location: 'Home',
      purchased_on: '2025-01-01',
      purchase_price: '100.50',
      currency: 'INR',
      warranty_until: library.today(),
      notes: 'Synthetic only',
      document_ids: [],
    };
    plan = {
      asset_id: 'a',
      title: 'Clean filter',
      next_on: '2025-01-31',
      frequency: 'monthly',
      notes: '',
    };
  });
  it('validates prices, purchase/warranty dates and metadata', () => {
    expect(assetMoney('')).toBeNull();
    expect(assetMoney('0')).toBe(0);
    for (const value of ['-1', '1.001', 'NaN', '1000000000000'])
      expect(() => assetMoney(value)).toThrow();
    for (const patch of [
      { name: '' },
      { purchased_on: '2200-01-01' },
      { warranty_until: '2024-01-01' },
      { warranty_until: '2026-02-30' },
      { notes: 'x'.repeat(4001) },
    ])
      expect(() => validateAsset({ ...input, ...patch }, library.today())).toThrow();
  });
  it('creates one asset on retries and rejects stale edits without changing documents', async () => {
    await library.save('a', input);
    await library.save('a', { ...input, name: 'Ignored' });
    expect(store.assets()).toHaveLength(1);
    const old = store.assets()[0];
    await library.save('a', { ...input, name: 'Edited' }, old);
    await expect(library.save('a', input, old)).rejects.toThrow(/changed/);
    await expect(
      library.save('a', { ...input, document_ids: ['missing'] }, store.assets()[0]),
    ).rejects.toThrow(/document/);
    expect(store.assets()[0].revision).toBe(2);
  });
  it('keeps immutable service history, stable retries, month-end anchoring and Finance unchanged', async () => {
    await library.save('a', input);
    await library.savePlan('p', plan);
    const p = store.maintenancePlans()[0],
      ledger = store.transactions().length;
    await library.record('s', p, {
      performed_on: library.today(),
      cost: '12.50',
      notes: 'Completed',
    });
    await library.record('s', p, {
      performed_on: library.today(),
      cost: '99',
      notes: 'Ignored retry',
    });
    expect(store.maintenanceLogs()).toHaveLength(1);
    expect(store.maintenanceLogs()[0].cost).toBe(12.5);
    expect(store.maintenancePlans()[0].next_on).toBe('2025-02-28');
    await expect(
      library.record('different', p, { performed_on: library.today(), cost: '0', notes: '' }),
    ).rejects.toThrow(/changed/);
    await library.record('s2', store.maintenancePlans()[0], {
      performed_on: library.today(),
      cost: '',
      notes: '',
    });
    expect(store.maintenancePlans()[0].next_on).toBe('2025-03-31');
    expect(store.transactions()).toHaveLength(ledger);
  });
  it('blocks completed-date rescheduling and stale completion after a new anchor', async () => {
    await library.save('a', input);
    await library.savePlan('p', plan);
    const old = store.maintenancePlans()[0];
    await library.record('s', old, { performed_on: library.today(), cost: '', notes: '' });
    await expect(library.savePlan('p', plan, store.maintenancePlans()[0])).rejects.toThrow(
      /already completed/,
    );
    await library.savePlan('p', { ...plan, next_on: '2025-03-01' }, store.maintenancePlans()[0]);
    expect(store.maintenancePlans()[0].anchor_on).toBe('2025-03-01');
    await expect(
      library.record('s2', old, { performed_on: library.today(), cost: '', notes: '' }),
    ).rejects.toThrow(/changed/);
  });
  it('stops work on retired assets and supports paused and one-time schedules', async () => {
    await library.save('a', input);
    await library.savePlan('p', { ...plan, frequency: 'once' });
    await library.pause(store.maintenancePlans()[0]);
    await expect(
      library.record('s', store.maintenancePlans()[0], {
        performed_on: library.today(),
        cost: '',
        notes: '',
      }),
    ).rejects.toThrow(/inactive/);
    await library.pause(store.maintenancePlans()[0]);
    await library.record('s', store.maintenancePlans()[0], {
      performed_on: library.today(),
      cost: '',
      notes: '',
    });
    expect(store.maintenancePlans()[0].status).toBe('completed');
    await expect(library.pause(store.maintenancePlans()[0])).rejects.toThrow(/cannot resume/);
    await library.setStatus(store.assets()[0], 'retired');
    await expect(library.savePlan('other', plan)).rejects.toThrow(/active asset/);
    expect(store.maintenanceLogs()).toHaveLength(1);
    await library.setStatus(store.assets()[0], 'active');
    expect(store.assets()[0].status).toBe('active');
  });
  it('handles yearly leap-day anchors and supported range boundaries', async () => {
    await library.save('a', input);
    await library.savePlan('p', { ...plan, next_on: '2024-02-29', frequency: 'yearly' });
    expect(nextService(store.maintenancePlans()[0])).toBe('2025-02-28');
    await library.savePlan('p', { ...plan, next_on: '2100-12-31' }, store.maintenancePlans()[0]);
    expect(() => nextService(store.maintenancePlans()[0])).toThrow(/range/);
  });
  it('creates opt-in warranty/service sources only for active owned assets', async () => {
    await library.save('a', input);
    await library.savePlan('p', plan);
    const sources = (enabled: boolean) =>
      reminderSources(
        { ...DEFAULT_REMINDERS, asset_reminders: enabled },
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        new Date(),
        store.assets(),
        store.maintenancePlans(),
      );
    expect(sources(false)).toHaveLength(0);
    expect(sources(true)).toHaveLength(2);
    expect(reminderTitle(sources(true)[0], 'overdue')).toContain('Asset warranty expired');
    await library.setStatus(store.assets()[0], 'sold');
    expect(sources(true)).toHaveLength(0);
  });
  it('exports formula-safe details and service currency snapshots', async () => {
    await library.save('a', { ...input, name: '=HYPERLINK("bad")' });
    await library.savePlan('p', plan);
    await library.record('s', store.maintenancePlans()[0], {
      performed_on: library.today(),
      cost: '10',
      notes: 'a,b\nline',
    });
    expect(assetsCsv(store.assets(), [], [])).toContain("'=HYPERLINK");
    const text = maintenanceCsv(store.maintenancePlans(), store.maintenanceLogs(), store.assets());
    expect(text).toContain('INR');
    expect(text).toContain('a,b\nline');
  });
  it('keeps workspace memory separate and clears assets and history on sign-out', async () => {
    await library.save('a', input);
    await library.savePlan('p', plan);
    const w = store.workspace()!;
    await store.createWorkspace('Other', 'personal');
    expect(store.assets()).toHaveLength(0);
    await store.switchWorkspace(w);
    expect(store.maintenancePlans()).toHaveLength(1);
    store.clear();
    expect(store.assets()).toHaveLength(0);
    expect(store.maintenancePlans()).toHaveLength(0);
    expect(store.assetDocuments()).toHaveLength(0);
  });
  it('drops late cloud mutations after sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.save('a', input);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.assets()).toHaveLength(0);
  });
  it('links completed file versions and opens the correct document or receipt library', async () => {
    const files = TestBed.inject(FileLibrary),
      details = { category: 'Warranty', expires_on: '', project_id: '', transaction_id: '' };
    await files.upload(
      new File(['Synthetic manual'], 'manual.txt', { type: 'text/plain' }),
      'personal-documents',
      details,
    );
    await files.upload(
      new File(['%PDF-1.4 synthetic fixture'], 'receipt.pdf', { type: 'application/pdf' }),
      'financial-receipts',
      details,
    );
    const ids = store.attachments().map((f) => f.id);
    await library.save('a', { ...input, document_ids: ids });
    expect(store.assetDocuments()).toHaveLength(2);
    const receipt = store.attachments().find((f) => f.bucket_id === 'financial-receipts')!;
    expect((await library.openDocument(receipt.id))?.bucket_id).toBe('financial-receipts');
    await files.archive(receipt);
    expect((await library.openDocument(receipt.id))?.status).toBe('archived');
    const exported = assetsCsv(store.assets(), store.assetDocuments(), library.documents());
    expect(exported).toContain('receipt.pdf');
    expect(exported).toContain('manual.txt');
  });
});
