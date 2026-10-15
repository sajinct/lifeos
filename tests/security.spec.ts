import { assetInsuranceSecurityTests } from './asset-insurance-security';
import { shoppingImportSecurityTests } from './shopping-import-security';
import { documentSharingSecurityTests } from './document-sharing-security';
import { householdBudgetSecurityTests } from './household-budget-security';
import { educationSecurityTests } from './education-security';
import { shoppingSecurityTests } from './shopping-security';
import { notesSecurityTests } from './notes-security';
import { learningSecurityTests } from './learning-security';
import { learningImportSecurityTests } from './learning-import-security';
import { calendarSecurityTests } from './calendar-security';
import { wealthSecurityTests } from './wealth-security';
import { financeImportSecurityTests } from './finance-import-security';
import { financeJsonSecurityTests } from './finance-json-security';
import { recordJsonSecurityTests } from './record-json-security';
import { calendarJsonSecurityTests } from './calendar-json-security';
import { emailSecurityTests } from './email-security';
import { cardSecurityTests } from './card-security';
import { travelSecurityTests } from './travel-security';
import { healthTrackingSecurityTests } from './health-tracking-security';
import { PGlite } from '@electric-sql/pglite';
import { createTestDatabase } from '../scripts/lib/test-database.mjs';
import { restoreDatabaseSnapshot } from '../scripts/lib/recovery.mjs';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { contactSecurityTests } from './contact-security';
import { householdSecurityTests } from './household-security';
import { assetSecurityTests } from './asset-security';
import { healthSecurityTests } from './health-security';
import { careerSecurityTests } from './career-security';
import { projectSecurityTests } from './project-security';
import { taskWorkSecurityTests } from './task-work-security';
import { taskSecurityTests } from './task-security';
import { habitSecurityTests } from './habit-security';
import { reportSecurityTests } from './report-security';
import { loanSecurityTests } from './loan-security';
import { subscriptionSecurityTests } from './subscription-security';
const A = '11111111-1111-4111-8111-111111111111',
  B = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';
let db: PGlite;
let workspace: string;
let other: string;
let privateTask: string;
let sharedTask: string;
let privateProject: string;
let source: string;
let destination: string;
async function asUser(id: string) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec('set role authenticated');
}
async function count(table: string) {
  return Number(
    (await db.query<{ n: string }>(`select count(*) as n from public.${table}`)).rows[0].n,
  );
}
async function insert(table: string, cols: string, values: unknown[]) {
  const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
  return (
    await db.query<{ id: string }>(
      `insert into public.${table}(${cols}) values(${placeholders}) returning id`,
      values,
    )
  ).rows[0].id;
}
beforeAll(async () => {
  db = (await createTestDatabase()).db;
  await db.query('insert into auth.users(id) values($1),($2),($3)', [A, B, C]);
  await asUser(A);
  workspace = (
    await db.query<{ id: string }>("select public.create_workspace('Family','family') as id")
  ).rows[0].id;
  privateProject = await insert('projects', 'workspace_id,title', [workspace, 'Secret project']);
  privateTask = await insert('tasks', 'workspace_id,title', [workspace, 'Secret task']);
  sharedTask = await insert('tasks', 'workspace_id,title,visibility', [
    workspace,
    'Shared task',
    'workspace',
  ]);
  source = await insert('accounts', 'workspace_id,name,opening_balance', [
    workspace,
    'Checking',
    100,
  ]);
  destination = await insert('accounts', 'workspace_id,name', [workspace, 'Savings']);
  await asUser(B);
  other = (
    await db.query<{ id: string }>("select public.create_workspace('Personal','personal') as id")
  ).rows[0].id;
});
afterAll(async () => {
  await db?.close();
});

