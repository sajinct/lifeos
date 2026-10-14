// This command can only create synthetic local databases; it has no cloud target option.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runLocalRecoveryDrill } from './lib/recovery.mjs';
if (process.argv.length > 2)
  throw new Error('The local drill accepts no connection URLs or target arguments.');
const output = resolve(
  '.recovery-drill',
  new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8),
);
try {
  const report = await runLocalRecoveryDrill({ output });
  console.log(
    JSON.stringify(
      {
        status: report.status,
        scope: report.scope,
        tables: report.database.tables,
        publicTables: report.database.publicTables,
        rows: report.database.rows,
        migrations: report.migrations.length,
        files: report.files.count,
        checks: report.checks.length,
        report: resolve(output, 'report.json'),
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error('Local recovery drill failed:', e instanceof Error ? e.message : 'Unknown failure');
  process.exitCode = 1;
}
