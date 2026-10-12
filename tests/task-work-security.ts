import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function taskWorkSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Workspace assignment and private time tracking', () => {
    let db: PGlite,
      w: string,
      shared: string,
      secret: string,
      manual: string,
      timer: string,
      today: string;
    async function task(title = 'Shared responsibility', sharing = 'workspace') {
      return (
        await db.query<{ id: string }>(
          'insert into public.tasks(workspace_id,title,visibility)values($1,$2,$3::public.record_visibility)returning id',
          [w, title, sharing],
        )
      ).rows[0].id;
    }
    async function rev(id: string) {
      return (
        await db.query<{ revision: number }>('select revision from public.tasks where id=$1', [id])
      ).rows[0].revision;
    }
    async function assign(id: string, user: string | null, revision?: number) {
      return db.query('select public.assign_workspace_task($1,$2,$3)', [
        id,
        revision ?? (await rev(id)),
        user,
      ]);
    }
    async function log(
      id = randomUUID(),
      parent: string | null = shared,
      revision: number | null = null,
      seconds = 1800,
      day = today,
    ) {
      await db.query('select public.save_manual_task_time($1,$2,$3,$4,$5,$6,$7)', [
        id,
        w,
        revision,
        parent,
        day,
        seconds,
        'Synthetic work',
      ]);
      return id;
    }
    async function start(id = randomUUID(), parent = shared) {
      await db.query("select public.start_task_timer($1,$2,$3,'Synthetic timer')", [id, w, parent]);
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Work time security','family')as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      shared = await task();
      secret = await task('Private task', 'private');
      today = (await db.query<{ today: string }>('select current_date::text as today')).rows[0]
        .today;
    });
    it('exposes only current member names to members and keeps profile reads restricted', async () => {
      expect(
        (await db.query('select * from public.workspace_task_members($1)', [w])).rows,
      ).toHaveLength(3);
      await asUser(B);
      expect((await db.query('select * from public.profiles')).rows).toHaveLength(1);
      await asUser(A);
      const other = (
        await db.query<{ id: string }>("select public.create_workspace('Directory other')as id")
      ).rows[0].id;
      await asUser(B);
      expect(
        (await db.query('select * from public.workspace_task_members($1)', [other])).rows,
      ).toHaveLength(0);
      await asUser(A);
    });
    it('restricts assignments to editable shared tasks and protects direct writes', async () => {
      await assign(shared, B);
      await assign(shared, B, 1);
      await expect(
        db.query('select public.assign_workspace_task($1,null,$2)', [shared, C]),
      ).rejects.toThrow(/changed/);
      await expect(assign(secret, B)).rejects.toThrow(/shared task/);
      await expect(
        db.query('update public.tasks set assignee_id=$1 where id=$2', [C, shared]),
      ).rejects.toThrow(/permission denied/);
      await expect(assign(shared, randomUUID())).rejects.toThrow(/current workspace member/);
      await asUser(B);
      expect(
        (await db.query('select id from public.tasks where id=$1', [secret])).rows,
      ).toHaveLength(0);
      await expect(
        db.query("select public.set_task_status($1,2,'done')", [shared]),
      ).rejects.toThrow(/inaccessible/);
      await expect(assign(shared, C, 2)).rejects.toThrow(/inaccessible/);
      await asUser(A);
    });
    it('clears assignment on privacy changes and membership removal', async () => {
      const t = await task();
      await assign(t, B);
      await db.query("update public.tasks set visibility='private' where id=$1", [t]);
      expect(
        (
          await db.query<{ assignee_id: string | null }>(
            'select assignee_id from public.tasks where id=$1',
            [t],
          )
        ).rows[0].assignee_id,
      ).toBeNull();
      await db.query('select public.remove_workspace_member($1,$2)', [w, C]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      await assign(shared, C);
      await db.query('select public.remove_workspace_member($1,$2)', [w, C]);
      expect(
        (
          await db.query<{ assignee_id: string | null }>(
            'select assignee_id from public.tasks where id=$1',
            [shared],
          )
        ).rows[0].assignee_id,
      ).toBeNull();
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
    });
    it('records private own time on readable shared tasks without task edit rights', async () => {
      await asUser(B);
      manual = await log();
      await expect(log(randomUUID(), secret)).rejects.toThrow(/inaccessible/);
      await asUser(A);
      expect(
        (await db.query('select id from public.task_time_entries where id=$1', [manual])).rows,
      ).toHaveLength(0);
      await expect(log(manual, shared, 1)).rejects.toThrow(/inaccessible/);
      await asUser(B);
      await log(manual, shared, null, 3600);
      expect(
        (
          await db.query<{ seconds: number }>(
            'select seconds from public.task_time_entries where id=$1',
            [manual],
          )
        ).rows[0].seconds,
      ).toBe(1800);
      await log(manual, shared, 1, 2400);
      await expect(log(manual, shared, 1, 3000)).rejects.toThrow(/changed/);
    });
    it('rejects direct mutations, future dates, invalid durations and cross-workspace binding', async () => {
      await expect(db.query('delete from public.task_time_entries')).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.query('update public.task_time_entries set seconds=1')).rejects.toThrow(
        /permission denied/,
      );
      await expect(log(randomUUID(), shared, null, 0)).rejects.toThrow(/24 hours/);
      await expect(log(randomUUID(), shared, null, 86401)).rejects.toThrow(/24 hours/);
      await expect(log(randomUUID(), shared, null, 60, '2101-01-01')).rejects.toThrow(/24 hours/);
      const other = (
        await db.query<{ id: string }>("select public.create_workspace('Other time')as id")
      ).rows[0].id;
      const t = (
        await db.query<{ id: string }>(
          "insert into public.tasks(workspace_id,title)values($1,'Other task')returning id",
          [other],
        )
      ).rows[0].id;
      await expect(log(randomUUID(), t)).rejects.toThrow(/inaccessible/);
    });
    it('allows one timer per workspace and deduplicates starts and stops', async () => {
      timer = await start();
      await start(timer);
      await expect(start()).rejects.toThrow(/running timer/);
      await db.exec('reset role');
      await db.query(
        "update public.task_time_entries set started_at=clock_timestamp()-interval '90 seconds' where id=$1",
        [timer],
      );
      await asUser(B);
      await db.query("select public.act_on_task_time($1,1,'stop')", [timer]);
      await db.query("select public.act_on_task_time($1,1,'stop')", [timer]);
      const r = (
        await db.query<{ seconds: number; revision: number; status: string }>(
          'select seconds,revision,status from public.task_time_entries where id=$1',
          [timer],
        )
      ).rows[0];
      expect(r.seconds).toBeGreaterThanOrEqual(90);
      expect(r.seconds).toBeLessThan(95);
      expect(r.revision).toBe(2);
      expect(r.status).toBe('recorded');
      await start(timer);
      expect(
        (await db.query("select id from public.task_time_entries where status='running'")).rows,
      ).toHaveLength(0);
    });
    it('retains discarded history, rejects stale actions and caps long running sessions', async () => {
      await expect(
        db.query("select public.act_on_task_time($1,null,'void')", [timer]),
      ).rejects.toThrow(/changed/);
      await db.query("select public.act_on_task_time($1,2,'void')", [timer]);
      await expect(
        db.query("select public.act_on_task_time($1,2,'restore')", [timer]),
      ).rejects.toThrow(/changed/);
      await db.query("select public.act_on_task_time($1,3,'restore')", [timer]);
      const long = await start();
      await db.exec('reset role');
      await db.query(
        "update public.task_time_entries set started_at=clock_timestamp()-interval '2 days' where id=$1",
        [long],
      );
      await asUser(B);
      await db.query("select public.act_on_task_time($1,1,'void')", [long]);
      expect(
        (
          await db.query<{ seconds: number }>(
            'select seconds from public.task_time_entries where id=$1',
            [long],
          )
        ).rows[0].seconds,
      ).toBe(86400);
      await db.query("select public.act_on_task_time($1,2,'restore')", [long]);
    });
    it('keeps snapshots after task deletion or privacy changes without restoring access', async () => {
      await asUser(A);
      const t = await task('Historical shared work');
      await asUser(B);
      const history = await log(randomUUID(), t);
      await asUser(A);
      await db.query('delete from public.tasks where id=$1', [t]);
      await asUser(B);
      const r = (
        await db.query<{ task_id: string | null; task_title: string }>(
          'select task_id,task_title from public.task_time_entries where id=$1',
          [history],
        )
      ).rows[0];
      expect(r).toEqual({ task_id: null, task_title: 'Historical shared work' });
      await log(history, null, 1, 900);
      await asUser(A);
      await db.query("update public.tasks set visibility='private' where id=$1", [shared]);
      await asUser(B);
      expect(
        (await db.query('select id from public.tasks where id=$1', [shared])).rows,
      ).toHaveLength(0);
      await log(manual, shared, 2, 1200);
      await expect(start(randomUUID(), shared)).rejects.toThrow(/inaccessible/);
    });
    it('denies viewers, removed members, other owners and anonymous access', async () => {
      await asUser(C);
      await expect(log()).rejects.toThrow(/write access/);
      expect(
        (await db.query('select id from public.task_time_entries where id=$1', [manual])).rows,
      ).toHaveLength(0);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.task_time_entries where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await expect(
        db.query("select public.act_on_task_time($1,3,'void')", [manual]),
      ).rejects.toThrow(/inaccessible/);
      expect(
        (await db.query('select * from public.workspace_task_members($1)', [w])).rows,
      ).toHaveLength(0);
      await db.exec('reset role;set role anon');
      await expect(
        db.query('select * from public.workspace_task_members($1)', [w]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('select id from public.task_time_entries')).rejects.toThrow(
        /permission denied/,
      );
      await asUser(A);
    });
  });
}
