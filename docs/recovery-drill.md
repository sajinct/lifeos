# Recovery validation

## Run the isolated local drill

```text
npm ci
npm run test:recovery
```

The command creates only synthetic local data. It does not accept a connection string, project reference, credentials or restore target, and never contacts Supabase. It restores into a new PGlite engine rather than overwriting its source. The compatible Node runtime installed by this repository is used automatically.

Every run writes a new directory under `.recovery-drill/`:

| Artifact                 | Purpose                                                              |
| ------------------------ | -------------------------------------------------------------------- |
| `database.pglite.tar.gz` | Synthetic database physical snapshot                                 |
| `storage/`               | Separate original-path synthetic file bytes                          |
| `storage-manifest.json`  | Bucket/path, attachment ID, MIME, byte size and SHA-256              |
| `inventory.json`         | Table row counts/content hashes and security-catalog fingerprint     |
| `report.json`            | Runtime versions, migration hashes, results, timings and limitations |

The command reloads the saved database archive from disk, verifies its checksum, opens it in a separate engine, and compares every restored row count/content hash. It also compares roles, schema/table/column grants, RLS policies, constraints, functions, triggers, indexes and sequences. Files are read back from their separate bundle and reconciled against restored attachment and Storage metadata. The fixtures include two immutable document versions and a PNG receipt in private buckets.

Functional checks after restore exercise ledger balances and transfer retries, private records in shared workspaces, archived journals/file versions, learning/certificate links, shared shopping check history, private education payment corrections and exact retries, import source bindings, saved note request receipts, stale revisions, viewers, removed members, outsiders and anonymous access. Missing bytes, checksum/size corruption, duplicate/unlisted entries and unsafe paths fail closed. Checks happen before publishing a successful report; failed runs exit nonzero and cannot produce a passed report.

`npm run test:security` additionally snapshots and restores the full database produced by all domain security fixtures. This covers more domain rows than the standalone representative drill, compares every table/security definition, and rechecks anonymous access. This database remains a test fixture and contains no production data.

The Pages workflow runs both checks. Drill artifacts stay outside the static build and are ignored by Git; no archive or private payload is uploaded as a Pages artifact. Keep the JSON report as evidence of a completed run. Local timings describe a small synthetic dataset, not a production recovery-time objective.

## What this proves

Application data, relationship identities, migration history, grant/RLS definitions and retry metadata can survive a physical snapshot restore in the same PGlite runtime. A separate file bundle can be reconciled by original path, MIME, size and checksum. The behavior tests verify important privacy and accounting boundaries after recovery, rather than relying solely on row counts.

PGlite archives are designed for PGlite, not for PostgreSQL/Supabase logical restore. Preserve the lockfile and recorded runtime versions for these synthetic artifacts. See the [PGlite snapshot API](https://pglite.dev/docs/api).

The Auth and Storage schemas are platform shims. The drill does not verify password hashes, hosted sign-in, sessions, signed URLs, actual Storage API transfers, Vault keys, Cron, Edge deployments/secrets, SMTP, Realtime or DNS. A passing local report is not a production backup or a successful cloud recovery.

## Prepare a hosted recovery drill

Use a distinct disposable staging project and the current [Supabase CLI backup/restore procedure](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore). Database snapshots do not contain uploaded object bytes; see [Supabase database backup coverage](https://supabase.com/docs/guides/platform/backups). Do not restore into production.

Before execution, record the original and target project references, exact backup timestamp, database/Postgres versions, archive checksums, migration history and separate Storage manifest. Keep database archives and file backups encrypted outside GitHub and the public frontend. Secrets stay in trusted administration tooling, not chat, source files or command output.

The hosted plan must cover these independent surfaces:

1. **Database and identities:** restore provider-supported roles/schema/data and Auth identities with original UUIDs. Include the private application schema and migration history; app-only JSON imports cannot recover these. Recreate custom Auth triggers and Storage policies from the reviewed migrations without replaying all application migrations over an already restored schema. Check table counts/hashes, foreign keys, revisions, request receipts and immutable source tombstones.
2. **Encrypted settings and secrets:** follow the provider's current Vault/encryption-root-key procedure for manual logical restores. Plan Edge secrets and SMTP separately. Keep staging email/automatic posting disabled until reviewed, use isolated sender credentials, and do not reuse production scheduler secrets or production endpoints.
3. **Private files:** restore every ready/archived version from the separate byte backup under its original bucket/path. Preserve bucket privacy, MIME and size limits; verify every checksum and reconcile missing or orphan objects. Check authenticated downloads and denial for another member and unsigned public requests.
4. **Hosted Auth:** use disposable users to verify signup, verification, password reset, session restoration and two-user/workspace isolation with the staging redirect allowlist. Keep production redirects and frontend configuration unchanged.
5. **Background work:** review Cron, Edge, Vault and webhook destinations before enabling them; queued email payloads can contain real recipients after restoring a production database. Verify no real mail is sent during the drill. Realtime/publications and scheduled jobs need their own configuration checks.
6. **Application cutover:** point an isolated staging frontend at the restored project. Run the application/security checks, ledger/request replays and file lifecycle smoke tests. Record failures, remediation, elapsed restore time and the achieved data-loss window. Only a reviewed cutover should change the production connection values or DNS.

No hosted recovery was performed by the local command. That stage requires a separate project and server-side access supplied through the normal secure administration workflow.