describe('Actual PostgreSQL RLS and permission boundaries', () => {
  it('preserves unrelated platform function permissions', async () => {
    await db.exec('reset role;set role anon');
    expect(
      (await db.query<{ value: number }>('select public.platform_probe() as value')).rows[0].value,
    ).toBe(1);
  });
  it('supports settings upserts without permitting another user’s settings', async () => {
    await asUser(A);
    for (const widget of ['tasks', 'goals'])
      await db.query(
        'insert into public.app_settings(id,dashboard_widgets) values($1,array[$2::text]) on conflict(id) do update set id=excluded.id,dashboard_widgets=excluded.dashboard_widgets',
        [A, widget],
      );
    expect(
      (
        await db.query<{ dashboard_widgets: string[] }>(
          'select dashboard_widgets from public.app_settings',
        )
      ).rows[0].dashboard_widgets,
    ).toEqual(['goals']);
    await asUser(B);
    await expect(db.query('insert into public.app_settings(id) values($1)', [A])).rejects.toThrow(
      /row-level security/,
    );
  });
  it('enables RLS on every application table', async () => {
    await db.exec('reset role');
    const rows = (
      await db.query<{ tablename: string; rowsecurity: boolean }>(
        "select tablename,rowsecurity from pg_tables where schemaname='public'",
      )
    ).rows;
    expect(rows.length).toBe(86);
    expect(rows.every((r) => r.rowsecurity)).toBe(true);
  });
  it('denies anonymous reads and workspace creation', async () => {
    await db.exec('reset role;set role anon');
    await expect(count('tasks')).rejects.toThrow(/permission denied/);
    await expect(db.query("select public.create_workspace('Attack')")).rejects.toThrow(
      /permission denied/,
    );
  });
  it('isolates unrelated users', async () => {
    await asUser(B);
    expect(await count('tasks')).toBe(0);
    expect(await count('profiles')).toBe(1);
  });
  it('rejects insertion into another user’s workspace', async () => {
    await asUser(B);
    await expect(insert('tasks', 'workspace_id,title', [workspace, 'Attack'])).rejects.toThrow(
      /row-level security/,
    );
  });
  it('allows owner-controlled viewer membership', async () => {
    await asUser(A);
    await db.query("select public.set_workspace_member($1,$2,'viewer')", [workspace, B]);
    await asUser(B);
    expect(await count('tasks')).toBe(1);
    expect((await db.query<{ id: string }>('select id from public.tasks')).rows[0].id).toBe(
      sharedTask,
    );
  });
  it('keeps private records private even from workspace owner', async () => {
    await asUser(A);
    await db.query("select public.set_workspace_member($1,$2,'editor')", [workspace, C]);
    await asUser(C);
    await insert('notes', 'workspace_id,title,body', [
      workspace,
      'Private member note',
      'Sensitive',
    ]);
    await asUser(A);
    expect(await count('notes')).toBe(0);
  });
  it('prevents viewers from creating or editing shared records', async () => {
    await asUser(B);
    await expect(
      insert('tasks', 'workspace_id,title', [workspace, 'Viewer write']),
    ).rejects.toThrow(/row-level security/);
    const result = await db.query('update public.tasks set title=$1 where id=$2', [
      'Changed',
      sharedTask,
    ]);
    expect(result.affectedRows).toBe(0);
  });
  it('blocks self-promotion via direct writes and RPC', async () => {
    await asUser(B);
    await expect(
      db.query("update public.workspace_members set role='owner' where user_id=$1", [B]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query("select public.set_workspace_member($1,$2,'editor')", [workspace, B]),
    ).rejects.toThrow(/owner required/);
  });
  it('blocks ownership and tenant changes', async () => {
    await asUser(A);
    await expect(
      db.query('update public.tasks set owner_id=$1 where id=$2', [B, privateTask]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query('update public.tasks set workspace_id=$1 where id=$2', [other, privateTask]),
    ).rejects.toThrow(/permission denied/);
  });
  it('prevents forged ownership on insertion', async () => {
    await asUser(A);
    await expect(
      insert('tasks', 'workspace_id,owner_id,title', [workspace, B, 'Forged']),
    ).rejects.toThrow(/row-level security/);
  });
  it('validates inaccessible project links', async () => {
    await asUser(C);
    await expect(
      insert('tasks', 'workspace_id,title,project_id', [workspace, 'Leaked link', privateProject]),
    ).rejects.toThrow(/inaccessible/);
  });
  it('validates cross-workspace links', async () => {
    await asUser(A);
    await expect(
      insert('tasks', 'workspace_id,title,project_id', [other, 'Cross workspace', privateProject]),
    ).rejects.toThrow();
  });
  it('keeps ledger writes server-owned', async () => {
    await asUser(A);
    await expect(
      insert('transactions', 'workspace_id,account_id,title,amount,kind', [
        workspace,
        source,
        'Forged transfer',
        10,
        'expense',
      ]),
    ).rejects.toThrow(/permission denied/);
  });
  it('records transfers atomically and idempotently', async () => {
    await asUser(A);
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await db.query('select public.transfer_funds($1,$2,$3,25.15,$4)', [
      workspace,
      source,
      destination,
      key,
    ]);
    await db.query('select public.transfer_funds($1,$2,$3,25.15,$4)', [
      workspace,
      source,
      destination,
      key,
    ]);
    const rows = (
      await db.query<{ kind: string; amount: string }>(
        'select kind,amount from public.transactions where transfer_id=$1',
        [key],
      )
    ).rows;
    expect(rows.length).toBe(2);
    expect(
      rows.reduce((sum, r) => sum + (r.kind === 'transfer_in' ? 1 : -1) * Number(r.amount), 0),
    ).toBe(0);
    await expect(
      db.query('select public.transfer_funds($1,$2,$3,25,$4)', [
        workspace,
        source,
        destination,
        key,
      ]),
    ).rejects.toThrow(/Idempotency/);
  });
  it('rejects unauthorized transfers without a partial ledger', async () => {
    await asUser(C);
    await expect(
      db.query('select public.transfer_funds($1,$2,$3,50,gen_random_uuid())', [
        workspace,
        source,
        destination,
      ]),
    ).rejects.toThrow(/owned by caller/);
    expect(await count('transactions')).toBe(0);
    await asUser(A);
    expect(await count('transactions')).toBe(2);
  });
  it('rejects invalid amounts and cross-currency transfers', async () => {
    await asUser(A);
    await expect(
      db.query('select public.transfer_funds($1,$2,$3,0.001,gen_random_uuid())', [
        workspace,
        source,
        destination,
      ]),
    ).rejects.toThrow(/Invalid transfer/);
    const usd = await insert('accounts', 'workspace_id,name,currency', [
      workspace,
      'Dollar account',
      'USD',
    ]);
    await expect(
      db.query('select public.transfer_funds($1,$2,$3,1,gen_random_uuid())', [
        workspace,
        source,
        usd,
      ]),
    ).rejects.toThrow(/currency/);
  });
  it('does not let other members read private files or upload under owner paths', async () => {
    await asUser(A);
    const id = '44444444-4444-4444-8444-444444444444';
    const path = `${A}/${workspace}/${id}.pdf`;
    await db.query(
      "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes,bucket_id) values($1,$2,'receipt.pdf',$3,'application/pdf',10,'financial-receipts')",
      [id, workspace, path],
    );
    await db.query(
      'insert into storage.objects(bucket_id,name,metadata) values(\'financial-receipts\',$1,\'{"size":10,"mimetype":"application/pdf"}\')',
      [path],
    );
    await db.query('select public.complete_attachment($1)', [id]);
    await asUser(B);
    expect(
      Number((await db.query<{ n: string }>('select count(*) n from storage.objects')).rows[0].n),
    ).toBe(0);
    await expect(
      db.query("insert into storage.objects(bucket_id,name) values('financial-receipts',$1)", [
        path + '/attack',
      ]),
    ).rejects.toThrow(/row-level security/);
  });
  it('denies viewer uploads even to their own prefix', async () => {
    await asUser(B);
    await expect(
      db.query("insert into storage.objects(bucket_id,name) values('personal-documents',$1)", [
        `${B}/${workspace}/private.pdf`,
      ]),
    ).rejects.toThrow(/row-level security/);
  });
  it('delivers reminders once and does not expose the scheduler to users', async () => {
    await asUser(A);
    await insert('reminders', 'workspace_id,title,due_at', [
      workspace,
      'Remember this',
      new Date(Date.now() - 1000).toISOString(),
    ]);
    await expect(db.query('select public.deliver_due_reminders()')).rejects.toThrow(
      /permission denied/,
    );
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    await db.query('select public.deliver_due_reminders()');
    await asUser(A);
    expect(await count('notifications')).toBe(1);
    await asUser(B);
    expect(await count('notifications')).toBe(0);
  });
  it('removing membership revokes access immediately', async () => {
    await asUser(A);
    await db.query('select public.remove_workspace_member($1,$2)', [workspace, B]);
    await asUser(B);
    expect(await count('tasks')).toBe(0);
  });
});

describe('Private file reservations and lifecycle', () => {
  let file: string;
  let path: string;
  let next: string;
  it('requires a canonical private reservation and verifies object metadata before completion', async () => {
    await asUser(A);
    file = '55555555-5555-4555-8555-555555555555';
    path = `${A}/${workspace}/${file}.txt`;
    await db.query(
      "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes) values($1,$2,'sample.txt',$3,'text/plain',5)",
      [file, workspace, path],
    );
    await expect(db.query('select public.complete_attachment($1)', [file])).rejects.toThrow(
      /not found/,
    );
    await expect(
      db.query("insert into storage.objects(bucket_id,name) values('financial-receipts',$1)", [
        path,
      ]),
    ).rejects.toThrow(/row-level security/);
    await db.query(
      'insert into storage.objects(bucket_id,name,metadata) values(\'personal-documents\',$1,\'{"size":6,"mimetype":"text/plain"}\')',
      [path],
    );
    await expect(db.query('select public.complete_attachment($1)', [file])).rejects.toThrow(
      /metadata does not match/,
    );
    await db.query('delete from storage.objects where name=$1', [path]);
    await db.query(
      'insert into storage.objects(bucket_id,name,metadata) values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
      [path],
    );
    await db.query('select public.complete_attachment($1)', [file]);
    await db.query('select public.complete_attachment($1)', [file]);
    expect(
      (
        await db.query<{ status: string }>('select status from public.attachments where id=$1', [
          file,
        ])
      ).rows[0].status,
    ).toBe('ready');
  });
  it('preserves immutable bytes and ready metadata while allowing archive/restore', async () => {
    await asUser(A);
    await expect(
      db.query("update public.attachments set status='ready' where id=$1", [file]),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query('delete from public.attachments where id=$1', [file])).rejects.toThrow(
      /permission denied/,
    );
    expect((await db.query('delete from storage.objects where name=$1', [path])).affectedRows).toBe(
      0,
    );
    await expect(db.query('select public.cancel_attachment_upload($1)', [file])).rejects.toThrow(
      /Completed files/,
    );
    await db.query("select public.set_attachment_status($1,'archived')", [file]);
    expect(
      Number(
        (
          await db.query<{ n: string }>('select count(*) n from storage.objects where name=$1', [
            path,
          ])
        ).rows[0].n,
      ),
    ).toBe(1);
    await db.query("select public.set_attachment_status($1,'ready')", [file]);
  });
  it('rejects other users, forged paths, ready inserts and foreign finance links', async () => {
    await asUser(B);
    expect(await count('attachments')).toBe(0);
    expect(
      Number((await db.query<{ n: string }>('select count(*) n from storage.objects')).rows[0].n),
    ).toBe(0);
    await expect(db.query('select public.complete_attachment($1)', [file])).rejects.toThrow(
      /owner/,
    );
    await expect(
      db.query("select public.set_attachment_status($1,'archived')", [file]),
    ).rejects.toThrow(/owner/);
    await asUser(A);
    await expect(
      insert('attachments', 'workspace_id,name,object_path,mime_type,size_bytes', [
        workspace,
        'Bad.pdf',
        `${A}/${workspace}/bad.pdf`,
        'application/pdf',
        1,
      ]),
    ).rejects.toThrow(/object path/);
    const forged = '66666666-6666-4666-8666-666666666666';
    await expect(
      db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes,status) values($1,$2,'Bad.pdf',$3,'application/pdf',1,'ready')",
        [forged, workspace, `${A}/${workspace}/${forged}.pdf`],
      ),
    ).rejects.toThrow(/server-owned/);
    await expect(
      db.query(
        "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes,bucket_id) values($1,$2,'Bad.txt',$3,'text/plain',1,'financial-receipts')",
        [forged, workspace, `${A}/${workspace}/${forged}.txt`],
      ),
    ).rejects.toThrow(/Unsupported/);
    await expect(
      db.query('select public.update_attachment_details($1,$2,null,null,$3)', [
        file,
        'Other',
        (await db.query<{ id: string }>('select id from public.transactions limit 1')).rows[0].id,
      ]),
    ).rejects.toThrow(/receipt_transaction_link/);
  });
  it('creates consecutive immutable versions and archives the previous version only on completion', async () => {
    await asUser(A);
    next = '77777777-7777-4777-8777-777777777777';
    const nextPath = `${A}/${workspace}/${next}.txt`;
    await db.query(
      "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes,previous_version_id,version_number) values($1,$2,'sample.txt',$3,'text/plain',5,$4,99)",
      [next, workspace, nextPath, file],
    );
    expect(
      (
        await db.query<{ version_number: number }>(
          'select version_number from public.attachments where id=$1',
          [next],
        )
      ).rows[0].version_number,
    ).toBe(2);
    expect(
      (
        await db.query<{ status: string }>('select status from public.attachments where id=$1', [
          file,
        ])
      ).rows[0].status,
    ).toBe('ready');
    await db.query(
      'insert into storage.objects(bucket_id,name,metadata) values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
      [nextPath],
    );
    await db.query('select public.complete_attachment($1)', [next]);
    expect(
      (
        await db.query<{ status: string }>('select status from public.attachments where id=$1', [
          file,
        ])
      ).rows[0].status,
    ).toBe('archived');
    await expect(
      db.query('update public.attachments set previous_version_id=$1 where id=$2', [next, file]),
    ).rejects.toThrow(/permission denied/);
  });
  it('allows cleanup only for cancelled drafts and revokes file access with membership', async () => {
    await asUser(A);
    const draft = '88888888-8888-4888-8888-888888888888';
    const draftPath = `${A}/${workspace}/${draft}.txt`;
    await db.query(
      "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes) values($1,$2,'draft.txt',$3,'text/plain',5)",
      [draft, workspace, draftPath],
    );
    await db.query(
      'insert into storage.objects(bucket_id,name,metadata) values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
      [draftPath],
    );
    await db.query('select public.cancel_attachment_upload($1)', [draft]);
    await expect(
      db.query('select public.remove_cancelled_attachment($1)', [draft]),
    ).rejects.toThrow(/clean up/);
    await db.query('delete from storage.objects where name=$1', [draftPath]);
    await db.query('select public.remove_cancelled_attachment($1)', [draft]);
    expect(
      (await db.query('select id from public.attachments where id=$1', [draft])).rows.length,
    ).toBe(0);
    await db.exec('reset role;set role anon');
    await expect(count('attachments')).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
    await db.query('delete from public.workspace_members where workspace_id=$1 and user_id=$2', [
      workspace,
      A,
    ]);
    await asUser(A);
    expect(await count('attachments')).toBe(0);
    expect(
      Number((await db.query<{ n: string }>('select count(*) n from storage.objects')).rows[0].n),
    ).toBe(0);
    await db.exec('reset role');
    await db.query(
      "insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'owner')",
      [workspace, A],
    );
  });
});

