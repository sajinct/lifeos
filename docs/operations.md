# Setup, deployment, and recovery

## Local development

Run `npm ci`, then `npm start`. Open http://127.0.0.1:4200 and choose **Explore a demo workspace**. Demo data is synthetic and held in memory. Reloading or signing out clears it. Only the theme preference and Supabase's own auth session persist in browser storage.

The project pins a compatible Node 22.22.3 runtime as a development dependency because Angular 22 requires a newer Node release than some existing installations. Scripts use it on Windows and Linux without changing the system runtime. Node 24 is used by CI.

## Connect Supabase

1. Create a Supabase project, then install the official Supabase CLI.
2. Use `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, and `supabase db push` from this directory. Review the migration before applying it to an existing project.
3. Set public build variables. PowerShell:

```powershell
$env:SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co'
$env:SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YOUR_PUBLIC_KEY'
npm start
```

`.env.example` describes variables; it is not automatically loaded. Only a publishable key or legacy anon JWT is permitted by the build script. A secret or service-role key is rejected. Frontend build variables are visible in public assets, even when sourced from GitHub Secrets.

4. Configure Auth's Site URL and redirect allowlist for the exact development/staging/production origins and base paths, including the `?flow=recovery` reset redirect. The code exchanges a PKCE `code` in the URL before entering hash routing. Verification/reset links should be opened in the same browser that initiated them.

The scoped production configuration is tracked separately. After reviewing the diff, apply it to the intended project:

```text
npx supabase config diff --project-ref YOUR_PROJECT_REF --workdir config/production
npx supabase config push --project-ref YOUR_PROJECT_REF --workdir config/production
```

This declares the LifeOS production and local Auth redirect URLs, email signup and confirmation. Undeclared remote settings remain unchanged. Do not push the local development config as production Auth configuration. 5. Enable email confirmation, configure SMTP for production, sign up, verify your email, and sign in. A profile is created by a trigger. Create a workspace in Settings. The schema does not insert demo records into real accounts. 6. Workspace owners can add an existing account by profile UUID in Settings. This intentionally does not send email invitations or expose a searchable profile directory. Viewer access is read-only; private records are invisible to other members, including the workspace owner. Finance accounts and ledger entries remain private.

## Environments and migrations

Use separate Supabase projects for staging and production and separate GitHub environments/variable sets. Apply and test migrations in staging first. Generate future database type definitions with `supabase gen types typescript --linked`; the current typed contract covers the implemented APIs. Add a new versioned migration for schema changes; never rewrite a migration already applied to production. Back up before destructive migrations and test forward and recovery paths on a disposable project.

## GitHub Pages

Create a GitHub repository for this folder, push to `main`, and select **GitHub Actions** as the repository's Pages source. Set repository Actions variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`. The workflow validates formatting, TypeScript/ESLint, application tests, actual PostgreSQL isolation tests and a production build before deploying through the official Pages Actions.

The default base path is `/REPOSITORY_NAME/`. Override with `PAGES_BASE_PATH` for account-level Pages (use `/`). For a custom domain, set `CUSTOM_DOMAIN` to the hostname; the workflow uses `/` and emits `CNAME`. Configure GitHub's domain verification, DNS and HTTPS in Pages settings. Add the resulting origin/base path and reset URL to Supabase Auth. Hash URLs such as `/lifeos/#/tasks` support refresh/direct navigation without a server fallback. Auth callbacks arrive at the index document as `?code=...` and are handled before routing.

This deployment uses `CUSTOM_DOMAIN=lifeos.sajinct.com` and a root base path. Changing the custom domain in GitHub Pages settings alone does not rebuild the frontend: update the Actions variable and run the deployment workflow too. The build verifier requires `/` and a matching `CNAME` when a custom domain is configured. Production Auth redirects include `https://lifeos.sajinct.com/` and `https://lifeos.sajinct.com/?flow=recovery`.

Production command: `npm run build -- --base-href=/`. Output: `dist/lifeos/browser`. Do not upload source files or a Supabase service-role credential to Pages. No application API server is deployed.

## Verification

```text
npm run lint
npm test
npm run test:security
npm run format:check
npm run build
node scripts/verify-build.mjs
```

