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
- Private loans borrowed/lent, fixed simple-interest schedules, partial/early repayments, owner-only reminders and atomic principal/interest entries in Finance.
- Private contacts for people/organizations, details and notes, owner-only project/loan links, opt-in follow-up reminders, reversible archives, search and filtered CSV export.
- Family & household members, birthdays, responsibilities and important dates with explicit private/workspace sharing, opt-in personal reminders, archive/restore and filtered CSV export.
- Private assets with purchase/warranty details, owned document/receipt links, maintenance schedules, immutable service history, personal alerts and CSV exports.
- Private Career employment/skills, job applications and certifications, owned document links, follow-up/interview/expiry reminders, archives and CSV exports.
- Goals & Habits with monthly/annual/long-term targets, private milestones, scheduled weekday habits, routine groups, daily check-ins/undo, pause/archive history, streaks and consistency statistics.
- Task lists with rename/archive, parent-scoped subtask checklists with edit/undo/removal, anchored recurring tasks with pause/resume, full task pagination and CSV/JSON exports.
- Shared-task assignments to existing workspace members, personal timers/manual time, private task/project summaries, reversible discarded sessions and filtered time CSV.
- Private-by-default records, 42 RLS-protected application tables, private Storage policies, typed client access and server-only reminder dispatch.
- Date-filtered Finance reports with separate currency totals, monthly cash flow, category trends, budget comparisons, recorded subscription expenses and loan interest, plus filtered CSV and workspace JSON exports.
- Currency-aware summaries, linked project records and idempotent transfer requests.
- Installable PWA manifest/service worker that caches static assets only; offline indication.
- GitHub Actions checks and Pages deployment supporting repository paths and custom domains.

The foundation is complete, with working modules across Phases 2–4. The full fifteen-module ERP still has pending features: health, travel, deeper functionality in existing modules, email automation, imports and AI. The app does not expose empty routes for those modules.

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
npm run format:check
npm run build
node scripts/verify-build.mjs
```

Database tests execute the actual migration in PostgreSQL through PGlite with Supabase platform shims. Cloud Auth and real Storage endpoints still require staging smoke tests. The project includes a compatible local Node runtime so Angular 22 works without replacing your system Node.

See [architecture and milestones](docs/architecture.md), [schema migration](supabase/migrations/202610110001_foundation.sql), and [backup/restore procedures](docs/operations.md).
