import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, it, expect } from 'vitest';
export function projectSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Project milestone sharing and private budget boundaries', () => {
    let db: PGlite,
      w: string,
      privateProject: string,
      shared: string,
      milestone: string,
      budget: string,
      expense: string,
      account: string;
    async function project(
      id = randomUUID(),
      revision: number | null = null,
      sharing = 'private',
      status = 'active',
      title = 'Planned project',
    ) {
      await db.query('select public.save_planned_project($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        id,
        w,
        revision,
        title,
        'Plan',
        status,
        'green',
        '2026-12-31',
        sharing,
      ]);
      return id;
    }
    async function revision(id: string, table = 'projects') {
      return (
        await db.query<{ revision: number }>(`select revision from public.${table} where id=$1`, [
          id,
        ])
      ).rows[0].revision;
    }
    async function step(
      id = randomUUID(),
      parent = privateProject,
      rev: number | null = null,
      title = 'First milestone',
    ) {
      await db.query('select public.save_project_milestone($1,$2,$3,$4,$5,$6,$7)', [
        id,
        w,
        rev,
        parent,
        title,
        '2026-11-30',
        'Synthetic only',
      ]);
      return id;
    }
    async function plan(
      id = randomUUID(),
      parent = privateProject,
      rev: number | null = null,
      currency = 'INR',
      amount: number | string = 10000,
    ) {
      await db.query('select public.save_project_budget($1,$2,$3,$4,$5,$6)', [
        id,
        w,
        rev,
        parent,
        currency,
        amount,
      ]);
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Project planning tests','family')as id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, C]);
      privateProject = await project();
      shared = await project(randomUUID(), null, 'workspace');
    });
    it('replays project creation and protects metadata revisions', async () => {
      await project(privateProject, null, 'private', 'paused', 'Ignored');
      expect(
        (
          await db.query<{ title: string; revision: number }>(
            'select title,revision from public.projects where id=$1',
            [privateProject],
          )
        ).rows[0],
      ).toEqual({ title: 'Planned project', revision: 1 });
      await project(privateProject, 1);
      await expect(project(privateProject, 1)).rejects.toThrow(/changed/);
      await expect(
        db.query('update public.projects set revision=99 where id=$1', [privateProject]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("insert into public.projects(workspace_id,title,revision)values($1,'Forged',99)", [
          w,
        ]),
      ).rejects.toThrow(/permission denied/);
    });
    it('validates values and denies direct milestone/budget mutation', async () => {
      for (const table of ['project_milestones', 'project_budgets'])
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
      for (const amount of [0, -1, 'NaN', 'Infinity', '1000000000000', '1.001'])
        await expect(plan(randomUUID(), privateProject, null, 'INR', amount)).rejects.toThrow(
          /positive amount/,
        );
      await expect(plan(randomUUID(), privateProject, null, 'invalid', 10)).rejects.toThrow(
        /currency/,
      );
      await expect(
        db.query("select public.save_project_milestone($1,$2,null,$3,'Invalid','2101-01-01','')", [
          randomUUID(),
          w,
          privateProject,
        ]),
      ).rejects.toThrow(/valid date/);
    });
    it('records independent milestone completion and handles stale/archive actions', async () => {
      milestone = await step();
      await step(milestone, privateProject, null, 'Ignored');
      expect(
        (
          await db.query<{ title: string }>(
            'select title from public.project_milestones where id=$1',
            [milestone],
          )
        ).rows[0].title,
      ).toBe('First milestone');
      await db.query("select public.act_on_project_milestone($1,1,'complete')", [milestone]);
      await db.query("select public.act_on_project_milestone($1,1,'complete')", [milestone]);
      expect(
        (
          await db.query<{ revision: number; done: boolean }>(
            'select revision,done from public.project_milestones where id=$1',
            [milestone],
          )
        ).rows[0],
      ).toEqual({ revision: 2, done: true });
      await expect(
        db.query("select public.act_on_project_milestone($1,1,'reopen')", [milestone]),
      ).rejects.toThrow(/changed/);
      expect(
        (
          await db.query<{ status: string }>('select status from public.projects where id=$1', [
            privateProject,
          ])
        ).rows[0].status,
      ).toBe('active');
      await db.query("select public.act_on_project_milestone($1,2,'archive')", [milestone]);
      await expect(step(milestone, privateProject, 3)).rejects.toThrow(/restore/);
      await db.query("select public.act_on_project_milestone($1,3,'restore')", [milestone]);
    });
    it('follows project privacy and shared creator/workspace-owner edit roles', async () => {
      const publicStep = await step(randomUUID(), shared);
      await asUser(B);
      expect(
        (await db.query('select id from public.project_milestones where id=$1', [milestone])).rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.project_milestones where id=$1', [publicStep])).rows,
      ).toHaveLength(1);
      await expect(step(randomUUID(), shared)).rejects.toThrow(/inaccessible/);
      const memberPrivate = await project();
      await step(randomUUID(), memberPrivate);
      const memberShared = await project(randomUUID(), null, 'workspace');
      const memberStep = await step(randomUUID(), memberShared);
      await asUser(A);
      expect(
        (
          await db.query('select id from public.project_milestones where project_id=$1', [
            memberPrivate,
          ])
        ).rows,
      ).toHaveLength(0);
      await db.query("select public.act_on_project_milestone($1,1,'complete')", [memberStep]);
      await project(shared, 1, 'private');
      await asUser(B);
      expect(
        (await db.query('select id from public.project_milestones where id=$1', [publicStep])).rows,
      ).toHaveLength(0);
      await asUser(A);
      await project(shared, 2, 'workspace');
    });
    it('allows personal budgets on readable shared projects without exposing others’ plans', async () => {
      budget = await plan();
      await plan(budget, privateProject, null, 'INR', 90000);
      await plan(budget, privateProject, 1, 'INR', 12000);
      await expect(plan(budget, privateProject, 1)).rejects.toThrow(/changed/);
      await expect(plan(randomUUID(), privateProject, null, 'INR')).rejects.toThrow(
        /already exists/,
      );
      await asUser(B);
      const memberBudget = await plan(randomUUID(), shared);
      await expect(plan(randomUUID(), privateProject)).rejects.toThrow(/inaccessible/);
      await asUser(A);
      expect(
        (await db.query('select id from public.project_budgets where id=$1', [memberBudget])).rows,
      ).toHaveLength(0);
      await expect(
        db.query('select public.set_project_budget_archive($1,1,true)', [memberBudget]),
      ).rejects.toThrow(/Budget is inaccessible/);
    });
    it('archives budgets without deleting them and restores with revision checks', async () => {
      await db.query('select public.set_project_budget_archive($1,2,true)', [budget]);
      await db.query('select public.set_project_budget_archive($1,2,true)', [budget]);
      await expect(plan(budget, privateProject, 3)).rejects.toThrow(/restore/);
      await expect(
        db.query('select public.set_project_budget_archive($1,2,false)', [budget]),
      ).rejects.toThrow(/changed/);
      await db.query('select public.set_project_budget_archive($1,3,false)', [budget]);
      await plan(randomUUID(), privateProject, null, 'USD', 200);
      expect(
        (
          await db.query('select currency from public.project_budgets where project_id=$1', [
            privateProject,
          ])
        ).rows,
      ).toHaveLength(2);
    });
    it('links only owned expenses, preserves ledger values and prevents stale moves', async () => {
      account = (
        await db.query<{ id: string }>(
          "insert into public.accounts(workspace_id,name,currency)values($1,'Project costs','INR')returning id",
          [w],
        )
      ).rows[0].id;
      expense = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Synthetic materials',1500,'expense','Supplies',current_date)as id",
          [w, account],
        )
      ).rows[0].id;
      await db.query('select public.link_project_expense($1,null,$2)', [expense, privateProject]);
      await db.query('select public.link_project_expense($1,null,$2)', [expense, privateProject]);
      await expect(
        db.query('select public.link_project_expense($1,null,$2)', [expense, shared]),
      ).rejects.toThrow(/link changed/);
      const row = (
        await db.query<{ amount: string; account_id: string; kind: string; project_id: string }>(
          'select amount,account_id,kind,project_id from public.transactions where id=$1',
          [expense],
        )
      ).rows[0];
      expect(Number(row.amount)).toBe(1500);
      expect(row.account_id).toBe(account);
      expect(row.kind).toBe('expense');
      expect(row.project_id).toBe(privateProject);
      await asUser(B);
      await expect(
        db.query('select public.link_project_expense($1,$2,null)', [expense, privateProject]),
      ).rejects.toThrow(/Expense is inaccessible/);
      await asUser(A);
      const income = (
        await db.query<{ id: string }>(
          "select public.record_transaction($1,$2,'Income',100,'income','Other',current_date)as id",
          [w, account],
        )
      ).rows[0].id;
      await expect(
        db.query('select public.link_project_expense($1,null,$2)', [income, privateProject]),
      ).rejects.toThrow(/Expense is inaccessible/);
    });
    it('rejects cross-workspace bindings and freezes completed-project milestones', async () => {
      const other = (
        await db.query<{ id: string }>("select public.create_workspace('Other project tests')as id")
      ).rows[0].id;
      const p = (
        await db.query<{ id: string }>(
          "insert into public.projects(workspace_id,title)values($1,'Other project')returning id",
          [other],
        )
      ).rows[0].id;
      await expect(step(randomUUID(), p)).rejects.toThrow(/inaccessible/);
      await expect(
        db.query('select public.link_project_expense($1,$2,$3)', [expense, privateProject, p]),
      ).rejects.toThrow(/Project is inaccessible/);
      await project(privateProject, await revision(privateProject), 'private', 'completed');
      await expect(step()).rejects.toThrow(/Reopen/);
      await expect(
        db.query("select public.act_on_project_milestone($1,4,'reopen')", [milestone]),
      ).rejects.toThrow(/Reopen/);
      await project(privateProject, await revision(privateProject));
    });
    it('prevents making a project private while shared children retain their link', async () => {
      const task = (
        await db.query<{ id: string }>(
          "insert into public.tasks(workspace_id,title,visibility,project_id)values($1,'Shared linked task','workspace',$2)returning id",
          [w, shared],
        )
      ).rows[0].id;
      await expect(project(shared, await revision(shared), 'private')).rejects.toThrow(
        /Keep this project shared/,
      );
      await db.query("update public.tasks set visibility='private' where id=$1", [task]);
      await project(shared, await revision(shared), 'private');
    });
    it('denies viewers, removed members and anonymous RPC access', async () => {
      await asUser(C);
      await expect(plan(randomUUID(), shared)).rejects.toThrow(/inaccessible/);
      await expect(step(randomUUID(), shared)).rejects.toThrow(/inaccessible/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.project_milestones where workspace_id=$1', [w]))
          .rows,
      ).toHaveLength(0);
      expect(
        (await db.query('select id from public.project_budgets where workspace_id=$1', [w])).rows,
      ).toHaveLength(0);
      await db.exec('reset role;set role anon');
      await expect(db.query('select id from public.project_budgets')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query("select public.act_on_project_milestone($1,4,'archive')", [milestone]),
      ).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
