import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function taskSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
) {
  describe('Task lists, checklist sharing and safe repeats', () => {
    let db: PGlite,
      w: string,
      list: string,
      task: string,
      series: string,
      item: string,
      shared: string;
    async function makeTask(title = 'Monthly task', visibility = 'private', date = '2026-01-31') {
      return (
        await db.query<{ id: string }>(
          'insert into public.tasks(workspace_id,title,visibility,due_date)values($1,$2,$3::public.record_visibility,$4) returning id',
          [w, title, visibility, date],
        )
      ).rows[0].id;
    }
    async function row(id = task) {
      return (
        await db.query<{
          id: string;
          revision: number;
          status: string;
          series_id: string;
          list_id: string;
          due_date: string;
        }>(
          'select id,revision,status,series_id,list_id,due_date::text from public.tasks where id=$1',
          [id],
        )
      ).rows[0];
    }
    async function complete(id = task, revision?: number, status = 'done') {
      await db.query('select public.set_task_status($1,$2,$3)', [
        id,
        revision ?? (await row(id)).revision,
        status,
      ]);
    }
    async function configure(
      id = task,
      frequency: string | null = 'monthly',
      l: string | null = list,
    ) {
      await db.query('select public.configure_task($1,$2,$3,$4)', [
        id,
        (await row(id)).revision,
        l,
        frequency,
      ]);
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Task productivity security','family')as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
    });
    it('protects metadata and ownership while preserving one-off capture', async () => {
      list = randomUUID();
      await db.query('select public.save_task_list($1,$2,null,$3,false)', [
        list,
        w,
        'Personal work',
      ]);
      task = await makeTask();
      await expect(
        db.query('select public.configure_task($1,null,null,null)', [task]),
      ).rejects.toThrow(/changed/);
      await expect(
        db.query("select public.set_task_status($1,null,'done')", [task]),
      ).rejects.toThrow(/changed/);
      for (const table of ['task_lists', 'task_series', 'task_checklist'])
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
      await expect(
        db.query("update public.tasks set status='done' where id=$1", [task]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('update public.tasks set list_id=$1 where id=$2', [list, task]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("insert into public.tasks(workspace_id,title,revision)values($1,'Forged',99)", [
          w,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('select public.configure_task($1,1,$2,$3)', [task, list, 'invalid']),
      ).rejects.toThrow(/pending one-off/);
    });
    it('replays list creation and rejects stale list edits', async () => {
      await db.query("select public.save_task_list($1,$2,null,'Ignored retry',true)", [list, w]);
      expect(
        (
          await db.query<{ name: string; archived: boolean }>(
            'select name,archived from public.task_lists where id=$1',
            [list],
          )
        ).rows[0],
      ).toEqual({ name: 'Personal work', archived: false });
      await db.query("select public.save_task_list($1,$2,1,'Work',false)", [list, w]);
      await expect(
        db.query("select public.save_task_list($1,$2,1,'Stale',false)", [list, w]),
      ).rejects.toThrow(/changed/);
    });
    it('copies a reset checklist once and preserves Jan 31 anchors', async () => {
      item = randomUUID();
      await db.query("select public.save_task_checklist($1,$2,null,'Review',false)", [item, task]);
      await db.query("select public.save_task_checklist($1,$2,1,'Review',true)", [item, task]);
      await configure();
      series = (await row()).series_id;
      await expect(
        db.query("update public.tasks set due_date='2026-02-01' where id=$1", [task]),
      ).rejects.toThrow(/dates and sharing/);
      const revision = (await row()).revision;
      await complete(task, revision);
      await complete(task, revision);
      let rows = (
        await db.query<{ id: string; due: string; occurrence_index: number }>(
          'select id,due_date::text as due,occurrence_index from public.tasks where series_id=$1 order by occurrence_index',
          [series],
        )
      ).rows;
      expect(rows.map((r) => r.due)).toEqual(['2026-01-31', '2026-02-28']);
      expect(
        (
          await db.query<{ done: boolean; title: string }>(
            'select done,title from public.task_checklist where task_id=$1',
            [rows[1].id],
          )
        ).rows,
      ).toEqual([{ done: false, title: 'Review' }]);
      await complete(rows[1].id);
      rows = (
        await db.query(
          'select due_date::text as due from public.tasks where series_id=$1 order by occurrence_index',
          [series],
        )
      ).rows as typeof rows;
      expect(rows.map((r) => r.due)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    });
    it('rejects stale completion reversals and never duplicates successors on reopen', async () => {
      await expect(complete(task, 2, 'todo')).rejects.toThrow(/changed/);
      await complete(task, undefined, 'todo');
      await complete();
      expect(
        (
          await db.query<{ n: number }>(
            'select count(*)::int as n from public.tasks where series_id=$1',
            [series],
          )
        ).rows[0].n,
      ).toBe(3);
      await expect(
        db.query('delete from public.tasks where id=$1 returning id', [task]),
      ).resolves.toMatchObject({ affectedRows: 0 });
    });
    it('pauses creation, resumes one missing occurrence and retains existing tasks', async () => {
      await db.query('select public.set_task_series_active($1,1,false)', [series]);
      const latest = (
        await db.query<{ id: string }>(
          'select id from public.tasks where series_id=$1 order by occurrence_index desc limit 1',
          [series],
        )
      ).rows[0].id;
      await complete(latest);
      expect(
        (
          await db.query<{ n: number }>(
            'select count(*)::int as n from public.tasks where series_id=$1',
            [series],
          )
        ).rows[0].n,
      ).toBe(3);
      await db.query('select public.set_task_series_active($1,2,true)', [series]);
      await db.query('select public.set_task_series_active($1,2,true)', [series]);
      expect(
        (
          await db.query<{ n: number }>(
            'select count(*)::int as n from public.tasks where series_id=$1',
            [series],
          )
        ).rows[0].n,
      ).toBe(4);
      await expect(
        db.query('select public.set_task_series_active($1,1,false)', [series]),
      ).rejects.toThrow(/changed/);
    });
    it('isolates private organization and forbids another member’s configuration', async () => {
      await asUser(B);
      expect(
        (await db.query('select id from public.task_lists where id=$1', [list])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.task_series where id=$1', [series])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.task_checklist where task_id=$1', [task])).rows,
      ).toHaveLength(0);
      await expect(
        db.query('select public.configure_task($1,1,$2,null)', [task, list]),
      ).rejects.toThrow(/private task/);
      const own = await makeTask('Member task');
      await expect(configure(own, null, list)).rejects.toThrow(/list you own/);
      await asUser(A);
      expect((await db.query('select id from public.tasks where id=$1', [own])).rows).toHaveLength(
        0,
      );
    });
    it('inherits shared-task checklist reads and creator/workspace-owner edit roles', async () => {
      shared = await makeTask('Shared steps', 'workspace');
      const step = randomUUID();
      await db.query("select public.save_task_checklist($1,$2,null,'Shared step',false)", [
        step,
        shared,
      ]);
      await asUser(B);
      expect(
        (await db.query('select id from public.task_checklist where id=$1', [step])).rows,
      ).toHaveLength(1);
      await expect(
        db.query("select public.save_task_checklist($1,$2,1,'Changed',true)", [step, shared]),
      ).rejects.toThrow(/inaccessible/);
      const memberShared = await makeTask('Member shared', 'workspace');
      const memberStep = randomUUID();
      await db.query("select public.save_task_checklist($1,$2,null,'Member step',false)", [
        memberStep,
        memberShared,
      ]);
      await asUser(A);
      await db.query("select public.save_task_checklist($1,$2,1,'Member step',true)", [
        memberStep,
        memberShared,
      ]);
      await expect(configure(shared)).rejects.toThrow(/private task/);
      await db.query("update public.tasks set visibility='private' where id=$1", [shared]);
      await asUser(B);
      expect(
        (await db.query('select id from public.task_checklist where id=$1', [step])).rows,
      ).toHaveLength(0);
      await asUser(A);
    });
    it('validates checklist binding/revisions, archived lists and fixed recurrence sharing', async () => {
      const plain = await makeTask('One off');
      const step = randomUUID();
      await db.query("select public.save_task_checklist($1,$2,null,'Step',false)", [step, plain]);
      await db.query("select public.save_task_checklist($1,$2,null,'Ignored',true)", [step, plain]);
      await db.query("select public.save_task_checklist($1,$2,1,'Step',true)", [step, plain]);
      await expect(
        db.query("select public.save_task_checklist($1,$2,1,'Step',false)", [step, plain]),
      ).rejects.toThrow(/changed/);
      await expect(
        db.query("select public.save_task_checklist($1,$2,null,'Move',false)", [step, task]),
      ).rejects.toThrow(/Reopen|inaccessible/);
      await db.query("select public.save_task_list($1,$2,2,'Work',true)", [list, w]);
      await expect(configure(plain, null)).rejects.toThrow(/active list/);
      await expect(
        db.query("update public.tasks set visibility='workspace' where id=$1", [task]),
      ).rejects.toThrow(/list is inaccessible|dates and sharing/);
    });
    it('checks removal revisions and prevents completed-parent checklist changes', async () => {
      const plain = await makeTask('Removal check'),
        step = randomUUID();
      await db.query("select public.save_task_checklist($1,$2,null,'Draft',false)", [step, plain]);
      await db.query("select public.save_task_checklist($1,$2,1,'Review',true)", [step, plain]);
      await expect(
        db.query('select public.remove_task_checklist($1,null)', [step]),
      ).rejects.toThrow(/changed/);
      await expect(db.query('select public.remove_task_checklist($1,1)', [step])).rejects.toThrow(
        /changed/,
      );
      await complete(plain);
      await expect(db.query('select public.remove_task_checklist($1,2)', [step])).rejects.toThrow(
        /Reopen/,
      );
      await complete(plain, undefined, 'todo');
      await db.query('select public.remove_task_checklist($1,2)', [step]);
      await db.query('select public.remove_task_checklist($1,2)', [step]);
      expect(
        (await db.query('select id from public.task_checklist where id=$1', [step])).rows,
      ).toHaveLength(0);
    });
    it('handles leap-year anchors and stops at the supported date boundary', async () => {
      const leap = await makeTask('Leap anniversary', 'private', '2024-02-29');
      await configure(leap, 'yearly', null);
      await complete(leap);
      expect(
        (
          await db.query<{ day: string }>(
            'select due_date::text as day from public.tasks where series_id=$1 order by occurrence_index desc limit 1',
            [(await row(leap)).series_id],
          )
        ).rows[0].day,
      ).toBe('2025-02-28');
      const last = await makeTask('Boundary', 'private', '2100-12-31');
      await configure(last, 'daily', null);
      await complete(last);
      expect(
        (
          await db.query<{ active: boolean }>('select active from public.task_series where id=$1', [
            (await row(last)).series_id,
          ])
        ).rows[0].active,
      ).toBe(false);
    });
    it('denies viewers, removed members and anonymous access to task RPCs', async () => {
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(
        db.query("select public.set_task_status($1,1,'done')", [shared]),
      ).rejects.toThrow(/inaccessible/);
      await expect(
        db.query("select public.save_task_list($1,$2,null,'Viewer',false)", [randomUUID(), w]),
      ).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.task_checklist where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await db.exec('reset role;set role anon');
      await expect(db.query("select public.set_task_status($1,1,'done')", [task])).rejects.toThrow(
        /permission denied/,
      );
      await asUser(A);
    });
  });
}
