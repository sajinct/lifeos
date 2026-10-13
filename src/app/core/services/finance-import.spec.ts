import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { FinanceImporter } from './finance-import';
import { parseImportCsv } from '../../shared/utilities/finance-import';
describe('Finance CSV preview and retry safety', () => {
  let store: LifeStore, importer: FinanceImporter, account: string;
  const headers = 'date,title,kind,amount,currency,category,reference\r\n';
  const text = (patch = '') =>
    headers + (patch || '2024-02-01,New groceries,expense,12.50,INR,Food,ref-1');
  const ready = () => importer.preview(text(), account)[0].row!;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    importer = TestBed.inject(FinanceImporter);
    account = store.accounts()[0].id;
  });
  it('parses BOM, commas, escaped quotes, blank lines and multiline quoted fields', () => {
    const rows = parseImportCsv('\uFEFFa,b\r\n\r\n"a, b","say ""yes""\nnext"\r\n');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 3, cells: ['a, b', 'say "yes"\nnext'] },
    ]);
  });
  it('rejects malformed quoting, empty files, oversized files and row counts', () => {
    for (const data of [
      'a,b',
      'a,b\n"unfinished,b',
      'a,b\na"b,c',
      'a,b\n"x" trailing,y',
      'x'.repeat(1024 * 1024 + 1),
      'a\n' + 'b\n'.repeat(501),
    ])
      expect(() => parseImportCsv(data)).toThrow();
  });
  it('requires unambiguous headers but supports reordered columns and optional references', () => {
    expect(
      importer.preview(
        'amount,kind,title,date,category,currency\n12,expense,Food,2024-02-01,Food,INR',
        account,
      )[0].status,
    ).toBe('ready');
    for (const data of [
      'date,title,kind,amount,currency\n2024-02-01,x,expense,1,INR',
      headers.replace('reference', 'account_id') + 'a,b,c,d,e,f,g',
      headers.replace('reference', 'title') + 'a,b,c,d,e,f,g',
    ])
      expect(() => importer.preview(data, account)).toThrow(/headers/);
  });
  it('validates money without rounding, real dates, types, currencies and field lengths', () => {
    for (const line of [
      '2024-02-30,x,expense,1,INR,Food,',
      '1899-01-01,x,expense,1,INR,Food,',
      '2100-01-01,x,expense,1,INR,Food,',
      '2024-02-01,x,expense,1.001,INR,Food,',
      '2024-02-01,x,expense,0,INR,Food,',
      '2024-02-01,x,transfer_out,1,INR,Food,',
      '2024-02-01,x,expense,1,USD,Food,',
      '2024-02-01,,expense,1,INR,Food,',
      '2024-02-01,x,expense,1,INR,,',
      '2024-02-01,x,expense,1,INR,Food,extra,column',
    ])
      expect(importer.preview(text(line), account)[0].status).toBe('invalid');
  });
  it('flags exact row duplicates and conflicting references before saving', () => {
    const rows = importer.preview(
      text() +
        '\n2024-02-01,New groceries,expense,12.50,INR,Food,ref-1\n2024-02-01,Changed,expense,13,INR,Food,ref-1',
      account,
    );
    expect(rows.map((r) => r.status)).toEqual(['ready', 'duplicate', 'invalid']);
  });
  it('imports once, retries without changes, and detects reuploads', async () => {
    const before = store.transactions().length,
      request = importer.prepare(account, [ready()]);
    expect(await importer.save(request)).toEqual({ imported: 1, skipped: 0 });
    expect(await importer.save(request)).toEqual({ imported: 1, skipped: 0 });
    expect(store.transactions().length).toBe(before + 1);
    expect(importer.preview(text(), account)[0].status).toBe('duplicate');
    await expect(
      importer.save({ ...request, rows: [{ ...request.rows[0], amount: '15.00' }] }),
    ).rejects.toThrow(/reused/);
  });
  it('rolls back a demo batch when a later row conflicts with a saved reference', async () => {
    await importer.save(importer.prepare(account, [ready()]));
    const before = store.transactions().length;
    await expect(
      importer.save(
        importer.prepare(account, [
          { ...readyFallback(), title: 'Would insert', reference: 'new' },
          { ...readyFallback(), amount: '14.00' },
        ]),
      ),
    ).rejects.toThrow(/Reference/);
    expect(store.transactions().length).toBe(before);
  });
  function readyFallback() {
    return {
      date: '2024-02-01',
      title: 'New groceries',
      kind: 'expense' as const,
      amount: '12.50',
      currency: 'INR',
      category: 'Food',
      reference: 'ref-1',
    };
  }
  it('rejects another user’s account, read-only access and stale sessions', async () => {
    const request = importer.prepare(account, [ready()]);
    store.accounts.update((list) => list.map((a) => ({ ...a, owner_id: 'other' })));
    expect(() => importer.preview(text(), account)).toThrow(/own account/);
    store.fileSession.update((s) => s + 1);
    await expect(importer.save(request)).rejects.toThrow(/Workspace changed/);
  });
  it('keeps formula-like titles literal during validation and bookkeeping', async () => {
    const row = importer.preview(
      text('2024-02-01,"=SUM(A1)",expense,1,INR,Other,+reference'),
      account,
    )[0].row!;
    await importer.save(importer.prepare(account, [row]));
    expect(store.transactions().at(-1)?.title).toBe('=SUM(A1)');
  });
  it('ignores a late cloud response after session reset', async () => {
    const request = importer.prepare(account, [ready()]);
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as never);
    let resolve!: (value: unknown) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: vi.fn(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    } as never);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = importer.save(request);
    store.clear();
    resolve({ data: { imported: 1, skipped: 0 }, error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.transactions()).toEqual([]);
  });
});
