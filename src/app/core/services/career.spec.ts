import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { CareerLibrary } from './career';
import { Backend } from '../supabase/client';
import { FileLibrary } from './file-library';
import { CareerInput, DEFAULT_REMINDERS } from '../models/domain';
import { emptyCareer, validateCareer, careerCsv } from '../../shared/utilities/career';
import { reminderSources, reminderTitle } from '../../shared/utilities/reminders';
describe('Private Career lifecycle', () => {
  let store: LifeStore, library: CareerLibrary, input: CareerInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(CareerLibrary);
    input = {
      ...emptyCareer('application', library.today()),
      title: 'Example role',
      organization: 'Example company',
      skills: 'Angular',
      follow_up_on: library.today(),
      interview_on: library.today(),
    };
  });
  it('validates section-specific dates, text, links and status', () => {
    for (const patch of [
      { title: '' },
      { url: 'javascript:alert(1)' },
      { status: 'active' as const },
      { applied_on: '2026-02-30' },
      { interview_on: '1900-01-01' },
      { notes: 'x'.repeat(4001) },
    ])
      expect(() => validateCareer({ ...input, ...patch }, library.today())).toThrow();
    expect(() =>
      validateCareer(
        {
          ...input,
          ...emptyCareer('employment', library.today()),
          title: 'Role',
          organization: 'Company',
          ends_on: '1900-01-01',
        },
        library.today(),
      ),
    ).toThrow();
    expect(() =>
      validateCareer(
        {
          ...emptyCareer('certification', library.today()),
          title: 'Certificate',
          organization: 'Issuer',
          starts_on: '2025-01-01',
          expires_on: '2024-01-01',
        },
        library.today(),
      ),
    ).toThrow();
  });
  it('keeps request retries idempotent and rejects stale edits and section changes', async () => {
    await library.save('a', input);
    await library.save('a', { ...input, title: 'Ignored' });
    expect(store.careerRecords()[0].title).toBe(input.title);
    const old = store.careerRecords()[0];
    await library.save('a', { ...input, title: 'Changed' }, old);
    await expect(library.save('a', input, old)).rejects.toThrow(/changed/);
    await expect(
      library.save(
        'a',
        { ...emptyCareer('employment', library.today()), title: 'Job', organization: 'Company' },
        store.careerRecords()[0],
      ),
    ).rejects.toThrow(/section/);
  });
  it('completes dates once and blocks stale actions against rescheduled dates', async () => {
    await library.save('a', input);
    const old = store.careerRecords()[0];
    await library.act(old, 'follow_up');
    await library.act(old, 'follow_up');
    expect(store.careerRecords()[0].revision).toBe(2);
    await library.save('a', { ...input, follow_up_on: '2100-01-01' }, store.careerRecords()[0]);
    await expect(library.act(old, 'follow_up')).rejects.toThrow(/changed/);
    expect(store.careerRecords()[0].follow_up_on).toBe('2100-01-01');
    await library.act(store.careerRecords()[0], 'interview');
    expect(store.careerRecords()[0].interview_on).toBeNull();
  });
  it('keeps all reminder types opt-in, separate and stopped by closed or archived status', async () => {
    await library.save('a', input);
    await library.save('c', {
      ...emptyCareer('certification', library.today()),
      title: 'Cert',
      organization: 'Issuer',
      expires_on: library.today(),
    });
    const sources = (enabled: boolean) =>
      reminderSources(
        { ...DEFAULT_REMINDERS, career_reminders: enabled },
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        new Date(),
        [],
        [],
        store.careerRecords(),
      );
    expect(sources(false)).toHaveLength(0);
    expect(
      sources(true)
        .map((s) => s.kind)
        .sort(),
    ).toEqual(['career_follow_up', 'career_interview', 'certification']);
    expect(
      reminderTitle(
        sources(true).find((s) => s.kind === 'certification')!,
        'upcoming',
      ),
    ).toContain('Certification expires');
    await library.save(
      'a',
      { ...input, status: 'accepted' },
      store.careerRecords().find((r) => r.id === 'a'),
    );
    await library.act(
      store.careerRecords().find((r) => r.id === 'c')!,
      'archive',
    );
    expect(sources(true)).toHaveLength(0);
    await expect(
      library.act(
        store.careerRecords().find((r) => r.id === 'a')!,
        'follow_up',
      ),
    ).rejects.toThrow(/closed/);
  });
  it('links owned file versions, preserves archives and exports formula-safe CSV', async () => {
    const files = TestBed.inject(FileLibrary);
    await files.upload(
      new File(['Synthetic CV'], 'sample-cv.txt', { type: 'text/plain' }),
      'personal-documents',
      { category: 'CV', expires_on: '', project_id: '', transaction_id: '' },
    );
    const f = store.attachments()[0];
    await library.save('a', { ...input, title: '=Sample role', document_ids: [f.id, f.id] });
    expect(store.careerDocuments()).toHaveLength(1);
    await files.archive(f);
    expect((await library.openDocument(f.id))?.status).toBe('archived');
    const text = careerCsv(store.careerRecords(), store.careerDocuments(), library.documents());
    expect(text).toContain("'=Sample role");
    expect(text).toContain('sample-cv.txt');
    await library.act(store.careerRecords()[0], 'archive');
    expect(store.careerDocuments()).toHaveLength(1);
    await library.act(store.careerRecords()[0], 'restore');
    expect(store.careerRecords()[0].status).toBe('applied');
    await expect(library.save('b', { ...input, document_ids: ['missing'] })).rejects.toThrow(
      /completed document/,
    );
    expect(store.careerRecords()).toHaveLength(1);
  });
  it('caches demo records by workspace and clears them at signout', async () => {
    await library.save('a', input);
    const original = store.workspace()!;
    await store.createWorkspace('Career demo', 'professional');
    expect(store.careerRecords()).toHaveLength(0);
    await store.switchWorkspace(original);
    expect(store.careerRecords()).toHaveLength(1);
    store.clear();
    expect(store.careerRecords()).toHaveLength(0);
    expect(store.careerDocuments()).toHaveLength(0);
  });
  it('does not republish a late cloud save after signout', async () => {
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
    expect(store.careerRecords()).toHaveLength(0);
  });
});
