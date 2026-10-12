// Server-only integration test. Credentials are process environment values, never browser assets.
// Creates disposable confirmed identities without sending mail, tests real Storage, then cleans up.
import { randomUUID, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createClient } from '@supabase/supabase-js';
const url = process.env.LIFEOS_SMOKE_URL;
const publicKey = process.env.LIFEOS_SMOKE_PUBLIC_KEY;
const serviceKey = process.env.LIFEOS_SMOKE_SERVICE_KEY;
if (url && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url))
  throw new Error('Expected an official Supabase cloud project URL.');
if (!url || !publicKey || !serviceKey)
  throw new Error('Supply the three LIFEOS_SMOKE_* values only in a server-side process.');
const options = {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
};
const admin = createClient(url, serviceKey, options);
const clients = [];
const users = [];
const objects = [];
let workspace;
const checks = [];
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function result(response, message) {
  if (response.error) throw new Error(`${message}: ${response.error.message}`);
  return response.data;
}
async function createTestUser(label) {
  const email = `lifeos-storage-${randomUUID()}-${label}@example.invalid`;
  const password = randomBytes(32).toString('base64url');
  const { user } = result(
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: 'LifeOS disposable Storage test' },
    }),
    'Create disposable identity',
  );
  users.push(user.id);
  const client = createClient(url, publicKey, options);
  clients.push(client);
  result(await client.auth.signInWithPassword({ email, password }), 'Sign in disposable identity');
  return { client, id: user.id };
}
async function reserve(owner, bucket, body, mime, name, extra = {}) {
  const id = randomUUID();
  const extension = mime === 'image/png' ? 'png' : 'txt';
  const path = `${owner.id}/${workspace}/${id}.${extension}`;
  const row = {
    id,
    workspace_id: workspace,
    owner_id: owner.id,
    visibility: 'private',
    bucket_id: bucket,
    name,
    object_path: path,
    mime_type: mime,
    size_bytes: body.length,
    category: 'Smoke test',
    ...extra,
  };
  result(await owner.client.from('attachments').insert(row), 'Reserve private file');
  objects.push({ bucket, path });
  return row;
}
async function upload(owner, row, body) {
  result(
    await owner.client.storage.from(row.bucket_id).upload(row.object_path, body, {
      contentType: row.mime_type,
      upsert: false,
      cacheControl: '0',
    }),
    'Upload private bytes',
  );
  result(
    await owner.client.rpc('complete_attachment', { upload: row.id }),
    'Complete private upload',
  );
}
try {
  const owner = await createTestUser('owner');
  const viewer = await createTestUser('viewer');
  workspace = result(
    await owner.client.rpc('create_workspace', {
      workspace_name: 'Disposable Storage smoke test',
      workspace_type: 'personal',
    }),
    'Create disposable workspace',
  );
  result(
    await owner.client.rpc('set_workspace_member', {
      w: workspace,
      member_id: viewer.id,
      member_access: 'viewer',
    }),
    'Add test viewer',
  );
  const body = Buffer.from('LifeOS Storage smoke test: synthetic, disposable data.\n');
  const first = await reserve(owner, 'personal-documents', body, 'text/plain', 'smoke.txt');
  assert(
    (await owner.client.rpc('complete_attachment', { upload: first.id })).error,
    'Unstored upload was incorrectly marked ready',
  );
  const forged = await viewer.client.storage
    .from(first.bucket_id)
    .upload(first.object_path, body, { contentType: 'text/plain', upsert: false });
  assert(forged.error, 'Viewer wrote into the owner file reservation');
  await upload(owner, first, body);
  const duplicate = await owner.client.storage
    .from(first.bucket_id)
    .upload(first.object_path, body, { contentType: 'text/plain', upsert: false });
  assert(duplicate.error, 'Duplicate request overwrote a completed upload');
  result(
    await owner.client.rpc('complete_attachment', { upload: first.id }),
    'Recover already-completed upload',
  );
  assert(
    (
      await owner.client.storage
        .from(first.bucket_id)
        .upload(first.object_path, Buffer.from('Attempted overwrite'), {
          contentType: 'text/plain',
          upsert: true,
        })
    ).error,
    'Ready file was overwritten',
  );
  result(
    await owner.client.storage.from(first.bucket_id).remove([first.object_path]),
    'Attempt ready-file removal',
  );
  const downloaded = result(
    await owner.client.storage.from(first.bucket_id).download(first.object_path),
    'Download owned file',
  );
  assert((await downloaded.text()) === body.toString(), 'Downloaded bytes differ');
  const foreign = result(
    await viewer.client.from('attachments').select('id').eq('workspace_id', workspace),
    'Read viewer metadata',
  );
  assert(foreign.length === 0, 'Private file metadata leaked to viewer');
  assert(
    (await viewer.client.storage.from(first.bucket_id).download(first.object_path)).error,
    'Viewer downloaded private bytes',
  );
  assert(
    (await viewer.client.storage.from(first.bucket_id).createSignedUrl(first.object_path, 60))
      .error,
    'Viewer minted a signed download URL',
  );
  assert(
    !(await fetch(`${url}/storage/v1/object/public/${first.bucket_id}/${first.object_path}`)).ok,
    'Unsigned public download succeeded',
  );
  checks.push('Owned uploads/downloads succeed; viewer and public access denied');
  const secondBody = Buffer.from('LifeOS Storage smoke test: second immutable version.\n');
  const second = await reserve(owner, 'personal-documents', secondBody, 'text/plain', 'smoke.txt', {
    previous_version_id: first.id,
  });
  await upload(owner, second, secondBody);
  const versions = result(
    await owner.client
      .from('attachments')
      .select('id,status,version_number')
      .eq('workspace_id', workspace),
    'Read versions',
  );
  assert(
    versions.find((a) => a.id === first.id)?.status === 'archived' &&
      versions.find((a) => a.id === second.id)?.version_number === 2,
    'Version promotion failed',
  );
  assert(
    (await result(
      await owner.client.storage.from(first.bucket_id).download(first.object_path),
      'Read old version',
    ).text()) === body.toString(),
    'Old version changed',
  );
  result(
    await owner.client.rpc('set_attachment_status', { upload: second.id, target: 'archived' }),
    'Archive current version',
  );
  result(
    await owner.client.rpc('set_attachment_status', { upload: second.id, target: 'ready' }),
    'Restore current version',
  );
  checks.push('Archive/restore and immutable version history succeed');
  const account = result(
    await owner.client
      .from('accounts')
      .insert({ workspace_id: workspace, name: 'Smoke account' })
      .select('id')
      .single(),
    'Create disposable account',
  );
  const entry = result(
    await owner.client.rpc('record_transaction', {
      w: workspace,
      account: account.id,
      transaction_title: 'Smoke expense',
      transaction_amount: 0.15,
      transaction_kind: 'expense',
      transaction_category: 'Other',
      transaction_date: new Date().toISOString().slice(0, 10),
    }),
    'Create disposable ledger entry',
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kD60AAAAASUVORK5CYII=',
    'base64',
  );
  const receipt = await reserve(owner, 'financial-receipts', png, 'image/png', 'smoke.png', {
    transaction_id: entry,
  });
  await upload(owner, receipt, png);
  assert(
    result(
      await owner.client.storage.from(receipt.bucket_id).download(receipt.object_path),
      'Download linked receipt',
    ).size === png.length,
    'Receipt bytes differ',
  );
  checks.push('Private financial receipt upload and transaction link succeed');
  const cancelled = await reserve(owner, 'personal-documents', body, 'text/plain', 'cancelled.txt');
  result(
    await owner.client.storage
      .from(cancelled.bucket_id)
      .upload(cancelled.object_path, body, { contentType: 'text/plain', upsert: false }),
    'Upload unfinished object',
  );
  result(
    await owner.client.rpc('cancel_attachment_upload', { upload: cancelled.id }),
    'Cancel unfinished upload',
  );
  result(
    await owner.client.storage.from(cancelled.bucket_id).remove([cancelled.object_path]),
    'Clean unfinished object',
  );
  result(
    await owner.client.rpc('remove_cancelled_attachment', { upload: cancelled.id }),
    'Remove cancelled reservation',
  );
  checks.push('Interrupted-upload cleanup succeeds through actual Storage API');
  // Removing the creator's membership through the administrative client tests an existing session.
  result(
    await admin
      .from('workspace_members')
      .delete()
      .eq('workspace_id', workspace)
      .eq('user_id', owner.id),
    'Revoke test membership',
  );
  assert(
    (await owner.client.storage.from(first.bucket_id).download(first.object_path)).error,
    'Removed member still downloaded bytes',
  );
  checks.push('Current-session downloads are denied after membership revocation');
  console.log(JSON.stringify({ checksPassed: checks.length, checks }));
} finally {
  const errors = [];
  for (const bucket of ['personal-documents', 'financial-receipts']) {
    const paths = objects.filter((o) => o.bucket === bucket).map((o) => o.path);
    if (paths.length && (await admin.storage.from(bucket).remove(paths)).error)
      errors.push('test Storage objects');
  }
  if (workspace) {
    if ((await admin.from('attachments').delete().eq('workspace_id', workspace)).error)
      errors.push('test attachment metadata');
    if ((await admin.from('workspaces').delete().eq('id', workspace)).error)
      errors.push('test workspace');
  }
  for (const id of users)
    if ((await admin.auth.admin.deleteUser(id)).error) errors.push(`test identity ${id}`);
  for (const client of clients) await client.auth.signOut();
  if (errors.length) {
    console.error(`Review test cleanup for workspace ${workspace}: ${errors.join(', ')}`);
    process.exitCode = 1;
  } else
    console.log('Disposable Storage objects, identities, metadata and ledger records cleaned up.');
}