After linking a cloud project, run `npx supabase db query --linked --file supabase/tests/cloud-smoke.sql` to check the real profile trigger, workspace isolation, viewer restrictions, and transfer atomicity/idempotency. The script rolls back all synthetic identities and records; it does not send emails or create passwords. It was verified against the connected production schema.

Security tests execute the application migration in PGlite's real PostgreSQL engine with platform Auth/Storage schema shims. They exercise RLS, grants, ownership, viewers, links, transfers, idempotent reminders, preservation of unrelated platform function permissions, and Storage policy logic. They do not replace a cloud smoke test: verify real email signup/reset, two-user isolation, signed downloads and the actual Supabase Storage API in staging. The production schema and Auth redirects have been configured; real email verification and password entry are completed by the account owner.

## Private files

The `personal-documents` and `financial-receipts` buckets are private, limited to 10 MiB per object and permitted MIME types. Paths must be `USER_UUID/WORKSPACE_UUID/FILE_UUID.ext`. Only the file owner, while a workspace member, can read. Viewers cannot upload/delete. Updates are intentionally disallowed; file versions use distinct immutable paths. The file-management UI belongs to the Documents milestone and is not yet exposed. Never use public object URLs; generate short-lived signed URLs from an authorized session.

## Reminders

The database contains an idempotent, service-only in-app reminder dispatcher. Run `select public.deliver_due_reminders();` from Supabase Cron every five minutes once reminders are configured. Enable the `pg_cron` extension in Supabase and schedule:

```sql
select cron.schedule('lifeos-reminders', '*/5 * * * *',
  'select public.deliver_due_reminders();');
```

The unique reminder_id prevents duplicate notifications; deliveries to removed members are skipped. Notification history is stored in PostgreSQL. There is no email provider or recurring-finance scheduler in Phase 1. Add an Edge Function only when a server-only integration is actually needed, with a durable outbox, authentication checks, retries and provider idempotency keys. Secrets belong in Supabase server-side configuration.

## Export, backup and restore

The UI exports the complete visible ledger to CSV and loaded workspace records to JSON. CSV cells are escaped and formula prefixes are neutralized. Productivity screens load at most 500 records each; activity and notifications have smaller limits. These user exports are convenient snapshots, not full infrastructure backups. Financial ledger pagination fetches all visible entries for accurate balances; large-ledger server aggregation is a future performance milestone. Monetary writes validate two decimal places and PostgreSQL uses NUMERIC(14,2). UI calculations use integer cents; displayed summary cards round to whole currency units while transaction tables preserve cents.

1. **Database:** periodically use `supabase db dump --linked` for schema and data according to the official CLI backup procedure. Store encrypted snapshots outside Supabase and GitHub. Include roles, migrations, auth identities and workspace memberships in the recovery plan; Supabase-managed Auth objects require the provider's documented migration procedure rather than a blind application-only dump.
2. **Storage separately:** enumerate every private bucket, download all objects with privileged tooling, and save a manifest of bucket/path, content type, size and checksum. Back up bucket settings/policies as well. Database backups do **not** include object contents. Keep service credentials out of logs and source control.
3. **Restore database:** create a clean staging project, restore the schema/migrations and Auth identities with the provider-supported procedure, restore application rows preserving original UUIDs and foreign keys. Review changed project URLs and key rotation. Validate row counts, ownership and RLS tests before switching the frontend.
4. **Restore files:** recreate private buckets, upload each manifest entry under its original path, verify checksums, then reconcile attachment metadata. Test an authorized signed download and rejection from another account.
5. Run a periodic restore drill using a separate project. Never test a restore by overwriting production. Record backup time and checksums; keep multiple generations and monitor failed jobs.

Check current Supabase plan limits in the project dashboard. A free project can pause after inactivity; handle paused-project errors by restoring service in the Supabase dashboard. Monitor database/Storage sizes, egress and usage. Avoid unnecessary Realtime subscriptions and scheduled calls. PWA caching includes static build assets only, never API responses, exports or private uploads.

References: [Angular release/version guidance](https://angular.dev/reference/releases), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [database function security](https://supabase.com/docs/guides/database/functions), [backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), [GitHub Pages deployment](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
