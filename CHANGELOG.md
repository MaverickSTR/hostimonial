# Changelog
## M1 (DB + RLS layer done; auth UI/e2e pending Supabase)
- Migrations: tenancy, users, memberships, invitations, properties, connections, external listings/mappings, audit_log.
- RLS on all tenant tables with `app.*` helper functions; secrets columns unreadable by app role.
- RLS test suite (19 tests: cross-tenant read/write, client_viewer/client_editor scoping, onboarding).
- `withRls()` request-scoped DB helper; local dev DB script.
## M0
- Monorepo scaffold: pnpm + Turborepo, web (Next + Tailwind), widget (Preact/Vite IIFE), core/db/connectors/config, CI.
