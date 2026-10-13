import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { HealthLibrary } from './health';
import { FileLibrary } from './file-library';
import { Reminders } from './reminders';
import { HealthInput, DEFAULT_REMINDERS, HealthAppointment } from '../models/domain';
import { emptyHealth, validateHealth, healthCsv } from '../../shared/utilities/health';
describe('Private health appointments', () => {
  let store: LifeStore, library: HealthLibrary, input: HealthInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(HealthLibrary);
    input = {
      ...emptyHealth(library.today()),
      title: 'Sample visit',
      provider: 'Example clinic',
      appointment_time: '10:30',
    };
  });
  it('validates dates, times, fields and future completion', () => {
    for (const patch of [
      { title: '' },
      { appointment_on: '2026-02-30' },
      { appointment_on: '2101-01-01' },
      { appointment_time: '24:01' },
      { appointment_time: '9:30' },
      { provider: 'x'.repeat(201) },
      { location: 'x'.repeat(301) },
      { notes: 'x'.repeat(4001) },
      { appointment_on: '2100-12-31', status: 'completed' as const },
    ])
      expect(() => validateHealth({ ...input, ...patch }, library.today())).toThrow();
    expect(
      validateHealth({ ...input, appointment_time: '', title: ' Visit ' }, library.today()).title,
    ).toBe('Visit');
  });
  it('keeps stable requests and rejects stale edits', async () => {
    await library.save('one', input);
    const old = store.healthAppointments()[0];
    await library.save('one', { ...input, title: 'Ignored' });
    expect(store.healthAppointments()[0].title).toBe('Sample visit');
    await library.save('one', { ...input, title: 'Revised' }, old);
    await expect(library.save('one', input, old)).rejects.toThrow(/changed/);
  });
  it('preserves completed status through archive/restore and blocks stale actions', async () => {
    await library.save('one', input);
    const old = store.healthAppointments()[0];
    await library.act(old, 'complete');
    await library.act(old, 'complete');
    expect(store.healthAppointments()[0].revision).toBe(2);
    await expect(library.act(old, 'reopen')).rejects.toThrow(/changed/);
    await library.act(store.healthAppointments()[0], 'archive');
    await expect(library.save('one', input, store.healthAppointments()[0])).rejects.toThrow(
      /Restore/,
    );
    await expect(library.act(store.healthAppointments()[0], 'reopen')).rejects.toThrow(/restore/);
    await library.act(store.healthAppointments()[0], 'restore');
    expect(store.healthAppointments()[0]).toMatchObject({ status: 'completed', archived: false });
    await library.act(store.healthAppointments()[0], 'reopen');
    await library.act(store.healthAppointments()[0], 'cancel');
    expect(store.healthAppointments()[0].status).toBe('cancelled');
  });
  it('rejects future completion and actions on other owners', async () => {
    await library.save('future', { ...input, appointment_on: '2100-12-31' });
    await expect(library.act(store.healthAppointments()[0], 'complete')).rejects.toThrow(/future/);
    await library.act(store.healthAppointments()[0], 'cancel');
    await expect(
      library.act({ ...store.healthAppointments()[0], owner_id: 'other' }, 'archive'),
    ).rejects.toThrow(/inaccessible/);
  });
  it('links owned immutable versions and exports safe labels', async () => {
    const files = TestBed.inject(FileLibrary);
    await files.upload(
      new File(['Synthetic visit note'], 'visit-note.txt', { type: 'text/plain' }),
      'personal-documents',
      { category: 'Health', expires_on: '', project_id: '', transaction_id: '' },
    );
    const f = store.attachments()[0];
    await library.save('one', {
      ...input,
      title: '=Sample visit',
      notes: '+Notes',
      document_ids: [f.id, f.id],
    });
    expect(store.healthDocuments()).toHaveLength(1);
    await files.archive(f);
    expect((await library.openDocument(f.id))?.status).toBe('archived');
    const text = healthCsv(
      store.healthAppointments(),
      store.healthDocuments(),
      library.documents(),
    );
    expect(text).toContain("'=Sample visit");
    expect(text).toContain("'+Notes");
    expect(text).toContain('visit-note.txt');
    await library.act(store.healthAppointments()[0], 'archive');
    expect(store.healthDocuments()).toHaveLength(1);
    await expect(library.save('bad', { ...input, document_ids: ['missing'] })).rejects.toThrow(
      /completed document/,
    );
    expect(store.healthAppointments()).toHaveLength(1);
  });
  it('keeps reminders opt-in, private, retry-safe and cleared by cancellation', async () => {
    const reminders = TestBed.inject(Reminders);
    await library.save('one', input);
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
    await reminders.save({ ...DEFAULT_REMINDERS, health_reminders: true, reminder_hour: 0 });
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(1);
    const n = reminders.visible()[0];
    expect(n.source_kind).toBe('health_appointment');
    expect(reminders.path(n)).toBe('/health');
    expect(n.title).toMatch(/^Health appointment due/);
    await reminders.refresh();
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(1);
    await library.act(store.healthAppointments()[0], 'cancel');
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
    await library.act(store.healthAppointments()[0], 'reopen');
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
    await expect(reminders.save({ ...DEFAULT_REMINDERS, health_lead_days: 91 })).rejects.toThrow(
      /timing/,
    );
  });
  it('clears stale rescheduled reminders and opt-out without sharing notices', async () => {
    const reminders = TestBed.inject(Reminders);
    await library.save('one', input);
    await reminders.save({ ...DEFAULT_REMINDERS, health_reminders: true, reminder_hour: 0 });
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(1);
    await library.save(
      'one',
      { ...input, appointment_on: '2100-12-31' },
      store.healthAppointments()[0],
    );
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
    await library.save('two', input);
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(1);
    await reminders.save({ ...DEFAULT_REMINDERS, reminder_hour: 0 });
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
  });
  it('isolates workspace caches and clears health records on sign-out', async () => {
    await library.save('one', input);
    const original = store.workspace()!;
    await store.createWorkspace('Other', 'family');
    expect(store.healthAppointments()).toHaveLength(0);
    await expect(
      library.act(
        { workspace_id: original.id, owner_id: 'demo-user' } as HealthAppointment,
        'archive',
      ),
    ).rejects.toThrow(/inaccessible/);
    await store.switchWorkspace(original);
    expect(store.healthAppointments()).toHaveLength(1);
    store.clear();
    expect(store.healthAppointments()).toHaveLength(0);
    expect(store.healthDocuments()).toHaveLength(0);
  });
  it('does not republish a late cloud save after sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace'),
      pending = library.save('one', input);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.healthAppointments()).toHaveLength(0);
  });
});
