import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { FinanceJsonImporter } from './finance-json-import';
import { parseFinanceJson } from '../../shared/utilities/finance-json-import';
describe('JSON finance source validation and additive imports', () => {
  let store: LifeStore, importer: FinanceJsonImporter;
  const file = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({
      accounts: [
        {
          id: 'source-a',
          name: 'Imported bank',
          currency: 'INR',
          opening_balance: '100.00',
          owner_id: 'untrusted',
          workspace_id: 'untrusted',
        },
      ],
      transactions: [
        {
          id: 'source-x',
          account_id: 'source-a',
          title: 'Imported purchase',
          kind: 'expense',
          amount: '12.50',
          category: 'Other',
          booked_on: '2024-02-01',
          import_reference: 'json-ref',
        },
      ],
      ...patch,
    });
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    importer = TestBed.inject(FinanceJsonImporter);
  });
  async function request(target = 'new', text = file()) {
    const p = await importer.preview(text);
    p.mapping['source-a'] = target;
    return importer.prepare(p.source, p.mapping, p.links, new Set([0]));
  }
  it('reads current LifeOS export shape, ignores untrusted ownership and lists omitted modules', () => {
    const source = parseFinanceJson(file({ tasks: [{ id: 'task' }] }), importer.today());
    expect(source.accounts[0].error).toBe('');
    expect(source.transactions[0].status).toBe('ready');
    expect(source.omitted).toEqual(['tasks']);
  });
  it('rejects malformed JSON, missing arrays, duplicate IDs and oversized files', () => {
    for (const text of [
      '{',
      '[]',
      '{"accounts":[]}',
      file({ accounts: [] }),
      file({ accounts: Array.from({ length: 51 }, (_, i) => ({ id: String(i) })) }),
      'x'.repeat(5 * 1024 * 1024 + 1),
      file({ transactions: [{ id: 'x' }, { id: 'x' }] }),
    ])
      expect(() => parseFinanceJson(text, importer.today())).toThrow();
  });
  it('flags invalid money precision, dates, currencies and linked module entries', () => {
    const rows = [
      {
        id: 'precision',
        account_id: 'source-a',
        title: 'Bad',
        kind: 'expense',
        amount: 1.001,
        category: 'Other',
        booked_on: '2024-02-01',
      },
      {
        id: 'date',
        account_id: 'source-a',
        title: 'Bad',
        kind: 'expense',
        amount: 1,
        category: 'Other',
        booked_on: '2024-02-30',
      },
      {
        id: 'currency',
        account_id: 'source-a',
        title: 'Bad',
        kind: 'expense',
        amount: 1,
        currency: 'USD',
        category: 'Other',
        booked_on: '2024-02-01',
      },
      { id: 'transfer', kind: 'transfer_out' },
      { id: 'loan', kind: 'expense', loan_id: 'loan' },
      { id: 'project', kind: 'expense', project_id: 'project' },
    ];
    expect(
      parseFinanceJson(file({ transactions: rows }), importer.today()).transactions.map(
        (r) => r.status,
      ),
    ).toEqual(['invalid', 'invalid', 'invalid', 'unsupported', 'unsupported', 'unsupported']);
    expect(
      parseFinanceJson(
        file({
          accounts: [{ id: 'source-a', name: 'Bad', currency: 'INR', opening_balance: '1.001' }],
        }),
        importer.today(),
      ).accounts[0].error,
    ).toContain('two decimals');
  });
  it('creates owned accounts with signed opening balances and imports once on retry', async () => {
    const r = await request();
    const before = store.accounts().length;
    expect(await importer.save(r)).toEqual({
      accounts_created: 1,
      accounts_reused: 0,
      imported: 1,
      skipped: 0,
    });
    expect(await importer.save(r)).toEqual({
      accounts_created: 1,
      accounts_reused: 0,
      imported: 1,
      skipped: 0,
    });
    expect(store.accounts().length).toBe(before + 1);
    const created = store.accounts().at(-1)!;
    expect(created.owner_id).toBe('demo-user');
    expect(created.workspace_id).toBe(store.workspace()!.id);
    expect(created.opening_balance).toBe(100);
    await expect(
      importer.save({ ...r, payload: { ...r.payload, transactions: [] } }),
    ).rejects.toThrow(/reused/);
  });
  it('reuses saved account mappings on reupload and flags changed source IDs', async () => {
    await importer.save(await request());
    const p = await importer.preview(file());
    expect(p.mapping['source-a']).not.toBe('skip');
    expect(p.mapping['source-a']).not.toBe('new');
    expect(importer.review(p.source, p.mapping, p.links)[0].status).toBe('duplicate');
    p.source.transactions[0].row!.title = 'Changed';
    expect(importer.review(p.source, p.mapping, p.links)[0].status).toBe('invalid');
    p.mapping['source-a'] = 'new';
    expect(() => importer.prepare(p.source, p.mapping, p.links, new Set())).toThrow(
      /saved destination/,
    );
  });
  it('leaves existing account names and balances unchanged and skips manual matches', async () => {
    const a = store.accounts()[0],
      before = { ...a };
    await importer.save(await request(a.id));
    expect(store.accounts()[0]).toEqual(before);
    const p = await importer.preview(file());
    p.mapping['source-a'] = a.id;
    expect(importer.review(p.source, p.mapping, p.links)[0].status).toBe('duplicate');
  });
  it('rolls back demo account creation and prior rows when any transaction fails', async () => {
    const r = await request();
    r.payload.transactions.push({
      ...r.payload.transactions[0],
      source_id: 'bad',
      row: { ...r.payload.transactions[0].row, amount: '1.001' },
    });
    const accounts = store.accounts(),
      ledger = store.transactions();
    await expect(importer.save(r)).rejects.toThrow(/Invalid transaction/);
    expect(store.accounts()).toEqual(accounts);
    expect(store.transactions()).toEqual(ledger);
  });
  it('rejects another user’s account, mismatched currency and exported orphan card creation', async () => {
    const r = await request();
    r.payload.accounts[0].target_id = store.accounts()[0].id;
    r.payload.accounts[0].currency = 'USD';
    await expect(importer.save(r)).rejects.toThrow(/same-currency/);
    r.payload.accounts[0].currency = 'INR';
    store.accounts.update((list) => list.map((a) => ({ ...a, owner_id: 'other' })));
    await expect(importer.save(r)).rejects.toThrow(/own same-currency/);
    const p = await importer.preview(file({ creditCards: [{ account_id: 'source-a' }] }));
    p.mapping['source-a'] = 'new';
    expect(() => importer.prepare(p.source, p.mapping, p.links, new Set([0]))).toThrow(
      /existing credit cards/,
    );
  });
  it('skips exact duplicate rows across source accounts mapped to one destination', async () => {
    const p = await importer.preview(
      file({
        accounts: [
          { id: 'source-a', name: 'A', currency: 'INR', opening_balance: 0 },
          { id: 'source-b', name: 'B', currency: 'INR', opening_balance: 0 },
        ],
        transactions: [
          {
            id: 'one',
            account_id: 'source-a',
            title: 'Same',
            kind: 'expense',
            amount: 1,
            category: 'Other',
            booked_on: '2024-02-01',
          },
          {
            id: 'two',
            account_id: 'source-b',
            title: 'Same',
            kind: 'expense',
            amount: 1,
            category: 'Other',
            booked_on: '2024-02-01',
          },
        ],
      }),
    );
    p.mapping = { 'source-a': store.accounts()[0].id, 'source-b': store.accounts()[0].id };
    expect(importer.review(p.source, p.mapping, p.links).map((r) => r.status)).toEqual([
      'ready',
      'duplicate',
    ]);
  });
  it('retries a committed batch even when a failed refresh clears cached membership and accounts', async () => {
    const request = await (async () => {
      const p = await importer.preview(file());
      p.mapping['source-a'] = 'new';
      return importer.prepare(p.source, p.mapping, p.links, new Set([0]));
    })();
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    const rpc = vi.fn().mockResolvedValue({
      data: { accounts_created: 1, accounts_reused: 0, imported: 1, skipped: 0 },
      error: null,
    });
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({ rpc } as never);
    vi.spyOn(store, 'switchWorkspace')
      .mockImplementationOnce(async () => {
        store.accounts.set([]);
        store.members.set([]);
        store.error.set('Network failed');
      })
      .mockImplementationOnce(async () => {
        store.error.set('');
      });
    await expect(importer.save(request)).rejects.toThrow(/refresh failed/);
    expect(store.writable()).toBe(false);
    expect((await importer.save(request)).imported).toBe(1);
    expect(rpc.mock.calls[0][1].entry).toBe(rpc.mock.calls[1][1].entry);
  });
  it('does not reload or expose records after a late cloud completion', async () => {
    const r = await request();
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    let resolve!: (v: unknown) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    } as never);
    const reload = vi.spyOn(store, 'switchWorkspace'),
      pending = importer.save(r);
    store.clear();
    resolve({
      data: { accounts_created: 1, accounts_reused: 0, imported: 1, skipped: 0 },
      error: null,
    });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.accounts()).toEqual([]);
  });
});
