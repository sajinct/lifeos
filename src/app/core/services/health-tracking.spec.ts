import { TestBed } from '@angular/core/testing';
import { User } from '@supabase/supabase-js';
import { AuthService } from '../auth/auth';
import { Backend } from '../supabase/client';
import { LifeStore } from './life-store';
import { HealthTracking } from './health-tracking';
import { Reminders } from './reminders';
import { HealthLogInput, MedicationInput, DEFAULT_REMINDERS } from '../models/domain';
import {
  validateHealthLog,
  validateMedication,
  measurementHistory,
  medicalTotals,
  healthLogsCsv,
} from '../../shared/utilities/health-tracking';
import { reminderSources } from '../../shared/utilities/reminders';
describe('Private wellness tracking', () => {
  let store: LifeStore, library: HealthTracking, log: HealthLogInput, med: MedicationInput;
  beforeEach(async () => {
    TestBed.configureTestingModule({});
    TestBed.inject(AuthService).demo.set(true);
    store = TestBed.inject(LifeStore);
    await store.initialize();
    library = TestBed.inject(HealthTracking);
    log = {
      kind: 'fitness',
      title: 'Walk',
      logged_on: library.health.today(),
      minutes: '30',
      value: '2.5',
      unit: 'km',
      notes: '',
    };
    med = {
      title: 'Synthetic schedule',
      instructions: 'User entered text',
      starts_on: library.health.today(),
      ends_on: '',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      reminder_time: '00:00',
      timezone: 'UTC',
    };
  });
  it('validates log precision, durations, units and future dates', () => {
    for (const patch of [
      { minutes: '0' },
      { minutes: '1.5' },
      { minutes: '1441' },
      { value: '1e2' },
      { value: 'NaN' },
      { value: '1.0001' },
      { unit: '' },
      { logged_on: '2100-12-31' },
      { kind: 'measurement' as const, minutes: '30' },
      { kind: 'measurement' as const, minutes: '', value: '' },
    ])
      expect(() => validateHealthLog({ ...log, ...patch }, library.health.today())).toThrow();
    expect(
      validateHealthLog(
        { ...log, kind: 'measurement', minutes: '', value: '0', unit: 'score' },
        library.health.today(),
      ).value,
    ).toBe(0);
  });
  it('replays logs, rejects stale edits and retains archive history', async () => {
    await library.saveLog('one', log);
    const old = store.healthLogs()[0];
    await library.saveLog('one', { ...log, title: 'Ignored' });
    await library.saveLog('one', { ...log, minutes: '45' }, old);
    await expect(library.saveLog('one', log, old)).rejects.toThrow(/changed/);
    await library.act(store.healthLogs()[0], 'log', 'archive');
    await expect(library.saveLog('one', log, store.healthLogs()[0])).rejects.toThrow(/restore/);
    await library.act(store.healthLogs()[0], 'log', 'restore');
    expect(store.healthLogs()[0].minutes).toBe(45);
  });
  it('groups measurement history by unit and owner, excluding archives', async () => {
    await library.saveLog('first', {
      ...log,
      kind: 'measurement',
      title: 'Weight',
      minutes: '',
      value: '70',
      unit: 'kg',
      logged_on: '2026-10-01',
    });
    await library.saveLog('second', {
      ...log,
      kind: 'measurement',
      title: 'Weight',
      minutes: '',
      value: '71',
      unit: 'kg',
    });
    await library.saveLog('other-unit', {
      ...log,
      kind: 'measurement',
      title: 'Weight',
      minutes: '',
      value: '155',
      unit: 'lb',
    });
    const groups = measurementHistory(store.healthLogs());
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.latest.unit === 'kg')?.previous?.value).toBe(70);
    await library.act(
      store.healthLogs().find((r) => r.id === 'second')!,
      'log',
      'archive',
    );
    expect(
      measurementHistory(store.healthLogs()).find((g) => g.latest.unit === 'kg')?.latest.value,
    ).toBe(70);
    expect(
      healthLogsCsv([{ ...store.healthLogs()[0], title: '=formula', notes: '+Notes' }]),
    ).toContain("'=formula");
  });
  it('validates schedule days, dates, time and zone and preserves pause through edits/archives', async () => {
    for (const patch of [
      { weekdays: [] },
      { weekdays: [1, 1] },
      { weekdays: [7] },
      { timezone: 'Unknown/Zone' },
      { reminder_time: '24:01' },
      { ends_on: '1900-01-01' },
    ])
      expect(() => validateMedication({ ...med, ...patch })).toThrow();
    await library.saveMedication('one', med);
    const initial = store.medicationPlans()[0];
    await library.act(initial, 'medication', 'pause');
    await library.act(initial, 'medication', 'pause');
    await expect(library.act(initial, 'medication', 'resume')).rejects.toThrow(/changed/);
    await library.saveMedication('one', { ...med, title: 'Changed' }, store.medicationPlans()[0]);
    expect(store.medicationPlans()[0].active).toBe(false);
    await library.act(store.medicationPlans()[0], 'medication', 'archive');
    await library.act(store.medicationPlans()[0], 'medication', 'restore');
    expect(store.medicationPlans()[0].active).toBe(false);
  });
  it('checks reminder minutes and local weekdays in the medication timezone', async () => {
    await library.saveMedication('one', {
      ...med,
      starts_on: '2026-10-13',
      weekdays: [2],
      reminder_time: '09:00',
      timezone: 'Asia/Kolkata',
    });
    const prefs = { ...DEFAULT_REMINDERS, medication_reminders: true, reminder_hour: 23 };
    const sources = (now: string) =>
      reminderSources(
        prefs,
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        [],
        new Date(now),
        [],
        [],
        [],
        [],
        store.medicationPlans(),
      );
    expect(sources('2026-10-13T03:29:00Z')).toHaveLength(0);
    expect(sources('2026-10-13T03:30:00Z')[0]).toMatchObject({
      date: '2026-10-13',
      kind: 'health_medication',
    });
    expect(sources('2026-10-14T03:30:00Z')).toHaveLength(0);
  });
  it('requires separate medication opt-in, deduplicates daily delivery and clears pauses', async () => {
    const reminders = TestBed.inject(Reminders);
    await library.saveMedication('one', med);
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
    await reminders.save({ ...DEFAULT_REMINDERS, medication_reminders: true, reminder_hour: 23 });
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(1);
    expect(reminders.path(reminders.visible()[0])).toBe('/health');
    await reminders.refresh();
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(1);
    await library.act(store.medicationPlans()[0], 'medication', 'pause');
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
    await library.act(store.medicationPlans()[0], 'medication', 'resume');
    TestBed.tick();
    expect(reminders.visible()).toHaveLength(0);
  });
  it('links medical expenses once and keeps ledger values unchanged', async () => {
    const expense = store.transactions().find((t) => t.kind === 'expense')!,
      before = store.transactions();
    await library.saveExpense('one', expense.id, '', 'Notes');
    await library.saveExpense('one', expense.id, '', 'Ignored');
    await expect(library.saveExpense('duplicate', expense.id, '', '')).rejects.toThrow(
      /already linked/,
    );
    await expect(
      library.saveExpense('bad', store.transactions().find((t) => t.kind === 'income')!.id, '', ''),
    ).rejects.toThrow(/recorded expense/);
    await library.act(store.healthExpenses()[0], 'expense', 'archive');
    await library.act(store.healthExpenses()[0], 'expense', 'restore');
    expect(store.transactions()).toEqual(before);
    const total = medicalTotals(
      store.healthExpenses(),
      store.transactions(),
      store.accounts(),
      store.profile()!.id,
      store.workspace()!.id,
    );
    expect(total[0].amount).toBe(expense.amount);
    expect(
      medicalTotals(
        store.healthExpenses(),
        store.transactions(),
        store.accounts(),
        'someone-else',
        store.workspace()!.id,
      ),
    ).toHaveLength(0);
  });
  it('isolates workspace caches and clears all wellness state on signout', async () => {
    await library.saveLog('one', log);
    await library.saveMedication('two', med);
    const original = store.workspace()!;
    await store.createWorkspace('Other', 'family');
    expect(store.healthLogs()).toHaveLength(0);
    expect(store.medicationPlans()).toHaveLength(0);
    await store.switchWorkspace(original);
    expect(store.healthLogs()).toHaveLength(1);
    expect(store.medicationPlans()).toHaveLength(1);
    await expect(
      library.act({ ...store.medicationPlans()[0], owner_id: 'other' }, 'medication', 'pause'),
    ).rejects.toThrow(/inaccessible/);
    store.clear();
    expect(store.medicationPlans()).toHaveLength(0);
    expect(store.healthLogs()).toHaveLength(0);
    expect(store.healthExpenses()).toHaveLength(0);
  });
  it('does not reload late wellness writes after signout', async () => {
    const auth = TestBed.inject(AuthService);
    auth.user.set({ id: 'demo-user' } as User);
    auth.demo.set(false);
    let finish!: (v: { error: null }) => void;
    vi.spyOn(TestBed.inject(Backend), 'requireClient').mockReturnValue({
      rpc: () => new Promise<{ error: null }>((r) => (finish = r)),
    } as unknown as ReturnType<Backend['requireClient']>);
    const reload = vi.spyOn(store, 'switchWorkspace'),
      pending = library.saveMedication('one', med);
    auth.user.set(null);
    store.clear();
    finish({ error: null });
    await pending;
    expect(reload).not.toHaveBeenCalled();
    expect(store.medicationPlans()).toHaveLength(0);
  });
});
