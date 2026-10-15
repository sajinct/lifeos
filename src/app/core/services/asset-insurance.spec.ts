import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { AssetInsuranceLibrary } from './asset-insurance';
import { AssetInsuranceInput } from '../models/domain';
import { FileLibrary } from './file-library';
import {
  insuranceCsv,
  insuranceStatus,
  validateInsurance,
} from '../../shared/utilities/asset-insurance';
describe('Private asset policy records and renewal history', () => {
  let store: LifeStore, library: AssetInsuranceLibrary, input: AssetInsuranceInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(AssetInsuranceLibrary);
    await library.assets.save('asset', {
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
    input = {
      asset_id: 'asset',
      title: ' Car policy ',
      provider: ' Example insurer ',
      policy_number: ' P-1 ',
      starts_on: '2026-01-01',
      ends_on: '2026-12-31',
      coverage_amount: '10000',
      premium_amount: '125.25',
      currency: 'inr',
      premium_frequency: 'yearly',
      notes: ' <script>literal</script> ',
      document_ids: [],
    };
  });
  async function save() {
    const id = crypto.randomUUID(),
      req = crypto.randomUUID();
    await library.save(req, id, input);
    return { id, req };
  }
  function p(id: string) {
    return library.rows().find((p) => p.id === id)!;
  }
  it('validates ordered real dates, amounts and policy details while allowing blank amounts', () => {
    expect(validateInsurance(input)).toMatchObject({
      title: 'Car policy',
      provider: 'Example insurer',
      policy_number: 'P-1',
      currency: 'INR',
      coverage_amount: 10000,
      premium_amount: 125.25,
    });
    for (const changes of [
      { starts_on: '2026-02-30' },
      { ends_on: '2025-12-31' },
      { coverage_amount: '0' },
      { coverage_amount: '1e4' },
      { premium_amount: '1.234' },
      { premium_amount: '-1' },
      { provider: '' },
      { notes: '\0bad' },
    ])
      expect(() => validateInsurance({ ...input, ...changes })).toThrow();
    expect(validateInsurance({ ...input, coverage_amount: '', premium_amount: '' })).toMatchObject({
      coverage_amount: null,
      premium_amount: null,
    });
  });
  it('stores private policy metadata without changing the asset, Finance, or account balances', async () => {
    const before = JSON.stringify([store.assets(), store.accounts(), store.transactions()]);
    const { id } = await save();
    expect(p(id)).toMatchObject({
      visibility: 'private',
      owner_id: 'demo-user',
      revision: 1,
      cancelled: false,
      archived: false,
    });
    expect(JSON.stringify([store.assets(), store.accounts(), store.transactions()])).toBe(before);
  });
  it('preserves exact successful retries without undoing newer cancellations and archives', async () => {
    const { id, req } = await save();
    const original = structuredClone(p(id));
    await library.state(crypto.randomUUID(), p(id), true, true);
    await library.save(req, id, input);
    expect(p(id)).toMatchObject({ revision: 2, cancelled: true, archived: true });
    await expect(library.save(req, id, { ...input, title: 'Changed' })).rejects.toThrow(
      /already used/,
    );
    await expect(library.save(crypto.randomUUID(), id, input, original)).rejects.toThrow(/changed/);
    await expect(library.save(crypto.randomUUID(), id, input, p(id))).rejects.toThrow(
      /Restore or reopen/,
    );
    await library.state(crypto.randomUUID(), p(id), false, false);
    await library.save(crypto.randomUUID(), id, { ...input, premium_amount: '150' }, p(id));
    expect(p(id).premium_amount).toBe(150);
  });
  it('links only owned completed document versions and replacing links keeps file metadata unchanged', async () => {
    const files = TestBed.inject(FileLibrary);
    await files.upload(
      new File(['hello'], 'Policy.txt', { type: 'text/plain' }),
      'personal-documents',
      { category: 'Policy', expires_on: '', project_id: '', transaction_id: '' },
    );
    const file = store.attachments()[0],
      before = JSON.stringify(store.attachments());
    input.document_ids = [file.id];
    const { id } = await save();
    expect(library.documents(p(id)).map((l) => l.attachment_id)).toEqual([file.id]);
    expect(JSON.stringify(store.attachments())).toBe(before);
    await expect(
      library.save(crypto.randomUUID(), id, { ...input, document_ids: ['foreign'] }, p(id)),
    ).rejects.toThrow(/own completed/);
    expect(library.documents(p(id))).toHaveLength(1);
    await library.save(crypto.randomUUID(), id, { ...input, document_ids: [] }, p(id));
    expect(library.documents(p(id))).toEqual([]);
  });
  it('creates separate renewal records and refuses to move an existing policy to another asset', async () => {
    const { id } = await save();
    const renewal = crypto.randomUUID();
    await library.save(crypto.randomUUID(), renewal, {
      ...input,
      starts_on: '2027-01-01',
      ends_on: '2027-12-31',
    });
    expect(library.rows()).toHaveLength(2);
    expect(p(id).starts_on).toBe('2026-01-01');
    await expect(
      library.save(crypto.randomUUID(), id, { ...input, asset_id: 'other' }, p(id)),
    ).rejects.toThrow(/your own asset/);
  });
  it('retains inactive asset history, permits state corrections and blocks metadata edits', async () => {
    const { id } = await save();
    store.assets.update((rows) => rows.map((a) => ({ ...a, status: 'sold' })));
    await expect(library.save(crypto.randomUUID(), id, input, p(id))).rejects.toThrow(
      /Restore the asset/,
    );
    await library.state(crypto.randomUUID(), p(id), true, true);
    expect(p(id).archived).toBe(true);
  });
  it('uses inclusive date labels and protects literal CSV fields without mixing currencies or periods', async () => {
    input.provider = '=formula';
    const { id } = await save();
    expect(insuranceStatus(p(id), '2026-01-01')).toBe('Within recorded dates');
    expect(insuranceStatus(p(id), '2026-12-31')).toBe('Within recorded dates');
    expect(insuranceStatus(p(id), '2025-12-31')).toBe('Upcoming');
    expect(insuranceStatus(p(id), '2027-01-01')).toBe('Ended');
    const csv = insuranceCsv(library.rows(), () => '+asset');
    expect(csv).toContain("'=formula");
    expect(csv).toContain("'+asset");
    expect(csv).toContain('yearly');
  });
  it('isolates policy metadata and document links across workspace switches and new sessions', async () => {
    const { id } = await save(),
      original = store.workspace()!;
    await store.createWorkspace('Other', 'personal');
    expect(library.rows()).toEqual([]);
    await expect(library.save(crypto.randomUUID(), id, input)).rejects.toThrow(/your own asset/);
    await store.switchWorkspace(original);
    expect(p(id)).toBeDefined();
    store.clear();
    await store.initialize();
    expect(library.rows()).toEqual([]);
  });
});
describe('Hosted insurance refresh failures keep request identities', () => {
  const rpc = vi.fn();
  it('repeats the exact server save after refresh failure and discards late context results', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: Backend, useValue: { client: null, requireClient: () => ({ rpc }) } }],
    });
    const auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'owner' } as User);
    const store = TestBed.inject(LifeStore);
    store.profile.set({ id: 'owner', display_name: 'Owner', currency: 'INR', timezone: 'UTC' });
    store.workspace.set({ id: 'w', owner_id: 'owner', name: 'Workspace', kind: 'personal' });
    store.members.set([{ workspace_id: 'w', user_id: 'owner', role: 'owner' }]);
    store.assets.set([
      {
        id: 'asset',
        owner_id: 'owner',
        workspace_id: 'w',
        visibility: 'private',
        created_at: '',
        updated_at: '',
        name: 'Asset',
        category: 'Other',
        manufacturer: '',
        model: '',
        serial_number: '',
        location: '',
        purchased_on: null,
        purchase_price: null,
        currency: 'INR',
        warranty_until: null,
        notes: '',
        status: 'active',
        revision: 1,
      },
    ]);
    const library = TestBed.inject(AssetInsuranceLibrary);
    const input: AssetInsuranceInput = {
      asset_id: 'asset',
      title: 'Policy',
      provider: 'Insurer',
      policy_number: '',
      starts_on: '2026-01-01',
      ends_on: '2026-12-31',
      coverage_amount: '',
      premium_amount: '',
      currency: 'INR',
      premium_frequency: 'yearly',
      notes: '',
      document_ids: [],
    };
    rpc.mockResolvedValue({ data: 'entry', error: null });
    vi.spyOn(store, 'switchWorkspace').mockImplementation(async () => {
      store.error.set('Refresh failed');
    });
    await expect(library.save('request', 'entry', input)).rejects.toThrow(
      /Retry this change safely/,
    );
    const first = rpc.mock.calls.at(-1);
    await expect(library.save('request', 'entry', input)).rejects.toThrow(
      /Retry this change safely/,
    );
    expect(rpc.mock.calls.at(-1)).toEqual(first);
  });
});
