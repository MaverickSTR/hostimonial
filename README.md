# AggreGator
Review aggregation tools for short-term rentals: pull guest reviews from PMSs, Google and CSV, and embed per-property or portfolio widgets on any site. See [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md).

```bash
pnpm install
pnpm dev
```

## Local database
```bash
scripts/dev-db.sh start        # Postgres 16 on :54322 with Supabase-compatible shims
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
pnpm --filter @aggregator/db migrate
pnpm test
```
