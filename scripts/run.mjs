import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const [tool, ...args] = process.argv.slice(2);
const entry =
  tool === 'ng'
    ? 'node_modules/@angular/cli/bin/ng.js'
    : tool === 'recovery'
      ? 'scripts/recovery-drill.mjs'
      : 'node_modules/vitest/vitest.mjs';
const runtime = resolve(`node_modules/node/bin/node${process.platform === 'win32' ? '.exe' : ''}`);
const result = spawnSync(runtime, [resolve(entry), ...args], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
