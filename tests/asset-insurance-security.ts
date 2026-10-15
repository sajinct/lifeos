import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
export function assetInsuranceSecurityTests(
  database: () => PGlite,
  asUser: (id: string) => Promise<void>,
  A: string,
  B: string,
  C: string,
) {
  describe('Private asset insurance history and selected document versions', () => {
    let db: PGlite,
      w: string,
      asset: string,
      bAsset: string,
      first: string,
      bFile: string,
      pendingFile: string;
    const id = randomUUID(),
      request = randomUUID(),
      memberPolicy = randomUUID(),
      memberRequest = randomUUID();
    const details = {
      title: ' Vehicle policy ',
      provider: ' Example insurer ',
      policy_number: ' P-100 ',
      starts_on: '2026-01-01',
      ends_on: '2026-12-31',
      coverage_amount: 10000,
      premium_amount: 125.25,
      currency: 'INR',
      premium_frequency: 'yearly',
      notes: 'Literal <script>notes</script>',
    };
    async function makeAsset(name = 'Synthetic car') {
      const id = randomUUID();
      await db.query(
        "select public.save_asset($1,$2,null,$3,'Vehicle','','','','',null,null,'INR',null,'','{}')",
        [id, w, name],
      );
      return id;
    }
    async function file(owner: string, complete = true) {
      const id = randomUUID(),
        path = `${owner}/${w}/${id}.txt`;
      await db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes)values($1,$2,'Policy.txt',$3,'text/plain',5)",
        [id, w, path],
      );
      if (complete) {
        await db.query(
          'insert into storage.objects(bucket_id,name,metadata)values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
          [path],
        );
        await db.query('select public.complete_attachment($1)', [id]);
      }
      return id;
    }
    async function save(
      entry = id,
      revision: number | null = null,
      changes: Record<string, unknown> = {},
      docs = [first],
      req = randomUUID(),
      parent = asset,
    ) {
      return db.query('select public.save_asset_insurance($1,$2,$3,$4,$5,$6,$7)', [
        req,
        entry,
        w,
        revision,
        parent,
        JSON.stringify({ ...details, ...changes }),
        docs,
      ]);
    }
    async function state(
      rev: number,
      cancelled = false,
      archived = false,
      req = randomUUID(),
      entry = id,
    ) {
      return db.query('select public.set_asset_insurance_state($1,$2,$3,$4,$5)', [
        req,
        entry,
        rev,
        cancelled,
        archived,
      ]);
    }
    async function policy(entry = id) {
      return (
        await db.query<{
          revision: number;
          cancelled: boolean;
          archived: boolean;
          premium_amount: string;
          asset_id: string;
        }>('select * from public.asset_insurance where id=$1', [entry])
      ).rows[0];
    }
    beforeAll(async () => {
      db = database();
      await asUser(A);
      w = (
        await db.query<{ id: string }>(
          "select public.create_workspace('Insurance security','family') id",
        )
      ).rows[0].id;
      await db.query("select public.set_workspace_member($1,$2,'editor')", [w, B]);
      asset = await makeAsset();
      first = await file(A);
      pendingFile = await file(A, false);
      await asUser(B);
      bAsset = await makeAsset('Member asset');
      bFile = await file(B);
      await asUser(A);
    });
    it('saves privately with normalized details, exact version links and stable revisions', async () => {
      await asUser(A);
      await save(id, null, {}, [first], request);
      expect(await policy()).toMatchObject({
        revision: 1,
        cancelled: false,
        archived: false,
        asset_id: asset,
      });
      expect(
        (
          await db.query(
            'select title,provider,policy_number from public.asset_insurance where id=$1',
            [id],
          )
        ).rows[0],
      ).toEqual({ title: 'Vehicle policy', provider: 'Example insurer', policy_number: 'P-100' });
      expect(
        (
          await db.query(
            'select attachment_id from public.asset_insurance_documents where insurance_id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ attachment_id: first }]);
    });
    it('isolates members and keeps member-owned policies private from the workspace owner', async () => {
      await asUser(B);
      expect(await policy()).toBeUndefined();
      expect(
        (
          await db.query('select * from public.asset_insurance_documents where workspace_id=$1', [
            w,
          ])
        ).rows,
      ).toEqual([]);
      await expect(save(randomUUID(), null, {}, [], randomUUID(), asset)).rejects.toThrow(
        /your own asset/,
      );
      await save(memberPolicy, null, {}, [bFile], memberRequest, bAsset);
      await asUser(A);
      expect(await policy(memberPolicy)).toBeUndefined();
      await expect(save(randomUUID(), null, {}, [], randomUUID(), bAsset)).rejects.toThrow(
        /your own asset/,
      );
    });
    it('rejects foreign and unfinished documents and leaves metadata and links unchanged atomically', async () => {
      await asUser(A);
      for (const docs of [[bFile], [pendingFile], [first, bFile], Array(51).fill(first)])
        await expect(save(id, 1, { title: 'Should roll back' }, docs)).rejects.toThrow(/document/);
      expect(
        (await db.query('select title,revision from public.asset_insurance where id=$1', [id]))
          .rows[0],
      ).toEqual({ title: 'Vehicle policy', revision: 1 });
      expect(
        (
          await db.query(
            'select attachment_id from public.asset_insurance_documents where insurance_id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ attachment_id: first }]);
    });
    it('validates required types, dates, precision, ranges, premium basis and disallowed metadata', async () => {
      await asUser(A);
      for (const changes of [
        { title: '' },
        { provider: null },
        { policy_number: 'x'.repeat(201) },
        { starts_on: '2026-02-30' },
        { starts_on: '2027-01-01' },
        { ends_on: '2101-01-01' },
        { coverage_amount: 0 },
        { coverage_amount: 1.001 },
        { premium_amount: -1 },
        { premium_amount: 1000000000000 },
        { premium_amount: '20' },
        { premium_frequency: 'daily' },
        { currency: 'inr' },
        { notes: 'x'.repeat(4001) },
        { owner_id: B },
        { visibility: 'workspace' },
      ])
        await expect(save(randomUUID(), null, changes, [])).rejects.toThrow();
      await save(randomUUID(), null, { coverage_amount: null, premium_amount: 0 }, []);
    });
    it('requires exact request payloads and rejects stale revisions or changing the asset binding', async () => {
      await asUser(A);
      await save(id, null, {}, [first], request);
      expect((await policy()).revision).toBe(1);
      await expect(save(id, 1, { title: 'Different' }, [first], request)).rejects.toThrow(
        /already used/,
      );
      await expect(save(id, 99, {}, [])).rejects.toThrow(/changed/);
      const another = await makeAsset('Another asset');
      await expect(save(id, 1, {}, [], randomUUID(), another)).rejects.toThrow(/asset changed/);
      await expect(state(1, true, false, request)).rejects.toThrow(/already used/);
    });
    it('retains cancellation and archives and old save retries cannot undo newer state', async () => {
      await asUser(A);
      await state(1, true, true);
      await save(id, null, {}, [first], request);
      expect(await policy()).toMatchObject({ revision: 2, cancelled: true, archived: true });
      await expect(save(id, 2, {}, [])).rejects.toThrow(/Restore or reopen/);
      await state(2, false, false);
      await save(id, 3, { premium_amount: 150 }, []);
      expect((await policy()).revision).toBe(4);
      expect(
        (
          await db.query('select * from public.asset_insurance_documents where insurance_id=$1', [
            id,
          ])
        ).rows,
      ).toEqual([]);
    });
    it('keeps older policy records when a renewal creates a separate record', async () => {
      await asUser(A);
      const renewal = randomUUID();
      await save(renewal, null, { starts_on: '2027-01-01', ends_on: '2027-12-31' }, []);
      expect((await policy()).revision).toBe(4);
      expect(await policy(renewal)).toMatchObject({
        revision: 1,
        asset_id: asset,
        cancelled: false,
        archived: false,
      });
    });
    it('freezes metadata for inactive assets but allows reversible record state changes', async () => {
      await asUser(A);
      await db.query("select public.set_asset_status($1,1,'sold')", [asset]);
      await expect(save(randomUUID(), null, {}, [])).rejects.toThrow(/Restore the asset/);
      await expect(save(id, 4, {}, [])).rejects.toThrow(/Restore the asset/);
      await state(4, true, true);
      expect(await policy()).toMatchObject({ revision: 5, cancelled: true, archived: true });
      await state(5, false, false);
      await db.query("select public.set_asset_status($1,2,'active')", [asset]);
    });
    it('denies stale state requests, direct mutations, deletes and audit reads', async () => {
      await asUser(A);
      await expect(state(1, true, false)).rejects.toThrow(/changed/);
      await expect(
        db.query('update public.asset_insurance set premium_amount=0 where id=$1', [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query('delete from public.asset_insurance where id=$1', [id]),
      ).rejects.toThrow(/permission denied/);
      await expect(db.query('select * from private.asset_insurance_requests')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.query('select private.insurance_replayed($1,$2,$3)', [randomUUID(), w, '[]']),
      ).rejects.toThrow(/permission denied/);
    });
    it('enforces the per-asset policy bound including archived records', async () => {
      await asUser(A);
      const bounded = await makeAsset('Bounded history');
      await db.exec('reset role');
      await db.query(
        "insert into public.asset_insurance(id,workspace_id,owner_id,asset_id,title,provider,starts_on,ends_on,currency,premium_frequency,archived) select gen_random_uuid(),$1,$2,$3,'Old policy','Example','2025-01-01','2025-12-31','INR','yearly',true from generate_series(1,200)",
        [w, A, bounded],
      );
      await asUser(A);
      await expect(save(randomUUID(), null, {}, [], randomUUID(), bounded)).rejects.toThrow(
        /200 policy records/,
      );
    });
    it('rechecks current membership and role on cached retries without leaking data to outsiders', async () => {
      await asUser(A);
      await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
      await asUser(B);
      await expect(save(randomUUID(), null, {}, [], randomUUID(), bAsset)).rejects.toThrow(
        /write access/,
      );
      await expect(save(memberPolicy, null, {}, [bFile], memberRequest, bAsset)).rejects.toThrow(
        /write access/,
      );
      const own = (
        await db.query<{ id: string }>(
          'select id from public.asset_insurance where workspace_id=$1',
          [w],
        )
      ).rows[0].id;
      await expect(state(1, true, false, randomUUID(), own)).rejects.toThrow(/write access/);
      await asUser(C);
      expect(
        (await db.query('select * from public.asset_insurance where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      await expect(save()).rejects.toThrow(/write access/);
      await asUser(A);
      await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
      await asUser(B);
      expect(
        (await db.query('select * from public.asset_insurance where workspace_id=$1', [w])).rows,
      ).toEqual([]);
    });
    it('denies anonymous entry points and does not create ledger transactions', async () => {
      await asUser(A);
      expect(
        (await db.query('select * from public.transactions where workspace_id=$1', [w])).rows,
      ).toEqual([]);
      await db.exec('reset role;set role anon');
      await expect(db.query('select * from public.asset_insurance')).rejects.toThrow(
        /permission denied/,
      );
      await expect(save()).rejects.toThrow(/permission denied/);
      await expect(state(1)).rejects.toThrow(/permission denied/);
    });
  });
}
