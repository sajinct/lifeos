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
- Private-by-default records, 18 RLS-protected application tables, private Storage policies, typed client access and server-only reminder dispatch.
- Currency-aware summaries, linked project records, CSV/JSON exports and idempotent transfer requests.
- Installable PWA manifest/service worker that caches static assets only; offline indication.
- GitHub Actions checks and Pages deployment supporting repository paths and custom domains.

This is **Phase 1 plus an initial Phase 2 slice**, not the complete fifteen-module ERP. Documents UI, family, assets, subscriptions, contacts, budgets/bills/loans, habits, career, health, travel, email automation, imports and AI are subsequent milestones. The app does not expose empty routes for those modules.

## Connect and deploy

The production app uses Supabase for real accounts and private records. Public connection values are configured as GitHub Actions repository variables. Create an account, verify your email, and create a workspace to start saving records. The optional demo remains available with session-only sample data.

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