describe('Private budgets, bills and recurring ledger', () => {
  let bill: string;
  let schedule: string;
  it('isolates finance plans from unrelated users, editors and viewers', async () => {
    await asUser(A);
    await insert('budgets', 'workspace_id,category,month,currency,amount', [
      workspace,
      'Food',
      '2026-10-01',
      'INR',
      100,
    ]);
    bill = await insert('bills', 'workspace_id,account_id,title,amount,due_on', [
      workspace,
      source,
      'Electricity',
      12.15,
      '2026-10-15',
    ]);
    schedule = await insert(
      'recurring_transactions',
      'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on,automatic',
      [
        workspace,
        source,
        'Weekly groceries',
        1.25,
        'expense',
        'weekly',
        '2026-01-01',
        '2026-01-01',
        true,
      ],
    );
    await db.query("select public.set_workspace_member($1,$2,'viewer')", [workspace, B]);
    for (const user of [B, C]) {
      await asUser(user);
      for (const table of ['budgets', 'bills', 'recurring_transactions'])
        expect(await count(table)).toBe(0);
      await expect(db.query('select public.settle_bill($1)', [bill])).rejects.toThrow(/owner/);
      await expect(db.query('select public.post_recurring_due($1)', [schedule])).rejects.toThrow(
        /owner/,
      );
    }
    await asUser(C);
    await expect(
      insert('bills', 'workspace_id,account_id,title,amount,due_on', [
        workspace,
        source,
        'Forged link',
        1,
        '2026-10-01',
      ]),
    ).rejects.toThrow(/Account must be owned/);
    await asUser(B);
    await expect(
      insert('budgets', 'workspace_id,category,month,currency,amount', [
        workspace,
        'Attack',
        '2026-10-01',
        'INR',
        1,
      ]),
    ).rejects.toThrow(/row-level security/);
    await db.exec('reset role;set role anon');
    await expect(count('budgets')).rejects.toThrow(/permission denied/);
  });
  it('settles a bill once, atomically, and keeps status and ownership server-controlled', async () => {
    await asUser(A);
    const first = (await db.query<{ id: string }>('select public.settle_bill($1) as id', [bill]))
      .rows[0].id;
    expect(
      (await db.query<{ id: string }>('select public.settle_bill($1) as id', [bill])).rows[0].id,
    ).toBe(first);
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            'select count(*) n from public.transactions where bill_id=$1',
            [bill],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    expect(
      (
        await db.query<{ status: string; transaction_id: string }>(
          'select status,transaction_id from public.bills where id=$1',
          [bill],
        )
      ).rows[0],
    ).toEqual({ status: 'paid', transaction_id: first });
    await expect(
      db.query("update public.bills set status='pending' where id=$1", [bill]),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.cancel_bill($1)', [bill])).rejects.toThrow(/Paid bills/);
    await expect(db.query('update public.budgets set owner_id=$1', [B])).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      insert('bills', 'workspace_id,account_id,title,amount,due_on,status', [
        workspace,
        source,
        'Fake paid',
        1,
        '2026-10-01',
        'paid',
      ]),
    ).rejects.toThrow(/server-owned/);
    const cancelled = await insert('bills', 'workspace_id,account_id,title,amount,due_on', [
      workspace,
      source,
      'Cancelled',
      10,
      '2026-10-01',
    ]);
    await db.query('select public.cancel_bill($1)', [cancelled]);
    await expect(db.query('select public.settle_bill($1)', [cancelled])).rejects.toThrow(
      /Cancelled/,
    );
  });
  it('preserves month-end and leap-year recurrence anchors', async () => {
    await db.exec('reset role');
    const dates = (
      await db.query<{ feb: string; mar: string; year: string }>(
        "select private.recurrence_date('2024-01-31','monthly',1)::text as feb,private.recurrence_date('2024-01-31','monthly',2)::text as mar,private.recurrence_date('2024-02-29','yearly',4)::text as year",
      )
    ).rows[0];
    expect(dates).toEqual({ feb: '2024-02-29', mar: '2024-03-31', year: '2028-02-29' });
  });
  it('posts due occurrences exactly once and protects the scheduler and cursor', async () => {
    await asUser(A);
    await db.query('select public.post_recurring_due($1)', [schedule]);
    const before = Number(
      (
        await db.query<{ n: string }>(
          'select count(*) n from public.transactions where recurring_id=$1',
          [schedule],
        )
      ).rows[0].n,
    );
    expect(before).toBeGreaterThan(0);
    expect(
      (await db.query<{ n: number }>('select public.post_recurring_due($1) as n', [schedule]))
        .rows[0].n,
    ).toBe(0);
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            'select count(*) n from public.transactions where recurring_id=$1',
            [schedule],
          )
        ).rows[0].n,
      ),
    ).toBe(before);
    await expect(
      db.query('update public.recurring_transactions set next_on=current_date where id=$1', [
        schedule,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query('select public.post_due_recurring_transactions()')).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query('select private.post_recurring($1)', [schedule])).rejects.toThrow(
      /permission denied/,
    );
    const future = await insert(
      'recurring_transactions',
      'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on',
      [workspace, source, 'Future', 1, 'income', 'monthly', '2099-01-31', '2099-01-31'],
    );
    expect(
      (await db.query<{ n: number }>('select public.post_recurring_due($1) n', [future])).rows[0].n,
    ).toBe(0);
    await expect(
      insert(
        'recurring_transactions',
        'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on,occurrence_count',
        [workspace, source, 'Forged cursor', 1, 'income', 'monthly', '2026-01-01', '2026-01-01', 2],
      ),
    ).rejects.toThrow(/server-owned/);
  });
  it('automatic posting respects opt-in, pause and membership revocation', async () => {
    await asUser(A);
    const today = (await db.query<{ today: string }>('select current_date::text today')).rows[0]
      .today;
    const automatic = await insert(
      'recurring_transactions',
      'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on,automatic',
      [workspace, source, 'Automatic', 3.45, 'income', 'daily', today, today, true],
    );
    const manual = await insert(
      'recurring_transactions',
      'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on',
      [workspace, source, 'Manual', 3.45, 'income', 'daily', today, today],
    );
    const paused = await insert(
      'recurring_transactions',
      'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on,automatic,active',
      [workspace, source, 'Paused', 3.45, 'income', 'daily', today, today, true, false],
    );
    await db.exec('reset role;set role service_role');
    await db.query('select public.post_due_recurring_transactions()');
    await db.query('select public.post_due_recurring_transactions()');
    await asUser(A);
    for (const [id, expected] of [
      [automatic, 1],
      [manual, 0],
      [paused, 0],
    ])
      expect(
        Number(
          (
            await db.query<{ n: string }>(
              'select count(*) n from public.transactions where recurring_id=$1',
              [id],
            )
          ).rows[0].n,
        ),
      ).toBe(expected);
    await asUser(C);
    const account = await insert('accounts', 'workspace_id,name', [workspace, 'Member account']);
    const revoked = await insert(
      'recurring_transactions',
      'workspace_id,account_id,title,amount,kind,frequency,start_on,next_on,automatic',
      [workspace, account, 'Revoked', 1, 'expense', 'daily', today, today, true],
    );
    await asUser(A);
    await db.query('select public.remove_workspace_member($1,$2)', [workspace, C]);
    await db.exec('reset role;set role service_role');
    await db.query('select public.post_due_recurring_transactions()');
    await db.exec('reset role');
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            'select count(*) n from public.transactions where recurring_id=$1',
            [revoked],
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  });
});

