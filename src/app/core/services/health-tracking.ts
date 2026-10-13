import { Injectable, inject } from '@angular/core';
import { LifeStore } from './life-store';
import { Backend } from '../supabase/client';
import { HealthLibrary } from './health';
import {
  HealthLog,
  HealthLogInput,
  MedicationPlan,
  MedicationInput,
  HealthExpense,
  HealthTrackingKind,
  HealthTrackingAction,
} from '../models/domain';
import { validateHealthLog, validateMedication } from '../../shared/utilities/health-tracking';
@Injectable({ providedIn: 'root' })
export class HealthTracking {
  readonly store = inject(LifeStore);
  private readonly backend = inject(Backend);
  readonly health = inject(HealthLibrary);
  private context() {
    const w = this.store.workspace()?.id,
      user = this.store.profile()?.id,
      session = this.store.fileSession();
    if (
      !w ||
      !user ||
      !this.store.writable() ||
      (!this.store.auth.demo() && this.store.auth.user()?.id !== user)
    )
      throw new Error('Workspace write access required.');
    return { w, user, session };
  }
  private own(
    row: { workspace_id: string; owner_id: string },
    c: ReturnType<HealthTracking['context']>,
  ) {
    if (row.workspace_id !== c.w || row.owner_id !== c.user)
      throw new Error('Health record is inaccessible.');
  }
  private current(c: ReturnType<HealthTracking['context']>) {
    return (
      c.w === this.store.workspace()?.id &&
      c.user === this.store.profile()?.id &&
      c.session === this.store.fileSession() &&
      (this.store.auth.demo() || this.store.auth.user()?.id === c.user)
    );
  }
  private async reload(c: ReturnType<HealthTracking['context']>) {
    if (!this.current(c)) return;
    await this.store.switchWorkspace(this.store.workspace()!);
    if (this.current(c) && this.store.error()) throw new Error(this.store.error());
  }
  private base(c: ReturnType<HealthTracking['context']>) {
    const date = new Date().toISOString();
    return {
      workspace_id: c.w,
      owner_id: c.user,
      visibility: 'private' as const,
      created_at: date,
      updated_at: date,
    };
  }
  private old(
    row: HealthLog | MedicationPlan | HealthExpense | undefined,
    previous: HealthLog | MedicationPlan | HealthExpense | undefined,
    c: ReturnType<HealthTracking['context']>,
  ) {
    if (row) {
      this.own(row, c);
      if (!previous) return false;
      if (row.revision !== previous.revision || row.archived)
        throw new Error('Health record changed; restore or refresh.');
    } else if (previous) throw new Error('Health record is inaccessible.');
    return true;
  }
  async saveLog(id: string, input: HealthLogInput, previous?: HealthLog) {
    const c = this.context(),
      v = validateHealthLog(input, this.health.today());
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_health_log', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        details: v,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.healthLogs().find((r) => r.id === id);
    if (!this.old(old, previous, c)) return;
    if (old && old.kind !== v.kind) throw new Error('Log kind cannot change.');
    const base = this.base(c);
    this.store.healthLogs.update((rows) => [
      {
        ...base,
        ...v,
        id,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? base.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async saveMedication(id: string, input: MedicationInput, previous?: MedicationPlan) {
    const c = this.context(),
      v = validateMedication(input);
    if (previous) this.own(previous, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_medication_plan', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        details: { ...v, ends_on: v.ends_on || null },
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.medicationPlans().find((r) => r.id === id);
    if (!this.old(old, previous, c)) return;
    const base = this.base(c);
    this.store.medicationPlans.update((rows) => [
      {
        ...base,
        ...v,
        id,
        ends_on: v.ends_on || null,
        active: old?.active ?? true,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? base.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async saveExpense(
    id: string,
    expense: string,
    appointment: string,
    notes: string,
    previous?: HealthExpense,
  ) {
    const c = this.context();
    if (previous) this.own(previous, c);
    if (notes.length > 2000) throw new Error('Notes must be up to 2000 characters.');
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('save_health_expense', {
        entry: id,
        w: c.w,
        expected_revision: previous?.revision ?? null,
        expense,
        appointment: appointment || null,
        expense_notes: notes,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const old = this.store.healthExpenses().find((r) => r.id === id);
    if (old && old.transaction_id !== expense) throw new Error('Linked transaction cannot change.');
    if (!this.old(old, previous, c)) return;
    if (
      !this.store
        .transactions()
        .some(
          (t) =>
            t.id === expense &&
            t.workspace_id === c.w &&
            t.owner_id === c.user &&
            t.kind === 'expense',
        )
    )
      throw new Error('Choose your own recorded expense.');
    if (
      appointment &&
      !this.store
        .healthAppointments()
        .some((a) => a.id === appointment && a.workspace_id === c.w && a.owner_id === c.user)
    )
      throw new Error('Choose your own appointment.');
    if (
      !old &&
      this.store
        .healthExpenses()
        .some(
          (l) => l.transaction_id === expense && l.owner_id === c.user && l.workspace_id === c.w,
        )
    )
      throw new Error('Expense already linked; edit or restore its link.');
    const base = this.base(c);
    this.store.healthExpenses.update((rows) => [
      {
        ...base,
        id,
        transaction_id: expense,
        appointment_id: appointment || null,
        notes,
        archived: false,
        revision: (old?.revision ?? 0) + 1,
        created_at: old?.created_at ?? base.created_at,
      },
      ...rows.filter((r) => r.id !== id),
    ]);
  }
  async act(
    row: HealthLog | MedicationPlan | HealthExpense,
    kind: HealthTrackingKind,
    action: HealthTrackingAction,
  ) {
    const c = this.context();
    this.own(row, c);
    if (!this.store.auth.demo()) {
      const { error } = await this.backend.requireClient().rpc('act_on_health_tracking', {
        entry: row.id,
        record_kind: kind,
        expected_revision: row.revision,
        action,
      });
      if (error) throw error;
      await this.reload(c);
      return;
    }
    const rows =
        kind === 'log'
          ? this.store.healthLogs()
          : kind === 'medication'
            ? this.store.medicationPlans()
            : this.store.healthExpenses(),
      old = rows.find((r) => r.id === row.id);
    if (!old) throw new Error('Health record is inaccessible.');
    this.own(old, c);
    if (kind !== 'medication' && ['pause', 'resume'].includes(action))
      throw new Error('Invalid health action.');
    const archived = action === 'archive' ? true : action === 'restore' ? false : old.archived;
    const active =
      'active' in old
        ? action === 'pause'
          ? false
          : action === 'resume'
            ? true
            : old.active
        : false;
    if (old.archived === archived && (!('active' in old) || old.active === active)) return;
    if (old.revision !== row.revision || (old.archived && ['pause', 'resume'].includes(action)))
      throw new Error('Health record changed; restore or refresh.');
    if (kind === 'log')
      this.store.healthLogs.update((rows) =>
        rows.map((r) => (r.id === old.id ? { ...r, archived, revision: r.revision + 1 } : r)),
      );
    else if (kind === 'medication')
      this.store.medicationPlans.update((rows) =>
        rows.map((r) =>
          r.id === old.id ? { ...r, archived, active, revision: r.revision + 1 } : r,
        ),
      );
    else
      this.store.healthExpenses.update((rows) =>
        rows.map((r) => (r.id === old.id ? { ...r, archived, revision: r.revision + 1 } : r)),
      );
  }
}
