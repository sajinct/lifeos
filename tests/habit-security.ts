import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function habitSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
) {
  describe('Goals, private habits and milestone boundaries', () => {
    let db: PGlite,
      w: string,
      other: string,
      goal: string,
      habit: string,
      milestone: string,
      today: string,
      yesterday: string;
    async function saveGoal(
      v: {
        id?: string;
        revision?: number;
        workspace?: string;
        target?: number;
        current?: number;
        period?: string;
        due?: string | null;
        visibility?: string;
        title?: string;
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.save_personal_goal($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [
        id,
        v.workspace ?? w,
        v.revision ?? null,
        v.title ?? 'Read books',
        v.target ?? 12,
        v.current ?? 0,
        'books',
        v.due === undefined ? today : v.due,
        v.period ?? 'monthly',
        'green',
        'Synthetic only',
        v.visibility ?? 'private',
      ]);
      return id;
    }
    async function saveHabit(
      v: {
        id?: string;
        revision?: number;
        workspace?: string;
        start?: string;
        days?: number[];
        title?: string;
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.save_habit($1,$2,$3,$4,$5,$6,$7,$8)', [
        id,
        v.workspace ?? w,
        v.revision ?? null,
        v.title ?? 'Read daily',
        'Evening',
        'Synthetic only',
        v.start ?? yesterday,
        v.days ?? [1, 2, 3, 4, 5, 6, 7],
      ]);
      return id;
    }
    async function check(v: { id?: string; day?: string; revision?: number; done?: boolean } = {}) {
      return db.query('select public.set_habit_checkin($1,$2,$3,$4)', [
        v.id ?? habit,
        v.day ?? today,
        v.revision ?? 0,
        v.done ?? true,
      ]);
    }
    async function saveMilestone(
      v: { id?: string; revision?: number; goal?: string; workspace?: string; title?: string } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.save_goal_milestone($1,$2,$3,$4,$5,$6,$7)', [
        id,
        v.workspace ?? w,
        v.revision ?? null,
        v.goal ?? goal,
        v.title ?? 'Finish first book',
        today,
        'Synthetic only',
      ]);
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Habit security','family') as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.exec('reset role');
      today = (
        await db.query<{ day: string }>('select private.finance_today($1)::text as day', [A])
      ).rows[0].day;
      yesterday = (await db.query<{ day: string }>('select ($1::date-1)::text as day', [today]))
        .rows[0].day;
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other habits') as id")
      ).rows[0].id;
      await asUser(A);
    });
    it('denies direct mutations and validates goal values and monthly deadlines', async () => {
      for (const table of ['goals', 'habits', 'habit_periods', 'habit_checkins', 'goal_milestones'])
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
      await expect(
        db.query("insert into public.goals(workspace_id,title,target)values($1,'Bypass',1)", [w]),
      ).rejects.toThrow(/permission denied/);
      for (const v of [
        { target: 0 },
        { target: NaN },
        { current: NaN },
        { current: -1 },
        { target: 1.001 },
        { target: 1000000000000 },
        { period: 'monthly', due: null },
        { due: '2200-01-01' },
        { title: '' },
      ])
        await expect(saveGoal(v)).rejects.toThrow(/Invalid/);
    });
    it('keeps goals retry-safe, revision-protected and archivable', async () => {
      goal = await saveGoal();
      await saveGoal({ id: goal, title: 'Ignored retry' });
      expect(
        (await db.query('select title,revision from public.goals where id=$1', [goal])).rows[0],
      ).toEqual({ title: 'Read books', revision: 1 });
      await saveGoal({ id: goal, revision: 1, current: 3 });
      await expect(saveGoal({ id: goal, revision: 1, current: 1 })).rejects.toThrow(/changed/);
      await db.query('select public.set_goal_archive($1,2,true)', [goal]);
      await db.query('select public.set_goal_archive($1,2,true)', [goal]);
      await expect(saveGoal({ id: goal, revision: 3 })).rejects.toThrow(/Restore/);
      await db.query('select public.set_goal_archive($1,3,false)', [goal]);
    });
    it('preserves shared goal editing without revealing private milestones or allowing sharing changes by another owner', async () => {
      const shared = await saveGoal({ visibility: 'workspace' });
      await asUser(B);
      await expect(saveGoal({ id: shared, revision: 1, visibility: 'workspace' })).rejects.toThrow(
        /inaccessible/,
      );
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      const mine = await saveGoal({ visibility: 'workspace' });
      const m = await saveMilestone({ goal: mine });
      await asUser(A);
      expect((await db.query('select id from public.goals where id=$1', [mine])).rows).toHaveLength(
        1,
      );
      expect(
        (await db.query('select id from public.goal_milestones where id=$1', [m])).rows,
      ).toHaveLength(0);
      await expect(saveGoal({ id: mine, revision: 1, visibility: 'private' })).rejects.toThrow(
        /creator/,
      );
      await saveGoal({ id: mine, revision: 1, visibility: 'workspace', current: 2 });
      await expect(saveMilestone({ goal: mine })).rejects.toThrow(/Own active/);
    });
    it('validates schedules and locks their meaning after creation', async () => {
      for (const v of [
        { days: [] },
        { days: [0] },
        { days: [8] },
        { start: '2200-01-01' },
        { start: '2026-02-30' },
        { title: '' },
      ])
        await expect(saveHabit(v)).rejects.toThrow();
      habit = await saveHabit({ days: [7, 6, 5, 4, 3, 2, 1] });
      await saveHabit({ id: habit, title: 'Ignored retry' });
      expect(
        (await db.query('select title,weekdays,revision from public.habits where id=$1', [habit]))
          .rows[0],
      ).toEqual({ title: 'Read daily', weekdays: [1, 2, 3, 4, 5, 6, 7], revision: 1 });
      await expect(saveHabit({ id: habit, revision: 1, days: [1] })).rejects.toThrow(
        /Schedule is fixed/,
      );
      await saveHabit({ id: habit, revision: 1, title: 'Read a few pages' });
      await expect(saveHabit({ id: habit, revision: 1 })).rejects.toThrow(/changed/);
    });
    it('makes check-ins idempotent and rejects stale undo after a newer completion', async () => {
      await check();
      await check();
      expect(
        (
          await db.query('select done,revision from public.habit_checkins where habit_id=$1', [
            habit,
          ])
        ).rows,
      ).toEqual([{ done: true, revision: 1 }]);
      await check({ revision: 1, done: false });
      await check({ revision: 2, done: true });
      await expect(check({ revision: 1, done: false })).rejects.toThrow(/changed/);
      await check({ day: yesterday });
      await expect(check({ day: '2200-01-01' })).rejects.toThrow(/scheduled date/);
      await expect(check({ day: '1900-01-01' })).rejects.toThrow(/scheduled date/);
      const weekday = Number(
          (
            await db.query<{ d: number }>('select extract(isodow from $1::date)::integer as d', [
              today,
            ])
          ).rows[0].d,
        ),
        off = weekday === 7 ? 1 : weekday + 1;
      const scheduled = await saveHabit({ days: [off] });
      await expect(check({ id: scheduled })).rejects.toThrow(/scheduled date/);
    });
    it('preserves pause/archive periods and check-in history without permitting paused-day records', async () => {
      await db.query("select public.set_habit_status($1,2,'paused')", [habit]);
      await db.query("select public.set_habit_status($1,2,'paused')", [habit]);
      await expect(check({ revision: 3, done: false })).rejects.toThrow(/not active/);
      expect(
        (
          await db.query(
            'select status from public.habit_periods where habit_id=$1 order by starts_on',
            [habit],
          )
        ).rows,
      ).toEqual([{ status: 'active' }, { status: 'paused' }]);
      await check({ day: yesterday, revision: 1, done: false });
      await db.query("select public.set_habit_status($1,3,'active')", [habit]);
      await check({ revision: 3, done: false });
      await db.query("select public.set_habit_status($1,4,'archived')", [habit]);
      await expect(check({ day: yesterday, revision: 2, done: true })).rejects.toThrow(
        /not active/,
      );
      await db.query("select public.set_habit_status($1,5,'active')", [habit]);
      expect(
        (await db.query('select id from public.habit_checkins where habit_id=$1', [habit])).rows,
      ).toHaveLength(2);
      expect(
        (await db.query('select id from public.habit_periods where habit_id=$1', [habit])).rows,
      ).toHaveLength(2);
    });
    it('isolates habits, periods and check-ins from editors and other workspace owners', async () => {
      await asUser(B);
      for (const table of ['habits', 'habit_periods', 'habit_checkins'])
        expect(
          (
            await db.query(
              `select id from public.${table} where habit_id=$1`.replace(
                'where habit_id',
                'where ' + (table === 'habits' ? 'id' : 'habit_id'),
              ),
              [habit],
            )
          ).rows,
        ).toHaveLength(0);
      await expect(check()).rejects.toThrow(/owner/);
      await expect(saveHabit({ id: habit, revision: 6 })).rejects.toThrow(/inaccessible/);
      const mine = await saveHabit();
      await check({ id: mine });
      await asUser(A);
      expect(
        (await db.query('select id from public.habits where id=$1', [mine])).rows,
      ).toHaveLength(0);
      await expect(
        db.query("select public.set_habit_status($1,1,'paused')", [mine]),
      ).rejects.toThrow(/owner/);
      await expect(saveHabit({ workspace: other })).rejects.toThrow(/write/);
    });
    it('validates milestone ownership and binding, protects stale completion and leaves goal progress unchanged', async () => {
      milestone = await saveMilestone();
      await saveMilestone({ id: milestone, title: 'Ignored retry' });
      const second = await saveGoal();
      await expect(saveMilestone({ id: milestone, revision: 1, goal: second })).rejects.toThrow(
        /inaccessible/,
      );
      await db.query('select public.set_goal_milestone_done($1,1,true)', [milestone]);
      await db.query('select public.set_goal_milestone_done($1,1,true)', [milestone]);
      expect(
        (await db.query('select current::text from public.goals where id=$1', [goal])).rows[0],
      ).toEqual({ current: '3.00' });
      await expect(
        db.query('select public.set_goal_milestone_done($1,1,false)', [milestone]),
      ).rejects.toThrow(/changed/);
      await db.query('select public.set_goal_milestone_done($1,2,false)', [milestone]);
      await saveMilestone({ id: milestone, revision: 3, title: 'Edited milestone' });
      await expect(saveMilestone({ id: milestone, revision: 3 })).rejects.toThrow(/changed/);
      await db.query('select public.set_goal_archive($1,4,true)', [goal]);
      await expect(saveMilestone()).rejects.toThrow(/Own active/);
      await expect(
        db.query('select public.set_goal_milestone_done($1,4,true)', [milestone]),
      ).rejects.toThrow(/Own active/);
      expect(
        (await db.query('select id from public.goal_milestones where goal_id=$1', [goal])).rows,
      ).toHaveLength(1);
    });
    it('denies milestone reads and mutations by another editor, revoked members and anonymous users', async () => {
      await asUser(B);
      expect(
        (await db.query('select id from public.goal_milestones where id=$1', [milestone])).rows,
      ).toHaveLength(0);
      await expect(
        db.query('select public.set_goal_milestone_done($1,4,true)', [milestone]),
      ).rejects.toThrow(/Own active/);
      const mine = await saveHabit();
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(check({ id: mine })).rejects.toThrow(/write/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.habits where id=$1', [mine])).rows,
      ).toHaveLength(0);
      await expect(check({ id: mine })).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.habit_checkins')).rejects.toThrow(
        /permission denied/,
      );
      await expect(saveHabit()).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