describe('Automated reminder isolation and lifecycle', () => {
  let w: string, account: string, task: string, overdue: string, bill: string, file: string;
  let notice: string;
  const prefs = "select public.save_reminder_preferences($1,$2,$3,10,10,30,0,'UTC')";
  beforeAll(async () => {
    await asUser(A);
    w = (await db.query<{ id: string }>("select public.create_workspace('Reminder tests') as id"))
      .rows[0].id;
    account = await insert('accounts', 'workspace_id,name', [w, 'Reminder account']);
    task = await insert('tasks', 'workspace_id,title,due_date', [
      w,
      'Upcoming private task',
      new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    ]);
    overdue = await insert('tasks', 'workspace_id,title,due_date', [
      w,
      'Overdue task',
      new Date(Date.now() - 86400000).toISOString().slice(0, 10),
    ]);
    bill = await insert('bills', 'workspace_id,title,account_id,amount,due_on', [
      w,
      'Unpaid bill',
      account,
      5,
      new Date().toISOString().slice(0, 10),
    ]);
    file = '99999999-9999-4999-8999-999999999999';
    const path = `${A}/${w}/${file}.txt`;
    await db.query(
      "insert into public.attachments(id,workspace_id,name,object_path,mime_type,size_bytes,expires_on) values($1,$2,'Renewal.txt',$3,'text/plain',5,current_date+5)",
      [file, w, path],
    );
    await db.query(
      'insert into storage.objects(bucket_id,name,metadata) values(\'personal-documents\',$1,\'{"size":5,"mimetype":"text/plain"}\')',
      [path],
    );
    await db.query('select public.complete_attachment($1)', [file]);
  });
  it('starts disabled, constrains preferences, and preserves widget settings', async () => {
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (await db.query('select id from public.notifications where workspace_id=$1', [w])).rows,
    ).toHaveLength(0);
    await asUser(A);
    await expect(
      db.query("select public.save_reminder_preferences(true,true,true,-1,3,30,9,'UTC')"),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query("select public.save_reminder_preferences(true,true,true,1,3,30,9,'Invalid/Zone')"),
    ).rejects.toThrow(/IANA/);
    await db.query(prefs, [true, true, true]);
    expect(
      (
        await db.query<{ dashboard_widgets: string[] }>(
          'select dashboard_widgets from public.app_settings',
        )
      ).rows[0].dashboard_widgets,
    ).toEqual(['goals']);
  });
  it('delivers all three kinds once, including overdue, and restricts scheduler permissions', async () => {
    await asUser(A);
    await expect(db.query('select public.deliver_due_reminders()')).rejects.toThrow(
      /permission denied/,
    );
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    await db.query('select public.deliver_due_reminders()');
    const rows = (
      await db.query<{ id: string; source_kind: string; source_id: string; phase: string }>(
        'select * from public.notifications where workspace_id=$1',
        [w],
      )
    ).rows;
    expect(rows).toHaveLength(4);
    expect(rows.filter((n) => n.source_kind === 'document')).toHaveLength(1);
    expect(rows.find((n) => n.source_id === overdue)?.phase).toBe('overdue');
    notice = rows.find((n) => n.source_id === task)!.id;
    await asUser(A);
    await expect(
      db.query('update public.notifications set snoozed_until=now() where id=$1', [notice]),
    ).rejects.toThrow(/permission denied/);
  });
  it('prevents viewer and unrelated users from reading or acting on an owner’s notifications', async () => {
    await asUser(A);
    await db.query("select public.set_workspace_member($1,$2,'viewer')", [w, B]);
    await asUser(B);
    expect(
      (await db.query('select id from public.notifications where workspace_id=$1', [w])).rows,
    ).toHaveLength(0);
    await expect(
      db.query("select public.act_on_notification($1,'snooze',60)", [notice]),
    ).rejects.toThrow(/inaccessible/);
    await expect(
      db.query('update public.app_settings set task_reminders=true where id=$1', [A]),
    ).rejects.toThrow(/permission denied/);
  });
  it('snoozes the original row, rejects arbitrary durations, and preserves dismissal on retries', async () => {
    await asUser(A);
    await db.query("select public.act_on_notification($1,'read')", [notice]);
    await expect(
      db.query("select public.act_on_notification($1,'snooze',3)", [notice]),
    ).rejects.toThrow(/hour or one day/);
    await db.query("select public.act_on_notification($1,'snooze',60)", [notice]);
    const row = (
      await db.query<{ read_at: string | null; snoozed: boolean }>(
        'select read_at,snoozed_until>now() as snoozed from public.notifications where id=$1',
        [notice],
      )
    ).rows[0];
    expect(row).toEqual({ read_at: null, snoozed: true });
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (await db.query('select id from public.notifications where source_id=$1', [task])).rows,
    ).toHaveLength(1);
    await asUser(A);
    await db.query("select public.act_on_notification($1,'dismiss')", [notice]);
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (
        await db.query(
          'select id from public.notifications where id=$1 and dismissed_at is not null',
          [notice],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('rescheduling cancels the old occurrence and creates only one new occurrence', async () => {
    await asUser(A);
    await db.query('update public.tasks set due_date=due_date+1 where id=$1', [task]);
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (
        await db.query(
          'select id from public.notifications where source_id=$1 and dismissed_at is null',
          [task],
        )
      ).rows,
    ).toHaveLength(1);
    await asUser(A);
    await db.query(
      "select public.set_task_status($1,(select revision from public.tasks where id=$1),'done')",
      [task],
    );
    expect(
      (
        await db.query(
          'select id from public.notifications where source_id=$1 and dismissed_at is null',
          [task],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it('payment and archiving clear snoozed reminders immediately and reject stale snoozes', async () => {
    await asUser(A);
    const docNotice = (
      await db.query<{ id: string }>('select id from public.notifications where source_id=$1', [
        file,
      ])
    ).rows[0].id;
    await db.query("select public.act_on_notification($1,'snooze',1440)", [docNotice]);
    await db.query("select public.set_attachment_status($1,'archived')", [file]);
    await db.query('select public.settle_bill($1)', [bill]);
    expect(
      (
        await db.query(
          'select id from public.notifications where source_id in ($1,$2) and dismissed_at is null',
          [file, bill],
        )
      ).rows,
    ).toHaveLength(0);
    await expect(
      db.query("select public.act_on_notification($1,'snooze',60)", [docNotice]),
    ).rejects.toThrow(/dismissed/);
  });
  it('disabling preferences clears active reminders and cannot affect another account', async () => {
    await asUser(A);
    await db.query(prefs, [false, false, false]);
    expect(
      (
        await db.query(
          'select id from public.notifications where workspace_id=$1 and dismissed_at is null',
          [w],
        )
      ).rows,
    ).toHaveLength(0);
    await asUser(B);
    await db.query(prefs, [true, true, true]);
    await db.exec('reset role');
    expect(
      (
        await db.query<{ task_reminders: boolean }>(
          'select task_reminders from public.app_settings where id=$1',
          [A],
        )
      ).rows[0].task_reminders,
    ).toBe(false);
  });
  it('revokes reads and actions immediately when membership is removed', async () => {
    await asUser(A);
    await db.query('select public.remove_workspace_member($1,$2)', [w, B]);
    await asUser(B);
    await expect(
      db.query("select public.act_on_notification($1,'read')", [notice]),
    ).rejects.toThrow(/inaccessible/);
    await asUser(A);
    // Leave preferences disabled for the other independent permission suites.
  });
  it('honors the configured local hour and calendar date rather than server midnight', async () => {
    await db.exec('reset role');
    const clock = (
      await db.query<{
        zone: string;
        hour: number;
        day: string;
        phase: string;
      }>(`select name as zone,
      extract(hour from now() at time zone name)::integer as hour,
      (now() at time zone name)::date::text as day,
      case when current_date<(now() at time zone name)::date then 'overdue' else 'upcoming' end as phase
      from pg_catalog.pg_timezone_names where name in ('Pacific/Kiritimati','Etc/GMT+12')
      and (now() at time zone name)::date<>current_date and extract(hour from now() at time zone name)<23 limit 1`)
    ).rows[0];
    expect(clock).toBeDefined();
    await asUser(A);
    const clockTask = await insert('tasks', 'workspace_id,title,due_date', [
      w,
      'Calendar boundary',
      new Date().toISOString().slice(0, 10),
    ]);
    await db.query('select public.save_reminder_preferences(true,false,false,1,3,30,$1,$2)', [
      clock.hour + 1,
      clock.zone,
    ]);
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (await db.query('select id from public.notifications where source_id=$1', [clockTask])).rows,
    ).toHaveLength(0);
    await asUser(A);
    await db.query('select public.save_reminder_preferences(true,false,false,1,3,30,0,$1)', [
      clock.zone,
    ]);
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (
        await db.query<{ phase: string }>(
          'select phase from public.notifications where source_id=$1',
          [clockTask],
        )
      ).rows[0].phase,
    ).toBe(clock.phase);
    await asUser(A);
    await db.query(prefs, [false, false, false]);
  });
  it('keeps a member’s reminders private from workspace owners and skips revoked owners', async () => {
    await asUser(A);
    await db.query("select public.set_workspace_member($1,$2,'editor')", [w, C]);
    await asUser(C);
    await db.query(prefs, [true, false, false]);
    const cTask = await insert('tasks', 'workspace_id,title,due_date,visibility', [
      w,
      'Shared member task',
      new Date().toISOString().slice(0, 10),
      'workspace',
    ]);
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    const cNotice = (
      await db.query<{ id: string }>('select id from public.notifications where source_id=$1', [
        cTask,
      ])
    ).rows[0].id;
    await asUser(A);
    expect(
      (await db.query('select id from public.notifications where id=$1', [cNotice])).rows,
    ).toHaveLength(0);
    await expect(
      db.query("select public.act_on_notification($1,'dismiss')", [cNotice]),
    ).rejects.toThrow(/inaccessible/);
    await db.query('select public.remove_workspace_member($1,$2)', [w, C]);
    await asUser(C);
    expect(
      (await db.query('select id from public.notifications where id=$1', [cNotice])).rows,
    ).toHaveLength(0);
    await expect(
      db.query("select public.act_on_notification($1,'read')", [cNotice]),
    ).rejects.toThrow(/inaccessible/);
    await db.exec('reset role');
    await db.query('select public.deliver_due_reminders()');
    expect(
      (
        await db.query(
          'select id from public.notifications where id=$1 and dismissed_at is not null',
          [cNotice],
        )
      ).rows,
    ).toHaveLength(1);
  });
});

subscriptionSecurityTests(() => db, asUser, A, B, C);

loanSecurityTests(() => db, asUser, A, B, C);

reportSecurityTests(() => db, asUser, A, B);

contactSecurityTests(() => db, asUser, A, B);
householdSecurityTests(() => db, asUser, A, B, C);
assetSecurityTests(() => db, asUser, A, B);
careerSecurityTests(() => db, asUser, A, B);
habitSecurityTests(() => db, asUser, A, B);

taskSecurityTests(() => db, asUser, A, B);

taskWorkSecurityTests(() => db, asUser, A, B, C);

projectSecurityTests(() => db, asUser, A, B, C);

healthSecurityTests(() => db, asUser, A, B, C);

healthTrackingSecurityTests(() => db, asUser, A, B, C);

travelSecurityTests(() => db, asUser, A, B, C);

cardSecurityTests(() => db, asUser, A, B, C);

wealthSecurityTests(() => db, asUser, A, B, C);
financeImportSecurityTests(() => db, asUser, A, B, C);
financeJsonSecurityTests(() => db, asUser, A, B, C);
recordJsonSecurityTests(() => db, asUser, A, B, C);
calendarJsonSecurityTests(() => db, asUser, A, B, C);
emailSecurityTests(() => db, asUser);

calendarSecurityTests(() => db, asUser, A, B, C);

notesSecurityTests(() => db, asUser, A, B, C);
learningSecurityTests(() => db, asUser, A, B, C);
learningImportSecurityTests(() => db, asUser, A, B, C);

shoppingSecurityTests(() => db, asUser, A, B, C);

educationSecurityTests(() => db, asUser, A, B, C);

householdBudgetSecurityTests(() => db, asUser, A, B, C);

documentSharingSecurityTests(() => db, asUser, A, B, C);

shoppingImportSecurityTests(() => db, asUser, A, B, C);

assetInsuranceSecurityTests(() => db, asUser, A, B, C);

describe('Full security-fixture database snapshot recovery', () => {
  it('restores every fixture row, permission and schema definition in a separate database', async () => {
    const result = await restoreDatabaseSnapshot(db);
    try {
      expect(result.database.publicTables).toBe(86);
      expect(result.database.rows).toBeGreaterThan(100);
      expect(result.inventory.records.some((r) => r.schema === 'private' && r.rows > 0)).toBe(true);
      expect(result.inventory.records.some((r) => r.schema === 'auth' && r.rows > 0)).toBe(true);
      expect(
        result.inventory.records.some((r) => r.schema === 'supabase_migrations' && r.rows > 0),
      ).toBe(true);
      await result.restored.exec('reset role;set role anon');
      await expect(result.restored.query('select * from public.learning_items')).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        result.restored.query('select * from private.learning_import_sources'),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await result.restored.close();
    }
  }, 60000);
});
