# Decisions
Spec: [BUILD_SPEC.md](BUILD_SPEC.md). If a live doc contradicts the spec, the doc wins; record it here.

| Date | Decision | Notes |
|---|---|---|
| 2026-11-17 | Scaffold M0 with minimal stubs; Tailwind/shadcn, Supabase local, Sentry, Upstash wiring deferred to follow-up M0 commits | Keeps first push reviewable |
| 2026-11-17 | Direct review collection allowed on all plans in MVP | Spec §6 |
| 2026-11-17 | Product renamed to AggreGator (repo MaverickSTR/hostimonial); slug/scope `aggregator` | Domain/CDN host still TBD |
| 2026-11-19 | M1 DDL + RLS are hand-written SQL in `packages/db/migrations` (applied by `pnpm --filter @aggregator/db migrate`); `schema.ts` holds typed row shapes only | RLS can't be expressed in drizzle-kit; avoids two sources of truth. Drizzle query builder can be layered on later |
| 2026-11-19 | PKs use `gen_random_uuid()` (v4), not UUID v7 | PG16/Supabase lack native uuidv7; revisit |
| 2026-11-19 | Local dev DB = plain Postgres 16 + `scripts/supabase-shim.sql` (roles, `auth.uid()`); never run the shim on real Supabase | Owner is setting up Supabase; migrations assume Supabase's `auth.uid()`/`authenticated` |
| 2026-11-19 | `connections.credentials_enc`/`token_cache_enc` have no SELECT grant for `authenticated`; app queries list columns explicitly | Secrets only via service role |
| 2026-11-19 | Org creation only via `app.create_org()` (SECURITY DEFINER); `orgs` has no INSERT policy | Avoids org/membership chicken-and-egg |
| 2026-11-19 | Removed stray compiled `.js` files accidentally committed in M0 | tsc emitted when base tsconfig was unresolved |
