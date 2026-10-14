# LifeOS

A calm personal ERP built with **Angular 22, strict TypeScript, Signals, Tailwind CSS, and Supabase**. GitHub Pages hosts the frontend; Supabase is the only backend. No separate API server.

## Start here

```text
npm ci
npm start
```

Open http://127.0.0.1:4200 and choose **Explore a demo workspace**. Sample records and edits live in memory for the current session. No cloud account is needed to try the interface.

## Implemented

- Responsive overview, collapsible navigation, light/dark themes, command search and accessible quick-capture dialogs.
- Supabase email/password signup/signin, verification, PKCE password reset, restored sessions and secure logout.
- Profiles, workspace creation/switching, owner-managed membership and custom dashboard widgets.
- A first working slice of tasks (list/Kanban), calendar, projects, notes, goals and finance (accounts, income/expenses, atomic transfers).
- Monthly category budgets, bills with retry-safe payment recording, and daily/weekly/monthly/yearly recurring transactions with opt-in automatic posting and pause/resume.
- Private document/receipt uploads, category and expiry filters, authenticated downloads, immutable versions, reversible archives and links to projects/finance entries.
- Opt-in task, bill and document-expiry reminders with personal lead times/time zones, five-minute in-app delivery, snooze/dismiss and direct source links.
- Private subscriptions and free trials, monthly/yearly cost estimates by currency, renewal alerts, optional recurring expense links and cancellation that stops future recording.
- Private manual investments, chronological contributions/withdrawals/valuations, cost-basis and gain/loss history, linked cash movements as transfers, owner-only net worth by currency, asset estimates, inclusion controls and immutable snapshots.
- Private credit cards with billing-day suggestions, bank-confirmed statement snapshots, carried-balance replacement, partial payments as paired transfers, reversible payment corrections, bill opt-in reminders and CSV/JSON history.
- Private loans borrowed/lent, fixed simple-interest schedules, partial/early repayments, owner-only reminders and atomic principal/interest entries in Finance.
- Private contacts for people/organizations, details and notes, owner-only project/loan links, opt-in follow-up reminders, reversible archives, search and filtered CSV export.
- Family & household members, birthdays, responsibilities and important dates with explicit private/workspace sharing, opt-in personal reminders, archive/restore and filtered CSV export.
- Private assets with purchase/warranty details, owned document/receipt links, maintenance schedules, immutable service history, personal alerts and CSV exports.
- Private Career employment/skills, job applications and certifications, owned document links, follow-up/interview/expiry reminders, archives and CSV exports.
- Goals & Habits with monthly/annual/long-term targets, private milestones, scheduled weekday habits, routine groups, daily check-ins/undo, pause/archive history, streaks and consistency statistics.
- Task lists with rename/archive, parent-scoped subtask checklists with edit/undo/removal, anchored recurring tasks with pause/resume, full task pagination and CSV/JSON exports.
- Shared-task assignments to existing workspace members, personal timers/manual time, private task/project summaries, reversible discarded sessions and filtered time CSV.
- Projects with deadlines, parent-visible milestones, private per-currency budgets compared with linked expenses, visible task progress, personal recorded time and filtered CSV reports.
- Private health appointments with provider/location/date/time/notes, owned document-version links, completion/cancellation, archive/restore, personal day reminders and filtered CSV exports.
- Private fitness logs, measurement history grouped by name/unit, medication schedules with weekday/time/zone reminders and pause/archive controls, and medical expense links that preserve the Finance ledger.
- Private trips and personal events with itineraries, booking references/amounts, per-currency budgets, linked Finance expenses, checklists, guest RSVP/party sizes, archive/restore and CSV exports.
- Finance CSV imports with browser-side previews, account/currency validation, duplicate and bank-reference checks, row selection and atomic retry-safe batches.
- Additive Finance JSON imports with explicit new/existing account mapping, supported-row previews, immutable source bindings and atomic retry-safe batches.
- Tasks and Notes JSON imports with private standalone task records, literal note content, explicit accessible-project mappings, source-ID conflicts and safe atomic retries.
- Opt-in reminder emails, daily/weekly planning digests and weekly/monthly financial summaries through a private Resend outbox, verified account recipients, bounded retries and delivery history.
- Notes editing with revision-safe saves, private dated journals, bounded tags/content search, reversible archives and owner-private document-version links/uploads that do not inherit note sharing.
- Private Courses & Learning for courses, books and resources, goals/deadlines, up to 200 lessons or chapters, automatic completion/reopening, pause/archive history, owned note links, certificate/document versions and filtered CSV/workspace JSON exports.
- Additive Learning JSON imports with preview/selection, preserved lesson and completion/archive history, fresh private destination IDs, immutable source bindings and atomic safe retries.
- Owner-private Progress reports with current task/project/goal/learning snapshots, date-filtered recorded time, monthly figures, learning completion dates and filtered CSV.
- Calendar daily/weekly/monthly/yearly repeat schedules with timezone-aware previews, 2–120 materialized occurrences, single/future editing, preserved exceptions, pause/resume/cancellation and private-by-default sharing.
- Calendar JSON imports with explicit timezone validation, UTC previews, private events, accessible-project mapping, duplicate/conflict checks and safe atomic retries.
- Grocery and shopping lists with private defaults, explicit workspace sharing, collaborative item editing/checking, decimal quantities/categories, archived history, revision-safe retries and filtered CSV/JSON metadata exports.
- Private-by-default records, 76 RLS-protected application tables, private Storage policies, typed client access and server-only reminder dispatch.
- Date-filtered Finance reports with separate currency totals, monthly cash flow, category trends, budget comparisons, recorded subscription expenses and loan interest, plus filtered CSV and workspace JSON exports.
- Currency-aware summaries, linked project records and idempotent transfer requests.
- Installable PWA manifest/service worker that caches static assets only; offline indication.
- GitHub Actions checks and Pages deployment supporting repository paths and custom domains.
- Isolated local recovery drills that restore database snapshots, compare all row/security hashes, reconcile a separate synthetic file bundle and recheck privacy, ledger balances, revisions and saved request identities.

