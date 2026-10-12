# LifeOS architecture and milestones

## Delivery boundary

Phase 1 provides a deployable Angular shell, real Supabase authentication, profile editing, workspace creation and switching, access control, private Storage, and a dashboard. A small end-to-end slice of Phase 2 (tasks, projects, calendar, notes, goals and expense capture) makes dashboard actions useful. Remaining ERP domains are roadmap work, not empty routes.

## Conventions

Angular 22 standalone components, strict TypeScript, signal state, lazy routes, reactive forms and Tailwind. Components render state and delegate mutations to typed repositories. No application API server. Browser configuration contains only the Supabase URL and publishable key. Hash routing supports GitHub Pages. The PWA caches build assets only; no API responses or user uploads.

## Ownership and schema

Every domain record has a UUID, workspace_id, owner_id, visibility, timestamps and foreign keys. Visibility defaults to private. A private record is readable/editable by its owner, provided that user remains a workspace member; a shared record is readable by members and editable by its owner or workspace owner. Viewers cannot create or edit. The workspace owner alone manages membership through an authorization-checking RPC. Direct ownership, workspace and role mutations are disallowed by column grants and RLS. Profiles and preferences are personal. Member identity is available through memberships; other users' profiles remain private.

Projects connect tasks, events, notes and transactions through composite foreign keys including workspace_id. A database trigger additionally verifies that a creator can access linked projects. Finance uses NUMERIC(14,2); account transfers use a single authorized PostgreSQL RPC and deterministic row locking. Account balances derive from immutable ledger entries, never client-side running totals.

Foundation: profiles, workspaces, workspace_members, categories, tags, entity_tags, attachments, reminders, notifications, activity_logs, app_settings. Working slice: projects, tasks, calendar_events, notes, goals, accounts, transactions. Additional domains will get normalized schemas with their own reviewed migrations at implementation time.

Finance planning adds private budgets, bills and recurring_transactions. Budgets match category, calendar month and account currency against the complete visible expense ledger. Bill posting locks the bill, inserts one linked expense and stores its transaction ID in the same transaction. Recurrence posting locks each schedule and uniquely identifies occurrences by schedule/date. Dates are calculated from the original anchor so January 31 returns to March 31 after February. Only the record owner with write access may post or pause; service-only automatic dispatch also checks the owner's current membership. Browser clients cannot change payment state, occurrence counters or posting dates. Plans default to manual posting, with explicit opt-in automatic hourly dispatch through Supabase Cron.

## Shared UI

The private file library reserves attachment metadata before uploading immutable bytes to Storage. Completion checks actual object size/type and promotes the reservation through an owner-authorized RPC. A new version links to its predecessor and archives it only after successful upload. Archives preserve bytes and can be restored; only unfinished/cancelled uploads can be cleaned up. Receipts may link to an immutable ledger entry owned by the uploader in the same workspace. Downloads use the authenticated Storage API, rechecking current membership rather than exposing a reusable signed/public URL. Responses bypass the browser HTTP cache. Downloaded bytes and temporary download URLs stay out of shared record signals, exports and PWA caches; file selections are transient form state. Demo blobs are memory-only and cleared with the session.

Responsive navigation, icons, toast feedback, accessible quick-add dialog, command/search dialog, theme switch, offline status, validation states and reusable record views. Dashboard widgets can be hidden in Settings. Demo records are synthetic and live only in memory; real records are never written to browser application caches.

## Milestones

1. Foundation and reviewed RLS migrations; runnable shell and dashboard.
2. Auth, profile, workspace onboarding, settings and backend repositories.
3. Working task/project/calendar/note/goal/expense slice; useful dashboard interactions.
4. Production/PWA builds, meaningful unit tests and database isolation tests, CI deployment and operating documentation.
5. Finance planning: private category budgets, bills and anchored recurring income/expenses, tested for isolation and retry-safe ledger posting; opt-in hourly automation through Supabase Cron.
6. Private files: document and receipt uploads, category/expiry filters, authenticated downloads, versions, archives, project/ledger links and interrupted-upload recovery. Database and live Storage API isolation tests cover the lifecycle.
7. Personal, opt-in in-app reminders for task dates, pending bills and document expiry. A service-only five-minute dispatcher uses each user's IANA time zone, lead times and local delivery hour. Unique source/date/phase keys and a scheduler lock prevent duplicates. Notifications stay private to the record owner, support read/dismiss/snooze, and link to their source. Completion, payment, archival and date edits clear stale occurrences; removed members cannot read or act on reminders. Browser polling loads the newest 100 active/snoozed notices for the current workspace, with session guards against stale responses. Demo reminders follow the same calendar rules in memory. Live cloud SQL checks are fully rolled back.
8. Subsequent work: loans and richer finance reporting, family, assets, subscriptions and contacts; then career, health, travel and imports. Email delivery and optional MFA UI follow their own security and integration tests. AI and external integrations come last.

## Deployment and operations

GitHub Pages is the requested production host. Sites hosting is not used. CI checks formatting, lint, unit tests and Supabase database tests before deploying an artifact. Local Supabase runs the same migrations and tests as production. Cloud resources and GitHub repository provisioning require the user's account configuration. PostgreSQL backups and private Storage object backups are separate, independently restorable operations.
