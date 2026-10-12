import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { ContactLibrary } from './contacts';
import { Backend } from '../supabase/client';
import { ContactInput, DEFAULT_REMINDERS } from '../models/domain';
import { validateContact, contactsCsv } from '../../shared/utilities/contacts';
import { reminderSources, reminderTitle } from '../../shared/utilities/reminders';
describe('Private contact lifecycle and follow-ups', () => {
  let store: LifeStore, library: ContactLibrary, input: ContactInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(ContactLibrary);
    input = {
      name: 'Sample person',
      kind: 'person',
      organization: 'Example organization',
      category: 'Professional',
      email: 'sample@example.com',
      phone: '+91 555 0100',
      website: 'https://example.com',
      address: '',
      notes: 'Synthetic only',
      next_follow_up: library.today(),
      follow_up_note: 'Discuss the project',
      last_contacted_on: '',
      project_ids: [store.projects()[0].id],
      loan_ids: [],
    };
  });
  it('validates email, phone, safe websites, calendar dates and link limits', () => {
    expect(
      validateContact(
        { ...input, name: ' Sample person ', project_ids: ['p', 'p'] },
        library.today(),
      ),
    ).toMatchObject({ name: 'Sample person', project_ids: ['p'] });
    for (const patch of [
      { email: 'bad\n@example.com' },
      { phone: '<script>' },
      { website: 'javascript:alert(1)' },
      { website: 'https://user:pass@example.com' },
      { next_follow_up: '2026-02-30' },
      { last_contacted_on: '2100-01-01' },
      { notes: 'x'.repeat(4001) },
      { project_ids: Array.from({ length: 51 }, (_, i) => String(i)) },
    ])
      expect(() => validateContact({ ...input, ...patch }, library.today())).toThrow();
  });
  it('saves once on retry, replaces owned links atomically and rejects stale revisions', async () => {
    const id = crypto.randomUUID();
    await library.save(id, input);
    await library.save(id, { ...input, name: 'Ignored retry' });
    expect(store.contacts()).toHaveLength(1);
    expect(store.contactLinks()).toHaveLength(1);
    const old = store.contacts()[0];
    await library.save(id, { ...input, name: 'Edited person', project_ids: [] }, old);
    expect(store.contacts()[0].revision).toBe(2);
    expect(store.contactLinks()).toHaveLength(0);
    await expect(library.save(id, input, old)).rejects.toThrow(/changed/);
  });
  it('rejects unavailable links before changing contact metadata', async () => {
    await expect(
      library.save(crypto.randomUUID(), { ...input, project_ids: ['missing'] }),
    ).rejects.toThrow(/own/);
    expect(store.contacts()).toHaveLength(0);
    await library.save(crypto.randomUUID(), input);
    const old = store.contacts()[0];
    await expect(library.save(old.id, { ...input, loan_ids: ['missing'] }, old)).rejects.toThrow();
    expect(store.contacts()[0].revision).toBe(1);
  });
  it('supports reversible archive, keeps links and completes a follow-up once', async () => {
    await library.save(crypto.randomUUID(), input);
    const row = store.contacts()[0];
    await library.setStatus(row, 'archived');
    await library.setStatus(row, 'archived');
    expect(store.contactLinks()).toHaveLength(1);
    await expect(library.save(row.id, input, store.contacts()[0])).rejects.toThrow();
    await library.setStatus(store.contacts()[0], 'active');
    const active = store.contacts()[0];
    await library.contacted(active);
    await library.contacted(active);
    expect(store.contacts()[0]).toMatchObject({
      last_contacted_on: library.today(),
      next_follow_up: null,
      follow_up_note: '',
      revision: 4,
    });
    await library.save(row.id, { ...input, next_follow_up: '2100-01-01' }, store.contacts()[0]);
    await expect(library.contacted(active)).rejects.toThrow(/changed/);
    expect(store.contacts()[0].next_follow_up).toBe('2100-01-01');
  });
  it('generates contact reminders only when opted in and the contact is active', async () => {
    await library.save(crypto.randomUUID(), input);
    const row = store.contacts()[0];
    expect(reminderSources(DEFAULT_REMINDERS, [], [], [], [], [], [row])).toHaveLength(0);
    const p = { ...DEFAULT_REMINDERS, contact_reminders: true },
      sources = reminderSources(p, [], [], [], [], [], [row]);
    expect(sources).toHaveLength(1);
    expect(reminderTitle(sources[0], 'upcoming')).toContain('Contact follow-up due');
    expect(reminderSources(p, [], [], [], [], [], [{ ...row, status: 'archived' }])).toHaveLength(
      0,
    );
  });
  it('exports escaped contact fields and link identity without spreadsheet formulas', async () => {
    await library.save(crypto.randomUUID(), {
      ...input,
      name: '=HYPERLINK("bad")',
      notes: 'a,b\nline',
    });
    const text = contactsCsv(store.contacts(), store.contactLinks(), store.projects(), []);
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain('sample@example.com');
    expect(text).toContain('a,b\nline');
    expect(text).toContain(store.projects()[0].title);
  });
  it('preserves contacts by demo workspace and clears private state on logout', async () => {
    await library.save(crypto.randomUUID(), input);
    const w = store.workspace()!;
    await store.createWorkspace('Another', 'personal');
    expect(store.contacts()).toHaveLength(0);
    expect(store.contactLinks()).toHaveLength(0);
    await store.switchWorkspace(w);
    expect(store.contacts()).toHaveLength(1);
    expect(store.contactLinks()).toHaveLength(1);
    store.clear();
    expect(store.contacts()).toHaveLength(0);
    expect(store.contactLinks()).toHaveLength(0);
  });
  it('drops late saves after real sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.save(crypto.randomUUID(), input);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.contacts()).toHaveLength(0);
  });
});
