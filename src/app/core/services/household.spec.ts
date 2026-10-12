import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { LifeStore } from './life-store';
import { HouseholdLibrary } from './household';
import { Backend } from '../supabase/client';
import { HouseholdMemberInput, HouseholdEntryInput, DEFAULT_REMINDERS } from '../models/domain';
import {
  householdAnniversary,
  validateHouseholdMember,
  validateHouseholdEntry,
  householdCsv,
} from '../../shared/utilities/household';
import { reminderSources, reminderTitle } from '../../shared/utilities/reminders';
describe('Household records and annual reminders', () => {
  let store: LifeStore,
    library: HouseholdLibrary,
    member: HouseholdMemberInput,
    entry: HouseholdEntryInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(HouseholdLibrary);
    member = {
      name: 'Sample housemate',
      relationship: 'Housemate',
      birthday: '02-29',
      notes: 'Synthetic only',
      visibility: 'private',
    };
    entry = {
      title: 'Water plants',
      kind: 'task',
      due_on: library.today(),
      annual: false,
      member_id: '',
      notes: 'Synthetic only',
      visibility: 'private',
    };
  });
  it('validates month/day, date, text and annual task restrictions', () => {
    for (const birthday of ['02-30', '13-01', '01-00', '2026-01-01'])
      expect(() => validateHouseholdMember({ ...member, birthday })).toThrow();
    expect(validateHouseholdMember({ ...member, name: ' Sam ' })).toMatchObject({ name: 'Sam' });
    for (const patch of [
      { title: '' },
      { due_on: '2026-02-30' },
      { annual: true },
      { notes: 'x'.repeat(4001) },
      { kind: 'date' as const, due_on: '' },
    ])
      expect(() => validateHouseholdEntry({ ...entry, ...patch })).toThrow();
  });
  it('preserves leap-day anchors across normal, leap and year-boundary occurrences', () => {
    expect(householdAnniversary('2000-02-29', '2027-02-28')).toBe('2027-02-28');
    expect(householdAnniversary('2000-02-29', '2027-03-01')).toBe('2028-02-29');
    expect(householdAnniversary('2000-01-01', '2026-12-31')).toBe('2027-01-01');
  });
  it('saves creation once and refuses stale member and entry edits', async () => {
    const id = crypto.randomUUID();
    await library.saveMember(id, member);
    await library.saveMember(id, { ...member, name: 'Ignored' });
    expect(store.householdMembers()).toHaveLength(1);
    const old = store.householdMembers()[0];
    await library.saveMember(id, { ...member, name: 'Updated' }, old);
    await expect(library.saveMember(id, member, old)).rejects.toThrow(/changed/);
    const eid = crypto.randomUUID();
    await library.saveEntry(eid, entry);
    await library.saveEntry(eid, entry);
    const previous = store.householdEntries()[0];
    await library.saveEntry(eid, { ...entry, title: 'Updated' }, previous);
    await expect(library.saveEntry(eid, entry, previous)).rejects.toThrow(/changed/);
  });
  it('rejects shared links to private members and guards visibility changes atomically', async () => {
    await library.saveMember('m', member);
    await expect(
      library.saveEntry('t', { ...entry, member_id: 'm', visibility: 'workspace' }),
    ).rejects.toThrow(/matching sharing/);
    expect(store.householdEntries()).toHaveLength(0);
    await library.saveMember(
      'm',
      { ...member, visibility: 'workspace' },
      store.householdMembers()[0],
    );
    await library.saveEntry('t', { ...entry, member_id: 'm', visibility: 'workspace' });
    await expect(library.saveMember('m', member, store.householdMembers()[0])).rejects.toThrow(
      /Unlink/,
    );
    await expect(
      library.saveEntry('t', { ...entry, member_id: 'missing' }, store.householdEntries()[0]),
    ).rejects.toThrow(/accessible/);
    expect(store.householdEntries()[0].member_id).toBe('m');
  });
  it('completes and reopens tasks with safe replay and reversible archives', async () => {
    await library.saveEntry('t', entry);
    const old = store.householdEntries()[0];
    await library.status(old, 'done');
    await library.status(old, 'done');
    expect(store.householdEntries()[0].revision).toBe(2);
    await library.status(store.householdEntries()[0], 'active');
    await expect(library.status(old, 'done')).rejects.toThrow(/changed/);
    await library.saveMember('m', member);
    await library.status(store.householdMembers()[0], 'archived');
    await library.status(store.householdMembers()[0], 'active');
    expect(store.householdMembers()[0].birthday).toBe('02-29');
    await expect(library.status(store.householdMembers()[0], 'done')).rejects.toThrow(/Only/);
  });
  it('uses reminder time zones, opt-in and active status for annual personal notices', async () => {
    await library.saveMember('m', { ...member, birthday: '10-12' });
    await library.saveEntry('t', entry);
    await library.saveEntry('d', { ...entry, kind: 'date', due_on: '2000-10-12', annual: true });
    const sources = (enabled: boolean) =>
      reminderSources(
        { ...DEFAULT_REMINDERS, family_reminders: enabled, reminder_timezone: 'Asia/Kolkata' },
        [],
        [],
        [],
        [],
        [],
        [],
        store.householdMembers(),
        store.householdEntries(),
        new Date('2026-10-11T20:00:00Z'),
      );
    expect(sources(false)).toHaveLength(0);
    expect(sources(true)).toHaveLength(3);
    expect(sources(true).find((s) => s.kind === 'family_birthday')?.date).toBe('2026-10-12');
    expect(reminderTitle(sources(true)[0], 'upcoming')).toContain('Birthday due');
    await library.status(store.householdMembers()[0], 'archived');
    await library.status(
      store.householdEntries().find((e) => e.id === 't')!,
      'done',
    );
    expect(sources(true)).toHaveLength(1);
  });
  it('exports formula-safe fields and preserves separate workspace memory until logout', async () => {
    await library.saveMember('m', { ...member, name: '=HYPERLINK("bad")', notes: 'a,b\nline' });
    await library.saveEntry('t', { ...entry, member_id: 'm' });
    const text = householdCsv(
      store.householdMembers(),
      store.householdEntries(),
      store.householdMembers(),
    );
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain('a,b\nline');
    const w = store.workspace()!;
    await store.createWorkspace('Other', 'family');
    expect(store.householdMembers()).toHaveLength(0);
    await store.switchWorkspace(w);
    expect(store.householdEntries()).toHaveLength(1);
    store.clear();
    expect(store.householdMembers()).toHaveLength(0);
    expect(store.householdEntries()).toHaveLength(0);
  });
  it('drops late cloud results after sign-out', async () => {
    const auth = TestBed.inject(AuthService);
    auth.demo.set(false);
    auth.user.set({ id: 'demo-user' } as User);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace');
    const pending = library.saveMember('m', member);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.householdMembers()).toHaveLength(0);
  });
});
