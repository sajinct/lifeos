import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
export function assetSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
) {
  describe('Private assets, document links and immutable service history', () => {
    let db: PGlite,
      w: string,
      other: string,
      asset: string,
      file: string,
      unfinished: string,
      plan: string,
      today: string;
    async function save(
      v: {
        id?: string;
        workspace?: string;
        revision?: number;
        name?: string;
        price?: number;
        purchase?: string;
        warranty?: string | null;
        files?: string[];
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query(
        'select public.save_asset($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [
          id,
          v.workspace ?? w,
          v.revision ?? null,
          v.name ?? 'Sample washer',
          'Appliance',
          'Example',
          'Model A',
          'SAMPLE-1',
          'Home',
          v.purchase ?? '2025-01-01',
          v.price ?? 500,
          'INR',
          v.warranty === undefined ? today : v.warranty,
          'Synthetic only',
          v.files ?? [file],
        ],
      );
      return id;
    }
    async function schedule(
      v: {
        id?: string;
        workspace?: string;
        revision?: number;
        asset?: string;
        due?: string;
        frequency?: string;
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.save_maintenance_plan($1,$2,$3,$4,$5,$6,$7,$8)', [
        id,
        v.workspace ?? w,
        v.revision ?? null,
        v.asset ?? asset,
        'Clean filter',
        v.due ?? '2025-01-31',
        v.frequency ?? 'monthly',
        'Synthetic only',
      ]);
      return id;
    }
    async function service(
      v: {
        id?: string;
        plan?: string;
        revision?: number;
        due?: string;
        performed?: string;
        cost?: number | null;
      } = {},
    ) {
      const id = v.id ?? randomUUID();
      await db.query('select public.record_maintenance($1,$2,$3,$4,$5,$6,$7)', [
        id,
        v.plan ?? plan,
        v.revision ?? 1,
        v.due ?? '2025-01-31',
        v.performed ?? today,
        v.cost === undefined ? 10 : v.cost,
        'Synthetic only',
      ]);
      return id;
    }
    async function fixture(workspace: string, person: string, ready: boolean) {
      const id = randomUUID();
      await db.exec('reset role');
      await db.query(
        "insert into public.attachments(id,workspace_id,owner_id,name,object_path,mime_type,size_bytes) values($1,$2,$3,'Synthetic warranty.pdf',$4,'application/pdf',10)",
        [id, workspace, person, `${person}/${workspace}/${id}.pdf`],
      );
      if (ready) await db.query("update public.attachments set status='ready' where id=$1", [id]);
      await asUser(A);
      return id;
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (await db.query<{ id: string }>("select public.create_workspace('Asset checks') as id"))
        .rows[0].id;
      today = (
        await db.query<{ d: string }>("select (now() at time zone 'Asia/Kolkata')::date::text as d")
      ).rows[0].d;
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      other = (
        await db.query<{ id: string }>("select public.create_workspace('Other assets') as id")
      ).rows[0].id;
      await asUser(A);
      file = await fixture(w, A, true);
      unfinished = await fixture(w, A, false);
    });
    it('requires RPC writes and validates dates, amounts and bounded metadata', async () => {
      for (const table of ['assets', 'asset_documents', 'maintenance_plans', 'maintenance_logs']) {
        await expect(db.query(`delete from public.${table}`)).rejects.toThrow(/permission denied/);
        await expect(db.query(`update public.${table} set owner_id=$1`, [B])).rejects.toThrow(
          /permission denied/,
        );
      }
      for (const v of [
        { name: '' },
        { price: -1 },
        { price: 1.001 },
        { price: NaN },
        { purchase: '2200-01-01' },
        { warranty: '2024-01-01' },
        { files: Array.from({ length: 51 }, () => file) },
      ])
        await expect(save(v)).rejects.toThrow();
      asset = await save();
    });
    it('makes asset creation retries stable and rejects stale revisions', async () => {
      await save({ id: asset, name: 'Ignored retry', files: [] });
      expect(
        (await db.query<{ name: string }>('select name from public.assets where id=$1', [asset]))
          .rows[0].name,
      ).toBe('Sample washer');
      expect(
        (await db.query('select id from public.asset_documents where asset_id=$1', [asset])).rows,
      ).toHaveLength(1);
      await save({ id: asset, revision: 1, name: 'Edited washer', files: [file, file] });
      await expect(save({ id: asset, revision: 1 })).rejects.toThrow(/changed/);
      expect(
        (await db.query('select id from public.asset_documents where asset_id=$1', [asset])).rows,
      ).toHaveLength(1);
    });
    it('rejects foreign, cross-workspace, missing and unfinished file links atomically', async () => {
      const foreign = await fixture(other, B, true),
        otherOwned = await fixture(other, A, true),
        sameWorkspaceForeign = await fixture(w, B, true);
      for (const files of [
        [foreign],
        [otherOwned],
        [sameWorkspaceForeign],
        [unfinished],
        [randomUUID()],
      ])
        await expect(save({ id: asset, revision: 2, files })).rejects.toThrow(/completed document/);
      expect(
        (
          await db.query<{ revision: number }>('select revision from public.assets where id=$1', [
            asset,
          ])
        ).rows[0].revision,
      ).toBe(2);
      expect(
        (await db.query('select id from public.asset_documents where asset_id=$1', [asset])).rows,
      ).toHaveLength(1);
      await db.query("select public.set_attachment_status($1,'archived')", [file]);
      await save({ id: asset, revision: 2 });
    });
    it('isolates viewer and workspace-owner reads of member-private assets', async () => {
      await asUser(B);
      for (const table of ['assets', 'asset_documents', 'maintenance_plans', 'maintenance_logs'])
        expect(
          (await db.query(`select id from public.${table} where workspace_id=$1`, [w])).rows,
        ).toHaveLength(0);
      await expect(save({ files: [] })).rejects.toThrow(/write/);
      await expect(save({ id: asset, workspace: other, files: [] })).rejects.toThrow(
        /inaccessible/,
      );
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      await asUser(B);
      const member = await save({ files: [] });
      await asUser(A);
      expect(
        (await db.query('select id from public.assets where id=$1', [member])).rows,
      ).toHaveLength(0);
      await expect(
        db.query("select public.set_asset_status($1,1,'sold')", [member]),
      ).rejects.toThrow(/owner/);
    });
    it('validates plan ownership, creation replay, stale edits and exact asset binding', async () => {
      await expect(schedule({ asset: randomUUID() })).rejects.toThrow(/active asset/);
      await expect(schedule({ frequency: 'weekly' })).rejects.toThrow(/Invalid/);
      plan = await schedule();
      await schedule({ id: plan, due: '2100-01-01' });
      expect(
        (
          await db.query<{ next_on: string }>(
            'select next_on::text from public.maintenance_plans where id=$1',
            [plan],
          )
        ).rows[0].next_on,
      ).toBe('2025-01-31');
      const a = await save({ files: [] });
      await expect(schedule({ id: plan, revision: 1, asset: a })).rejects.toThrow(/inaccessible/);
      await schedule({ id: plan, revision: 1 });
      await expect(schedule({ id: plan, revision: 1 })).rejects.toThrow(/changed/);
    });
    it('denies other editors access to service schedules, logs and completions', async () => {
      await asUser(B);
      expect(
        (await db.query('select id from public.maintenance_plans where id=$1', [plan])).rows,
      ).toHaveLength(0);
      await expect(schedule({ asset })).rejects.toThrow(/active asset/);
      await expect(service({ revision: 2 })).rejects.toThrow(/owner/);
      await expect(
        db.query("select public.set_maintenance_status($1,2,'paused')", [plan]),
      ).rejects.toThrow(/active asset/);
      await asUser(A);
    });
    it('records a service once, advances month-end from the original anchor and never posts Finance', async () => {
      const ledger = (
        await db.query('select id from public.transactions where workspace_id=$1', [w])
      ).rows.length;
      const id = await service({ revision: 2 });
      await service({ id, revision: 2, cost: 999 });
      expect(
        (await db.query('select id from public.maintenance_logs where plan_id=$1', [plan])).rows,
      ).toHaveLength(1);
      expect(
        (
          await db.query<{ next_on: string; revision: number }>(
            'select next_on::text,revision from public.maintenance_plans where id=$1',
            [plan],
          )
        ).rows[0],
      ).toEqual({ next_on: '2025-02-28', revision: 3 });
      await expect(service({ revision: 2 })).rejects.toThrow(/changed/);
      await service({ revision: 3, due: '2025-02-28' });
      expect(
        (
          await db.query<{ next_on: string }>(
            'select next_on::text from public.maintenance_plans where id=$1',
            [plan],
          )
        ).rows[0].next_on,
      ).toBe('2025-03-31');
      expect(
        (await db.query('select id from public.transactions where workspace_id=$1', [w])).rows,
      ).toHaveLength(ledger);
      for (const cost of [-1, 1.001, NaN])
        await expect(service({ revision: 4, due: '2025-03-31', cost })).rejects.toThrow(/Invalid/);
      await expect(
        service({ revision: 4, due: '2025-03-31', performed: '2200-01-01' }),
      ).rejects.toThrow(/Invalid/);
    });
    it('preserves immutable history snapshots and rejects dates already completed after rescheduling', async () => {
      await expect(schedule({ id: plan, revision: 4, due: '2025-01-31' })).rejects.toThrow(
        /already completed/,
      );
      await save({ id: asset, revision: 3, price: 600 });
      await schedule({ id: plan, revision: 4, due: '2025-03-01' });
      await expect(service({ revision: 4, due: '2025-03-31' })).rejects.toThrow(/changed/);
      const row = (
        await db.query<{ title: string; currency: string; cost: number }>(
          'select title,currency,cost from public.maintenance_logs where plan_id=$1 order by scheduled_on limit 1',
          [plan],
        )
      ).rows[0];
      expect(row).toMatchObject({ title: 'Clean filter', currency: 'INR' });
      expect(Number(row.cost)).toBe(10);
      await expect(db.query('update public.maintenance_logs set cost=0')).rejects.toThrow(
        /permission denied/,
      );
    });
    it('supports pause/resume and one-time completion without accidental reopening', async () => {
      await db.query("select public.set_maintenance_status($1,5,'paused')", [plan]);
      await db.query("select public.set_maintenance_status($1,5,'paused')", [plan]);
      await expect(service({ revision: 6, due: '2025-03-01' })).rejects.toThrow(/inactive/);
      await db.query("select public.set_maintenance_status($1,6,'active')", [plan]);
      const once = await schedule({ frequency: 'once', due: today });
      await service({ plan: once, due: today });
      expect(
        (
          await db.query<{ status: string; next_on: null }>(
            'select status,next_on from public.maintenance_plans where id=$1',
            [once],
          )
        ).rows[0],
      ).toEqual({ status: 'completed', next_on: null });
      await expect(
        db.query("select public.set_maintenance_status($1,2,'active')", [once]),
      ).rejects.toThrow(/cannot resume/);
    });
    it('delivers private warranty/service reminders once and clears notices on asset retirement', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,true,30,7)",
      );
      await db.exec('reset role');
      await db.query('select public.deliver_due_reminders()');
      await db.query('select public.deliver_due_reminders()');
      for (const [id, kind] of [
        [asset, 'warranty'],
        [plan, 'maintenance'],
      ])
        expect(
          (
            await db.query(
              'select id from public.notifications where source_id=$1 and source_kind=$2 and dismissed_at is null',
              [id, kind],
            )
          ).rows,
        ).toHaveLength(1);
      await asUser(A);
      await db.query("select public.set_asset_status($1,4,'retired')", [asset]);
      expect(
        (
          await db.query(
            'select id from public.notifications where source_id in($1,$2) and dismissed_at is null',
            [asset, plan],
          )
        ).rows,
      ).toHaveLength(0);
      await expect(schedule()).rejects.toThrow(/active asset/);
      await expect(service({ revision: 7, due: '2025-03-01' })).rejects.toThrow(/inactive/);
      expect(
        (await db.query('select id from public.maintenance_logs where asset_id=$1', [asset])).rows,
      ).toHaveLength(3);
      await db.query("select public.set_asset_status($1,5,'active')", [asset]);
      expect(
        (await db.query('select id from public.asset_documents where asset_id=$1', [asset])).rows,
      ).toHaveLength(1);
    });
    it('preserves asset settings through old RPCs and prevents browser scheduler access', async () => {
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7)",
      );
      expect(
        (
          await db.query<{ asset_reminders: boolean }>(
            'select asset_reminders from public.app_settings where id=$1',
            [A],
          )
        ).rows[0].asset_reminders,
      ).toBe(true);
      await db.query(
        "select public.save_reminder_preferences(false,false,false,1,3,30,0,'UTC',false,7,false,3,false,1,false,7,false,30,7)",
      );
      expect(
        (
          await db.query(
            "select id from public.notifications where owner_id=$1 and source_kind in ('warranty','maintenance') and dismissed_at is null",
            [A],
          )
        ).rows,
      ).toHaveLength(0);
      await expect(db.query('select public.deliver_due_reminders()')).rejects.toThrow(
        /permission denied/,
      );
    });
    it('revokes removed-member access and denies anonymous asset reads and RPCs', async () => {
      await asUser(B);
      const mine = await save({ files: [] });
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select id from public.assets where id=$1', [mine])).rows,
      ).toHaveLength(0);
      await expect(save({ id: mine, revision: 1, files: [] })).rejects.toThrow(/write/);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.assets')).rejects.toThrow(/permission denied/);
      await expect(save({ files: [] })).rejects.toThrow(/permission denied/);
      await asUser(A);
    });
  });
}
