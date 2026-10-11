import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY || '';
if (
  url &&
  !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url) &&
  !/^http:\/\/(localhost|127\.0\.0\.1):54321$/.test(url)
)
  throw new Error('Invalid Supabase project URL');
if (key.startsWith('sb_secret_')) throw new Error('Secret keys must never be used in the frontend');
if (key.startsWith('eyJ')) {
  const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
  if (payload.role !== 'anon')
    throw new Error('Only a publishable or legacy anon key is permitted');
} else if (key && !key.startsWith('sb_publishable_'))
  throw new Error('Expected a Supabase publishable key');
writeFileSync(
  'src/app/core/supabase/config.ts',
  `// Generated from public build configuration. Never put a secret here.\nexport const backendConfig = ${JSON.stringify({ url, key })} as const;\n`,
);
