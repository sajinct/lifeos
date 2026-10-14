import { PGlite } from '@electric-sql/pglite';
import { Blob, Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { createTestDatabase } from './test-database.mjs';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identifier = (v) => '"' + v.replaceAll('"', '""') + '"';
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const schemas = "'public','private','auth','storage','supabase_migrations'";
export async function databaseInventory(db) {
  await db.exec("reset role;set time zone 'UTC'");
  const tables = (
    await db.query(
      `select n.nspname as schema,c.relname as name,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,c.relacl::text as acl,pg_get_userbyid(c.relowner) as owner from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in(${schemas}) and c.relkind in('r','p') order by n.nspname,c.relname`,
    )
  ).rows;
  const records = [];
  for (const table of tables) {
    const rows = (
      await db.query(
        `select to_jsonb(r)::text as content from ${identifier(table.schema)}.${identifier(table.name)} r order by to_jsonb(r)::text`,
      )
    ).rows;
    records.push({
      schema: table.schema,
      table: table.name,
      rows: rows.length,
      sha256: sha256(JSON.stringify(rows)),
    });
  }
  const catalog = { tables };
  const queries = {
    enums: `select n.nspname,t.typname,e.enumlabel,e.enumsortorder from pg_enum e join pg_type t on t.oid=e.enumtypid join pg_namespace n on n.oid=t.typnamespace where n.nspname in(${schemas}) order by n.nspname,t.typname,e.enumsortorder`,
    views: `select schemaname,viewname,viewowner,definition from pg_views where schemaname in(${schemas}) order by schemaname,viewname`,
    defaultPrivileges: `select pg_get_userbyid(d.defaclrole) as owner,n.nspname,d.defaclobjtype,d.defaclacl::text as acl from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where n.nspname in(${schemas}) or d.defaclnamespace=0 order by owner,n.nspname,d.defaclobjtype`,
    roles:
      'select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig from pg_roles order by rolname',
    schemas: `select nspname,nspacl::text as acl,pg_get_userbyid(nspowner) as owner from pg_namespace where nspname in(${schemas}) order by nspname`,
    columns: `select n.nspname,c.relname,a.attname,a.attnum,a.attnotnull,a.attacl::text as acl,format_type(a.atttypid,a.atttypmod) as type,pg_get_expr(d.adbin,d.adrelid) as default_expression from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname in(${schemas}) and c.relkind in('r','p') and a.attnum>0 and not a.attisdropped order by n.nspname,c.relname,a.attnum`,
    policies: `select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname in(${schemas}) order by schemaname,tablename,policyname`,
    constraints: `select n.nspname,c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid) as definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in(${schemas}) order by n.nspname,c.relname,k.conname`,
    triggers: `select n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in(${schemas}) and not t.tgisinternal order by n.nspname,c.relname,t.tgname`,
    functions: `select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) as arguments,p.proacl::text as acl,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) as owner,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in(${schemas}) and p.prokind='f' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`,
    indexes: `select schemaname,tablename,indexname,indexdef from pg_indexes where schemaname in(${schemas}) order by schemaname,tablename,indexname`,
    sequences: `select schemaname,sequencename,sequenceowner,data_type,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value from pg_sequences where schemaname in(${schemas}) order by schemaname,sequencename`,
  };
  for (const [name, sql] of Object.entries(queries)) catalog[name] = (await db.query(sql)).rows;
  return { records, catalog, catalogSha256: sha256(JSON.stringify(catalog)) };
}
export async function restoreDatabaseSnapshot(source, saveSnapshot) {
  const before = await databaseInventory(source),
    dump = Buffer.from(await (await source.dumpDataDir('gzip')).arrayBuffer()),
    checksum = sha256(dump);
  const loaded = saveSnapshot ? await saveSnapshot(dump, checksum) : dump;
  assert(sha256(loaded) === checksum, 'Database archive checksum differs before restore.');
  const restored = new PGlite({ loadDataDir: new Blob([loaded]) });
  try {
    const after = await databaseInventory(restored);
    assert(
      equal(before.records, after.records),
      'Restored table row counts or content hashes differ.',
    );
    assert(
      equal(before.catalog, after.catalog),
      'Restored schema, roles, grants or security definitions differ.',
    );
    const publicTables = after.records.filter((t) => t.schema === 'public').length;
    assert(
      after.catalog.tables.filter((t) => t.schema === 'public').every((t) => t.rls),
      'A restored application table has RLS disabled.',
    );
    return {
      restored,
      inventory: after,
      database: {
        bytes: dump.length,
        sha256: checksum,
        tables: after.records.length,
        publicTables,
        rows: after.records.reduce((n, t) => n + t.rows, 0),
        catalogSha256: after.catalogSha256,
      },
    };
  } catch (e) {
    await restored.close();
    throw e;
  }
}
export function verifyFileBundle(manifest, files) {
  assert(Array.isArray(manifest), 'File manifest must be an array.');
  const seen = new Set();
  for (const entry of manifest) {
    assert(
      entry &&
        ['personal-documents', 'financial-receipts'].includes(entry.bucket) &&
        typeof entry.path === 'string' &&
        /^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.(txt|png)$/.test(entry.path) &&
        typeof entry.mime === 'string' &&
        ((entry.mime === 'text/plain' && entry.path.endsWith('.txt')) ||
          (entry.mime === 'image/png' && entry.path.endsWith('.png'))) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        typeof entry.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.sha256),
      'Invalid synthetic file manifest entry.',
    );
    const key = entry.bucket + '/' + entry.path;
    assert(!seen.has(key), 'Duplicate file manifest entry.');
    seen.add(key);
    const body = files.get(key);
    assert(
      body && body.length === entry.bytes && sha256(body) === entry.sha256,
      'Missing file or file size/checksum mismatch.',
    );
  }
  assert(seen.size === files.size, 'File bundle contains unlisted objects.');
  return manifest.length;
}
async function user(db, id) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function denied(run, message) {
  let failed = false;
  try {
    await run();
  } catch {
    failed = true;
  }
  assert(failed, message);
}
async function seed(db) {
  const a = randomUUID(),
    b = randomUUID(),
    outsider = randomUUID(),
    transfer = randomUUID(),
    noteRequest = randomUUID(),
    note = randomUUID(),
    learningBatch = randomUUID();
  await db.query(
    'insert into auth.users(id,raw_user_meta_data)values($1,\'{"display_name":"Synthetic owner"}\'),($2,\'{"display_name":"Synthetic member"}\'),($3,\'{"display_name":"Synthetic outsider"}\')',
    [a, b, outsider],
  );
  await user(db, a);
  const w = (await db.query("select public.create_workspace('Local recovery drill','family') id"))
    .rows[0].id;
  const other = (
    await db.query("select public.create_workspace('Independent recovery workspace','personal') id")
  ).rows[0].id;
  await db.query("select public.set_workspace_member($1,$2,'editor')", [w, b]);
  const project = (
    await db.query(
      "insert into public.projects(workspace_id,title,visibility)values($1,'Shared recovery project','workspace') returning id",
      [w],
    )
  ).rows[0].id;
  await db.query(
    "insert into public.tasks(workspace_id,title,visibility,project_id)values($1,'Shared recovery task','workspace',$2)",
    [w, project],
  );
  const from = (
    await db.query(
      "insert into public.accounts(workspace_id,name,opening_balance)values($1,'Source',1000) returning id",
      [w],
    )
  ).rows[0].id;
  const to = (
    await db.query(
      "insert into public.accounts(workspace_id,name,opening_balance)values($1,'Destination',0) returning id",
      [w],
    )
  ).rows[0].id;
  await db.query(
    "select public.record_transaction($1,$2,'Synthetic income',125.25,'income','Other','2026-01-01')",
    [w, from],
  );
  await db.query('select public.transfer_funds($1,$2,$3,100.25,$4)', [w, from, to, transfer]);
  await user(db, b);
  await db.query(
    "insert into public.tasks(workspace_id,title)values($1,'Member private recovery task')",
    [w],
  );
  const files = new Map(),
    manifest = [];
  async function document(bucket, body, previous = null) {
    const id = randomUUID(),
      extension = bucket === 'financial-receipts' ? 'png' : 'txt',
      mime = extension === 'png' ? 'image/png' : 'text/plain',
      path = `${b}/${w}/${id}.${extension}`,
      bytes = Buffer.from(body);
    await db.query(
      'insert into public.attachments(id,workspace_id,bucket_id,name,object_path,mime_type,size_bytes,previous_version_id)values($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, w, bucket, 'Synthetic recovery.' + extension, path, mime, bytes.length, previous],
    );
    await db.query('insert into storage.objects(bucket_id,name,metadata)values($1,$2,$3)', [
      bucket,
      path,
      JSON.stringify({ size: bytes.length, mimetype: mime }),
    ]);
    await db.query('select public.complete_attachment($1)', [id]);
    files.set(bucket + '/' + path, bytes);
    manifest.push({
      bucket,
      path,
      mime,
      bytes: bytes.length,
      sha256: sha256(bytes),
      attachment: id,
    });
    return id;
  }
  const first = await document('personal-documents', 'Synthetic original file bytes.\n'),
    current = await document('personal-documents', 'Synthetic next file version bytes.\n', first),
    receipt = await document(
      'financial-receipts',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1kAAAAASUVORK5CYII=',
        'base64',
      ),
    );
  await db.query(
    "select public.save_note($1,$2,$3,null,'Recovery journal','Literal <script>text</script>',null,array['recovery'],'2026-01-01','private',$4)",
    [noteRequest, note, w, [current]],
  );
  await db.query('select public.set_note_archived($1,$2,1,true)', [randomUUID(), note]);
  const learningPayload = [
    {
      source_id: 'recovery-learning-source',
      kind: 'course',
      title: 'Recovered learning',
      provider: '',
      url: '',
      goal: 'Keep progress',
      due_on: '2027-01-31',
      notes: 'Synthetic notes',
      status: 'completed',
      completed_on: '2026-01-01',
      archived: true,
      units: [
        {
          position: 1,
          title: 'Recovered lesson',
          notes: 'Keep history',
          done: true,
          archived: false,
        },
      ],
    },
  ];
  await db.query('select public.import_learning_json($1,$2,$3)', [
    learningBatch,
    w,
    JSON.stringify(learningPayload),
  ]);
  const item = (await db.query('select id from public.learning_items where workspace_id=$1', [w]))
    .rows[0].id;
  await db.query("select public.set_learning_state($1,$2,1,'completed',false)", [
    randomUUID(),
    item,
  ]);
  await db.query(
    "select public.save_learning_item($1,$2,$3,2,'course','Recovered learning','','','Keep progress','2027-01-31','Synthetic notes',$4,'{}',$5)",
    [randomUUID(), item, w, [note], [current]],
  );
  await db.query("select public.set_learning_state($1,$2,3,'completed',true)", [
    randomUUID(),
    item,
  ]);
  await db.exec('reset role');
  return {
    a,
    b,
    outsider,
    w,
    other,
    from,
    to,
    transfer,
    note,
    noteRequest,
    learningBatch,
    learningPayload,
    item,
    first,
    current,
    receipt,
    manifest,
    files,
  };
}
export async function runLocalRecoveryDrill({ output } = {}) {
  const started = new Date().toISOString(),
    checks = [],
    { db: source, migrations } = await createTestDatabase();
  let restored;
  try {
    const fixture = await seed(source);
    let directory;
    if (output) {
      const root = resolve('.recovery-drill');
      directory = resolve(output);
      assert(
        directory.startsWith(root + sep) && directory !== root,
        'Drill output must be a new directory under .recovery-drill.',
      );
      await mkdir(root, { recursive: true });
      await mkdir(directory);
    }
    const snapshot = await restoreDatabaseSnapshot(
      source,
      directory
        ? async (bytes, hash) => {
            const target = resolve(directory, 'database.pglite.tar.gz');
            await writeFile(target, bytes, { flag: 'wx' });
            const reloaded = await readFile(target);
            assert(
              sha256(reloaded) === hash,
              'Saved database archive failed checksum verification.',
            );
            return reloaded;
          }
        : undefined,
    );
    restored = snapshot.restored;
    checks.push(
      'Database restored into a separate fresh PGlite instance',
      'Every table row count/content hash matches across application, private, Auth/Storage shims and migration history',
      'Roles, table/column grants, RLS policies, constraints, functions, triggers, indexes and sequences match',
    );
    let files = fixture.files;
    if (directory) {
      files = new Map();
      for (const entry of fixture.manifest) {
        const target = resolve(directory, 'storage', entry.bucket, entry.path);
        assert(
          target.startsWith(resolve(directory, 'storage') + sep),
          'File output escaped its bundle directory.',
        );
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, fixture.files.get(entry.bucket + '/' + entry.path), { flag: 'wx' });
        files.set(entry.bucket + '/' + entry.path, await readFile(target));
      }
      await writeFile(
        resolve(directory, 'storage-manifest.json'),
        JSON.stringify(fixture.manifest, null, 2) + '\n',
        { flag: 'wx' },
      );
    }
    verifyFileBundle(fixture.manifest, files);
    for (const entry of fixture.manifest) {
      const row = (
        await restored.query(
          'select bucket_id,object_path,mime_type,size_bytes from public.attachments where id=$1',
          [entry.attachment],
        )
      ).rows[0];
      assert(
        row &&
          row.bucket_id === entry.bucket &&
          row.object_path === entry.path &&
          row.mime_type === entry.mime &&
          Number(row.size_bytes) === entry.bytes,
        'Restored attachment metadata differs from file manifest.',
      );
      assert(
        (
          await restored.query('select id from storage.objects where bucket_id=$1 and name=$2', [
            entry.bucket,
            entry.path,
          ])
        ).rows.length === 1,
        'Restored Storage metadata missing.',
      );
    }
    checks.push(
      'Separate three-file synthetic byte bundle passes original-path, MIME, size, SHA-256 and restored metadata reconciliation',
    );
    await user(restored, fixture.a);
    const ledger = async () =>
      (
        await restored.query(
          'select id,amount,kind,account_id from public.transactions where workspace_id=$1 order by id',
          [fixture.w],
        )
      ).rows;
    const before = await ledger();
    await restored.query('select public.transfer_funds($1,$2,$3,100.25,$4)', [
      fixture.w,
      fixture.from,
      fixture.to,
      fixture.transfer,
    ]);
    assert(equal(before, await ledger()), 'Transfer replay duplicated the restored ledger.');
    const balances = (
      await restored.query(
        "select a.id,(a.opening_balance+coalesce(sum(case when t.kind in('income','transfer_in')then t.amount else -t.amount end),0))::text balance from public.accounts a left join public.transactions t on t.account_id=a.id where a.id in($1,$2) group by a.id",
        [fixture.from, fixture.to],
      )
    ).rows;
    assert(
      Number(balances.find((r) => r.id === fixture.from)?.balance) === 1025 &&
        Number(balances.find((r) => r.id === fixture.to)?.balance) === 100.25,
      'Restored account balances differ.',
    );
    checks.push('Ledger balances and exact transfer request replay remain correct');
    assert(
      (await restored.query('select id from public.learning_items where id=$1', [fixture.item]))
        .rows.length === 0 &&
        (await restored.query('select id from public.notes where id=$1', [fixture.note])).rows
          .length === 0 &&
        (await restored.query('select id from public.attachments where id=$1', [fixture.current]))
          .rows.length === 0,
      'Workspace owner read member-private records.',
    );
    checks.push('Workspace owner cannot read a member’s learning, journal or attachment metadata');
    await user(restored, fixture.b);
    assert(
      (await restored.query('select id from public.accounts where id=$1', [fixture.from])).rows
        .length === 0,
      'Member read owner financial records.',
    );
    const old = (
      await restored.query('select status,version_number from public.attachments where id=$1', [
        fixture.first,
      ])
    ).rows[0];
    assert(
      old?.status === 'archived' && old.version_number === 1,
      'Immutable file version history lost.',
    );
    assert(
      (
        await restored.query('select note_id from public.learning_notes where item_id=$1', [
          fixture.item,
        ])
      ).rows[0]?.note_id === fixture.note &&
        (
          await restored.query(
            'select attachment_id from public.learning_documents where item_id=$1',
            [fixture.item],
          )
        ).rows[0]?.attachment_id === fixture.current,
      'Private learning links lost.',
    );
    checks.push(
      'Private financial isolation, archived file versions and journal/certificate links survive restore',
    );
    const imported = (
      await restored.query('select public.import_learning_json($1,$2,$3) result', [
        fixture.learningBatch,
        fixture.w,
        JSON.stringify(fixture.learningPayload),
      ])
    ).rows[0].result;
    const reupload = (
      await restored.query('select public.import_learning_json($1,$2,$3) result', [
        randomUUID(),
        fixture.w,
        JSON.stringify(fixture.learningPayload),
      ])
    ).rows[0].result;
    assert(
      imported.items_imported === 1 &&
        reupload.skipped === 1 &&
        (
          await restored.query('select revision,archived from public.learning_items where id=$1', [
            fixture.item,
          ])
        ).rows[0]?.revision === 4,
      'Import receipts or source binding lost.',
    );
    checks.push(
      'Private import batch receipts and source bindings preserve destination edits on reupload',
    );
    await restored.query(
      "select public.save_note($1,$2,$3,null,'Recovery journal','Literal <script>text</script>',null,array['recovery'],'2026-01-01','private',$4)",
      [fixture.noteRequest, fixture.note, fixture.w, [fixture.current]],
    );
    assert(
      (
        await restored.query('select archived,revision from public.notes where id=$1', [
          fixture.note,
        ])
      ).rows[0]?.archived === true,
      'Replayed note creation undid later archival.',
    );
    await denied(
      () =>
        restored.query('select public.set_note_archived($1,$2,1,false)', [
          randomUUID(),
          fixture.note,
        ]),
      'Restored revision protection accepted a stale write.',
    );
    checks.push(
      'Saved note requests remain idempotent without undoing archives; stale revisions are denied',
    );
    await user(restored, fixture.a);
    await restored.query("select public.set_workspace_member($1,$2,'viewer')", [
      fixture.w,
      fixture.b,
    ]);
    await user(restored, fixture.b);
    assert(
      (await restored.query('select id from public.learning_items where id=$1', [fixture.item]))
        .rows.length === 1,
      'Viewer lost own read access.',
    );
    await denied(
      () =>
        restored.query('select public.import_learning_json($1,$2,$3)', [
          fixture.learningBatch,
          fixture.w,
          JSON.stringify(fixture.learningPayload),
        ]),
      'Viewer replay bypassed current write authorization.',
    );
    await denied(
      () => restored.query('select * from private.learning_import_sources'),
      'Browser role read private import audit payloads.',
    );
    checks.push(
      'Viewer read-only boundaries and private audit grants remain enforced, including cached retries',
    );
    await user(restored, fixture.a);
    await restored.query('select public.remove_workspace_member($1,$2)', [fixture.w, fixture.b]);
    await user(restored, fixture.b);
    assert(
      (await restored.query('select id from public.learning_items where id=$1', [fixture.item]))
        .rows.length === 0 &&
        (await restored.query('select id from storage.objects')).rows.length === 0,
      'Revoked membership retained private data access.',
    );
    await user(restored, fixture.outsider);
    assert(
      (await restored.query('select id from public.learning_items')).rows.length === 0,
      'Outsider read private learning.',
    );
    await restored.exec('reset role;set role anon');
    await denied(
      () => restored.query('select * from public.learning_items'),
      'Anonymous role read private Learning.',
    );
    await denied(
      () =>
        restored.query('select public.import_learning_json($1,$2,$3)', [
          fixture.learningBatch,
          fixture.w,
          JSON.stringify(fixture.learningPayload),
        ]),
      'Anonymous import access returned after restore.',
    );
    checks.push(
      'Removed members, outsiders and anonymous callers cannot access recovered private data',
    );
    const report = {
      status: 'passed',
      scope: 'local-synthetic-only',
      runtime: {
        node: process.version,
        pglite: JSON.parse(
          await readFile(resolve('node_modules/@electric-sql/pglite/package.json'), 'utf8'),
        ).version,
      },
      startedAt: started,
      completedAt: new Date().toISOString(),
      database: snapshot.database,
      migrations,
      files: {
        count: fixture.manifest.length,
        bytes: fixture.manifest.reduce((n, f) => n + f.bytes, 0),
        sha256: sha256(JSON.stringify(fixture.manifest)),
      },
      checks,
      limitations: [
        'PGlite physical snapshots are for the same PGlite runtime, not pg_dump backups or Supabase cloud restore files.',
        'Auth and Storage schemas use platform shims; cloud sign-in, signed URLs and actual Storage API recovery are not verified.',
        'Cron, Vault encryption keys, Edge secrets/deployment, SMTP, Realtime and DNS need separate staging validation.',
        'No production records, credentials or cloud services are read or modified.',
      ],
    };
    if (directory) {
      await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
        flag: 'wx',
      });
      await writeFile(
        resolve(directory, 'inventory.json'),
        JSON.stringify(
          { records: snapshot.inventory.records, catalogSha256: snapshot.inventory.catalogSha256 },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    }
    return report;
  } finally {
    await restored?.close();
    await source.close();
  }
}
