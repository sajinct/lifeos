// Local PostgreSQL test fixture only. No connection URLs, secrets or network clients.
import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
export const platformShim = `create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;grant usage on schema auth to authenticated,anon,service_role;
 create table auth.users(id uuid primary key,raw_user_meta_data jsonb default '{}',email text,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant execute on function auth.uid() to public;
 create schema storage;grant usage on schema storage to authenticated,anon;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text,name text,metadata jsonb default '{}',unique(bucket_id,name));
 alter table storage.objects enable row level security;grant select,insert,delete on storage.objects to authenticated;
 create function storage.foldername(text) returns text[] language sql immutable as $$ select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
 grant execute on function storage.foldername(text) to public;
 create function public.platform_probe() returns integer language sql as $$ select 1 $$;
 create schema supabase_migrations;
 create table supabase_migrations.schema_migrations(version text primary key,name text not null);`;
export async function createTestDatabase() {
  const db = new PGlite(),
    migrations = [];
  try {
    await db.exec(platformShim);
    const directory = resolve('supabase/migrations');
    for (const name of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      await db.exec(sql);
      const version = name.split('_')[0];
      await db.query('insert into supabase_migrations.schema_migrations values($1,$2)', [
        version,
        name,
      ]);
      migrations.push({ name, sha256: createHash('sha256').update(sql).digest('hex') });
    }
    return { db, migrations };
  } catch (e) {
    await db.close();
    throw e;
  }
}