The foundation is complete, and all fifteen original module areas now have working features across Phases 2–4. The full ERP scope still has pending features: deeper Finance, Family, Calendar, Notes and Learning functionality, broader reports, JSON imports for other modules and AI. The app does not expose empty routes for unimplemented features.

## Connect and deploy

The production app uses Supabase for real accounts and private records. Public connection values are configured as GitHub Actions repository variables. Create an account, verify your email, and create a workspace to start saving records. The optional demo remains available with session-only sample data.

Production: [lifeos.sajinct.com](https://lifeos.sajinct.com/).

Follow [operations and deployment](docs/operations.md) for configuration, migrations, and recovery. Production Auth settings are tracked in `config/production/supabase/config.toml`; local development configuration remains in `supabase/config.toml`.

Never include a secret/service-role key in a frontend build. Environment values become public browser assets. `.env.example` documents the two public variables; it is not automatically loaded.

## Checks

```text
npm run lint
npm test
npm run test:security
npm run test:recovery
npm run format:check
npm run build
node scripts/verify-build.mjs
```

Database tests execute the actual migration in PostgreSQL through PGlite with Supabase platform shims. Cloud Auth and real Storage endpoints still require staging smoke tests. The project includes a compatible local Node runtime so Angular 22 works without replacing your system Node.

See [architecture and milestones](docs/architecture.md), [schema migration](supabase/migrations/202610110001_foundation.sql), [backup/restore procedures](docs/operations.md), and the [local recovery drill and cloud validation checklist](docs/recovery-drill.md). The local drill uses only synthetic records and PGlite platform shims; a real Supabase cloud recovery remains a separate staging exercise.
