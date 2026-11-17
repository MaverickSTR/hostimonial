# BUILD_SPEC.md: STR Review Widget (MVP)

> **For Claude Code.** This is the build spec for an MVP SaaS. Work **one milestone at a time** (Section 14). Don't start a milestone until the previous one's acceptance criteria pass. Items marked **⚠ VERIFY** are external facts or API details you must confirm against the live docs (or with the owner) before relying on them. Don't invent API fields. If a doc contradicts this spec, the doc wins: note the difference in `docs/DECISIONS.md` and carry on.
>
> Owner: Chase Gillmore, Maverick STR (chase@maverickstr.co). Working product name: **`staywall`** (placeholder; keep it in one config constant `APP_NAME` so it can be renamed).

---

## 1. Product summary

An embeddable **guest-review widget built for short-term-rental (STR) websites**. It pulls reviews from PMS APIs (Hostaway, Guesty first), Google, CSV/manual import and its own post-stay review form. It maps every review to the right **property** and renders fast, brandable widgets on direct-booking and management-company sites: one widget per property, one for the whole portfolio, from **one script tag**.

**Why it exists (from the market research in `/workspace/str-review-research/`):**
- The incumbent (Revyoos) charges per property in EUR with an opaque ladder. Users report manual URL setup, weak per-property filtering, few layouts, no language switching and no stats export.
- Generic widgets (Elfsight, EmbedSocial) meter by **page views** and switch the widget off over the limit. They have no idea what a "property" is.
- Nobody serves **web agencies** that build and run many STR client sites.
- Hostaway, Lodgify and Hospitable won't display Airbnb review text, citing Airbnb's Terms. **We don't scrape Airbnb.**

**Target users**
1. **Agencies / web designers** (primary; Maverick itself): manage many client workspaces, each with many properties; white-label.
2. **Property managers (5–150+ units)** with a direct-booking or management site.
3. **Independent hosts (1–5 units)** with a direct-booking site.

**MVP promise:** connect your PMS (or upload a CSV) → reviews show up per property within minutes → paste one script → per-property and portfolio widgets on any site builder, no view caps, flat USD pricing.

---

## 2. Tech stack (with reasoning)

| Layer | Choice | Why |
|---|---|---|
| Monorepo | **pnpm workspaces + Turborepo** | Dashboard, widget bundle and WP plugin share types and build together |
| Dashboard + API | **Next.js (App Router) + TypeScript (strict)** on **Vercel** | One codebase for UI and REST/route handlers; easy previews |
| UI | Tailwind CSS + shadcn/ui; React Hook Form + Zod | Fast to build, accessible; Zod schemas shared with the API |
| Database | **Postgres on Supabase** | Managed Postgres + **Row-Level Security** + Auth in one; branch DBs for previews. (Neon + Auth.js is an acceptable swap; record it in DECISIONS.md) |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | SQL-first, works with RLS policies written in SQL migrations, light runtime |
| Auth | **Supabase Auth** (email magic link + Google OAuth) | JWT claims usable inside RLS policies |
| Background jobs | **Inngest** | Serverless-friendly cron + event-driven jobs, retries, concurrency keys per connection (rate-limit safety) |
| Cache / rate limit | **Upstash Redis** (`@upstash/ratelimit`) | Edge-compatible counters for public endpoints and PMS token caching |
| Widget runtime | **Preact + Shadow DOM**, built with **Vite library mode** to one ES2018 IIFE file | Small (Preact ~4 KB gz), CSS isolation from host sites |
| Widget data delivery | **Static JSON snapshots** published to **Cloudflare R2** behind a CDN domain (`cdn.<app-domain>`) | Every widget view is a CDN hit, not an app/DB hit, so we can afford "no view caps" |
| Email | **Resend** (+ React Email templates) | Review-request emails, transactional mail |
| Billing | **Stripe Billing** (Checkout + Customer Portal + webhooks) | Tiers, annual plans, per-property overage via quantity |
| Secrets at rest | AES-256-GCM envelope encryption (`libsodium`/`node:crypto`), key in env `CREDENTIALS_ENC_KEY` | PMS API secrets must never be stored in plaintext |
| Observability | Sentry (dashboard + widget, sampled), Vercel logs, Inngest dashboard | |
| Testing | Vitest (unit), Playwright (e2e + widget on fixture host pages), MSW (mock PMS APIs), `size-limit` (bundle budget) | |
| WordPress | Small PHP plugin (shortcode + Gutenberg block) that prints the script tag | Most STR sites are WordPress |

Rejected for MVP: a separate API server (Next route handlers are enough), Kafka/queues beyond Inngest, GraphQL.

---

## 3. Repo structure

```
staywall/
├─ apps/
│  ├─ web/                      # Next.js dashboard + API (app router)
│  │  ├─ app/
│  │  │  ├─ (marketing)/         # landing, pricing (simple)
│  │  │  ├─ (auth)/login, /accept-invite
│  │  │  ├─ (app)/[orgSlug]/...  # dashboard (see §10)
│  │  │  ├─ r/[token]/           # public post-stay review form
│  │  │  └─ api/
│  │  │     ├─ v1/...            # authenticated REST (see §12)
│  │  │     ├─ public/...        # unauthenticated: widget beacon, review form submit
│  │  │     ├─ oauth/google/callback
│  │  │     ├─ webhooks/stripe
│  │  │     └─ inngest
│  │  ├─ lib/ (db, auth, rls, crypto, stripe, plans, snapshot, ratelimit)
│  │  └─ inngest/ (functions)
│  └─ widget/                   # Preact widget → dist/w.js
│     ├─ src/ (loader.ts, render/, layouts/, i18n/, schema.ts, styles.css)
│     └─ test/fixtures/*.html   # plain, WordPress-like, Webflow-like host pages
├─ packages/
│  ├─ db/                       # drizzle schema, migrations (incl. RLS SQL), seed
│  ├─ core/                     # shared types, zod schemas, normalization, matching
│  ├─ connectors/               # hostaway/, guesty/, google/, csv/, direct/ (+ ownerrez/, hospitable/ stubs)
│  └─ config/                   # eslint, tsconfig, tailwind preset
├─ plugins/wordpress/staywall-reviews/   # PHP plugin
├─ docs/ (DECISIONS.md, API.md, EMBED.md, CONNECTORS.md, RUNBOOK.md)
└─ turbo.json, pnpm-workspace.yaml, .env.example
```

---

## 4. Data model (Postgres, via Drizzle)

All tenant tables carry `org_id` (the **billing tenant**) and, where relevant, `workspace_id` (an agency's **client**). Use UUID v7 PKs, `created_at`/`updated_at` timestamptz, soft delete via `deleted_at` where noted.

### 4.1 Tenancy & users
```
orgs                      -- billing tenant: an agency, a PM company, or a host
  id, name, slug (unique), type enum('agency','manager','host'),
  branding jsonb {logoUrl, primaryColor, hideAppBranding bool, customCdnHost?},
  stripe_customer_id, created_at

workspaces                -- a "client" inside an org; non-agency orgs get exactly one default workspace
  id, org_id FK, name, slug (unique per org), website_url, timezone, default_locale,
  created_at, deleted_at

users                     -- mirrors auth.users (id = supabase auth uid)
  id, email, name, created_at

memberships
  id, user_id FK, org_id FK, workspace_id FK NULL,   -- NULL workspace = org-wide
  role enum('owner','admin','editor','client_viewer','client_editor'),
  UNIQUE(user_id, org_id, workspace_id)

invitations
  id, org_id, workspace_id NULL, email, role, token_hash, expires_at, accepted_at
```
Role meaning:
- `owner`/`admin`: everything in the org, including billing (owner only) and connections.
- `editor`: manage properties, reviews and widgets in all workspaces.
- `client_editor`: limited to their own workspace. Can moderate reviews and edit widget design. No billing, no connections.
- `client_viewer`: read-only dashboard for their workspace (agency client logins).

### 4.2 Properties & channel mapping
```
properties
  id, org_id, workspace_id, name, slug (unique per workspace), address jsonb, lat, lng,
  bedrooms, external_url (property page on client site),
  status enum('active','archived'), created_at, deleted_at
  -- counts toward plan limit only when status='active' and deleted_at is null

connections               -- one credentialed link to an external system
  id, org_id, workspace_id, provider enum('hostaway','guesty','google_gbp','ownerrez','hospitable'),
  display_name, credentials_enc bytea, credentials_meta jsonb (non-secret: accountId, clientId last4),
  token_cache_enc bytea NULL, token_expires_at NULL,
  status enum('active','error','revoked'), last_error text, last_synced_at, created_at

external_listings         -- a listing as seen in a provider (PMS listing, GBP location, CSV "listing key")
  id, org_id, workspace_id, connection_id NULL, provider, external_id,
  name, address jsonb, lat, lng, raw jsonb, last_seen_at,
  UNIQUE(connection_id, external_id)

listing_mappings          -- external listing → property (the auto-matching output)
  id, org_id, external_listing_id FK UNIQUE, property_id FK,
  method enum('auto_exact','auto_fuzzy','manual'), confidence numeric(4,3),
  confirmed_by user_id NULL, confirmed_at NULL
```

### 4.3 Reviews
```
review_sources            -- logical source per property+channel for display ("Booking.com", "Vrbo", "Google", "Direct")
  id, org_id, property_id NULL (NULL = portfolio-level, e.g. one Google location for the company),
  channel enum('airbnb','vrbo','booking','google','direct','manual','other'),
  connection_id NULL, external_listing_id NULL, label, url (public link to source page)

reviews
  id, org_id, workspace_id, property_id NULL, source_id FK,
  provider, channel, external_review_id, dedupe_hash,      -- UNIQUE(org_id, provider, external_review_id) and UNIQUE(org_id, dedupe_hash)
  author_display_name,      -- normalized: "First L." (see §5.5)
  author_avatar_url NULL, author_locale NULL,
  rating_raw numeric, rating_scale int,       -- e.g. 10 for Booking.com
  rating_5 numeric(3,2),                      -- normalized 0–5
  category_ratings jsonb NULL,               -- {cleanliness: 5, ...} normalized to 5
  title NULL, body text NULL, language NULL,
  host_reply text NULL, host_reply_at NULL,
  stay_start date NULL, stay_end date NULL, submitted_at timestamptz,
  visibility enum('visible','hidden','pending'),   -- moderation
  featured bool default false,
  display_policy enum('allowed','text_restricted'),-- 'text_restricted' for channel='airbnb' (see §5.6)
  raw jsonb, created_at, updated_at, deleted_at

review_requests           -- direct post-stay collection
  id, org_id, workspace_id, property_id, guest_name, guest_email, stay_start, stay_end,
  token_hash, sent_at NULL, opened_at NULL, submitted_review_id NULL, expires_at,
  source enum('manual','csv','pms_reservation'), external_reservation_id NULL

consents                  -- guest permission records (direct form + any permission-cleared imports)
  id, org_id, review_id, method enum('direct_form','email_reply','other'), text, captured_at, ip_hash
```

### 4.4 Widgets
```
widgets
  id (public id: short nanoid, e.g. "w_8k2Jd9"), org_id, workspace_id,
  name, type enum('carousel','grid','badge','floating','rating_line','list'),
  scope enum('property','portfolio','auto'),   -- auto = resolve property from page (see §7.3)
  property_id NULL (scope=property),
  config jsonb (validated by zod WidgetConfig, §7.2),
  version int, published_snapshot_url, published_at, created_at, deleted_at

widget_domains            -- allowed embedding origins (soft check, for abuse + stats)
  id, widget_id NULL, workspace_id, hostname

widget_daily_stats        -- aggregated from beacon, no PII
  widget_id, date, views, interactions, clicks_to_source, PRIMARY KEY(widget_id, date)

property_url_rules        -- for scope=auto: map page URL patterns → property
  id, workspace_id, property_id, pattern (e.g. "/properties/sea-breeze*"), priority
```

### 4.5 Billing
```
plans (seeded, code-defined, mirrored for joins)
  code enum('host','starter','growth','scale','agency'), included_properties, overage_cents NULL,
  features jsonb {pmsSync, multiLanguage, whiteLabel, clientLogins, removeBranding, directReviews, maxWorkspaces}

subscriptions
  id, org_id UNIQUE, plan_code, interval enum('month','year'),
  status (mirror Stripe: trialing|active|past_due|canceled|incomplete),
  stripe_subscription_id, stripe_base_item_id, stripe_overage_item_id NULL,
  current_period_end, cancel_at_period_end, trial_end NULL

usage_snapshots
  org_id, date, active_properties, PRIMARY KEY(org_id, date)
```

### 4.6 Ops
```
sync_runs        id, connection_id, kind enum('listings','reviews','full'), status, started_at, finished_at, stats jsonb, error text
audit_log        id, org_id, actor_user_id, action, entity, entity_id, diff jsonb, created_at
api_keys         id, org_id, name, key_hash, last_used_at, scopes text[]   -- for agency programmatic access (M9, optional)
```

---

## 5. Review data sourcing (MVP: no Airbnb scraping)

### 5.0 Rules
- **Never scrape OTA websites** (Airbnb, Vrbo, Booking.com). Airbnb's Terms say: "Do not use bots, crawlers, scrapers, or other automated means to access or collect data" and "Do not use, copy, display, mirror or frame … any Content … without our consent." (https://www.airbnb.com/help/article/2908)
- Data only comes from: PMS APIs the customer authorizes, Google APIs, CSV/manual import by the customer, and our own direct review form.
- Every connector implements the same interface (`packages/connectors/src/types.ts`):
```ts
interface Connector {
  provider: Provider;
  validateCredentials(input: unknown): Promise<{ ok: true; meta: Record<string,string> } | { ok: false; error: string }>;
  listListings(ctx: ConnCtx): AsyncIterable<ExternalListingInput>;
  listReviews(ctx: ConnCtx, opts: { since?: Date }): AsyncIterable<RawReview>;
  normalize(raw: RawReview): NormalizedReview | null;   // null = skip (e.g. host-to-guest, unsubmitted)
}
```

### 5.1 Hostaway (Milestone 4)
Source: Hostaway Public API docs, https://api.hostaway.com/documentation (read Nov 16, 2026).
- **Auth:** OAuth 2.0 Client Credentials. `POST https://api.hostaway.com/v1/accessTokens`, form-encoded `grant_type=client_credentials&client_id={Hostaway account ID}&client_secret={API secret}&scope=general`. The docs say the token is valid for **24 months**. Store it encrypted in `connections.token_cache_enc` and re-issue on **403**.
- **Customer onboarding:** the customer creates an API key in their Hostaway dashboard and pastes the Account ID + secret into our "Connect Hostaway" form. ⚠ VERIFY: whether a commercial multi-customer integration must join the **Hostaway Marketplace / partner program** (Revyoos and Reva are listed there: https://www.hostaway.com/marketplace/revyoos/). Ask Hostaway partnerships before public launch. Pasting keys is fine for Maverick's own clients in beta.
- **Listings:** `GET /v1/listings` (paginate with `limit`/`offset`). ⚠ VERIFY field names for name, address, lat/lng in the Listing object.
- **Reviews:** `GET https://api.hostaway.com/v1/reviews`. The docs list filters `listingMapIds` (bracket form `listingMapIds[]=`), channel ids, `ratingMin/Max`, `submittedAtStart/End`, `stayDateStart/End`, `hasHostReply`, `sortBy`, and `limit` (default 100, max 500). Review object fields in the docs include `id, listingMapId, reservationId, channelId, type ("guest-to-host"), status, rating, externalReviewId, publicReview, privateFeedback (NEVER display), revieweeResponse, reviewCategory[], arrivalDate, departureDate, guestName`.
  - Keep only `type='guest-to-host'` and a published status. ⚠ VERIFY the exact status values and the channelId → channel mapping table ("Channels" section of the docs). Note the docs spell the rating property "raiting" in one table; handle both.
  - Map `listingMapId` → `external_listings.external_id`.
- **Rate limits (docs):** 200 requests / 10 s per account ID and 200 / 10 s per IP for general endpoints. 429 responses carry `X-RateLimit-Retry-After`. Use an Inngest concurrency key per connection, plus exponential backoff with jitter.
- **Webhooks:** the docs describe unified webhooks. ⚠ VERIFY whether review events exist. MVP: poll every 6 h with `submittedAtStart = last_synced_at − 2 days`.

### 5.2 Guesty (Milestone 5)
Source: Guesty Open API docs, https://open-api-docs.guesty.com (read Nov 16, 2026).
- **Auth:** `POST https://open-api.guesty.com/oauth2/token`, form `grant_type=client_credentials&scope=open-api&client_id&client_secret`. The token lasts **24 h**, and Guesty allows **max 5 token requests per client_id per 24 h** (failed attempts count). Cache the token encrypted, refresh ~30–60 min before expiry, **never** request a token per call. Use a Redis lock so only one token request per connection is ever in flight. (https://open-api-docs.guesty.com/docs/authentication)
- **Rate limits:** the Guesty help center says 15 req/s, 120/min, 5,000/h account-wide; respect `Retry-After`. (https://help.guesty.com/hc/en-gb/articles/38447188197149)
- **Listings:** `GET https://open-api.guesty.com/v1/listings`. ⚠ VERIFY pagination and address fields.
- **Reviews:** `GET https://open-api.guesty.com/v1/reviews`, sorted by last update desc. Params: `channelId` (enum `bookingCom`, `airbnb2`, `homeaway2`, `custom`), `listingId`, `startDate`/`endDate` (on updatedAt), `limit`, `skip`, `includeCustomChannels`. (https://open-api-docs.guesty.com/reference/reviewcontroller_getreviews) ⚠ VERIFY the response `data` shape. The OpenAPI spec only says `object`, so capture a real sample into `packages/connectors/guesty/fixtures/` and type from it.
- ⚠ VERIFY: Guesty Marketplace partner requirements for third-party apps.

### 5.3 Google (Milestone 7)
Two options. Build A; B is optional.
- **A. Google Business Profile API (owner-authorized, full history).** OAuth 2.0 with scope `https://www.googleapis.com/auth/business.manage`. List accounts/locations via the Account Management + Business Information APIs, then `GET https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/reviews` (`pageSize` ≤ 50, `orderBy=updateTime desc`, `nextPageToken`). The location must be verified. (https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list)
  - ⚠ **Must apply for access first:** GBP APIs aren't public. The project quota is 0 QPM until Google approves (300 QPM after). Requirements include managing a verified GBP active 60+ days and a business website. Reviews take up to 14 days. **Submit the application in Milestone 0.** (https://developers.google.com/my-business/content/prereqs)
  - Usually a **portfolio-level** source (one Google profile per management company). Allow mapping a location to a property when the property has its own profile.
- **B. Places API (New) Place Details: rating + count only, live.** Returns `rating`, `userRatingCount` and "up to five" reviews. **Policy:** "You must not pre-fetch, cache, or store Places API content" (place_id is exempt). Attribution with the Google Maps logo and review author attribution is required. (https://developers.google.com/maps/documentation/places/web-service/policies) So if used, **store only `place_id`**, fetch rating/count server-side on demand without persisting, and render Google attribution. Because of these limits and per-request cost, **Places is optional / post-MVP**. ⚠ VERIFY pricing SKU and whether a short in-memory response cache is permitted.

### 5.4 CSV / manual import (Milestone 2)
- CSV template columns: `property_slug|property_name, channel, author_name, rating, rating_scale, title, body, stay_end, submitted_at, host_reply, source_url, external_id`.
- Validate with zod, preview the first 20 rows, show row-level errors, import in one transaction, dedupe by `external_id` or `dedupe_hash`.
- Show a consent checkbox on import: "I have the right to publish these reviews on my website." Record it in `audit_log`.
- Manual "Add review" form in the dashboard.

### 5.5 Normalization pipeline (`packages/core/normalize.ts`)
1. Drop non-guest reviews, unsubmitted/cancelled reviews, and private feedback fields (never stored in `body`).
2. `rating_5 = round(rating_raw / scale * 5, 2)`. Infer the scale per channel (Booking.com = 10; ⚠ VERIFY how each PMS reports Booking.com scores). Normalize category ratings the same way.
3. `author_display_name`: first name + last initial ("Sarah K."). No emails or phones. Trim whitespace, title-case.
4. Strip HTML, collapse whitespace, detect language (`franc-min`), keep ≤ 5,000 chars.
5. `dedupe_hash = sha256(org_id|channel|lower(author_first)|stay_end|first 80 chars of body)`. This catches the same review arriving via two connectors.
6. Upsert on `(org_id, provider, external_review_id)`. On edit, update fields but **preserve moderation state** (`visibility`, `featured`).
7. New reviews start `visibility='visible'` unless the workspace setting `autoPublishMinRating` (default 4) is set and the rating is below it → `pending`. Show a moderation queue badge.
8. Emit the Inngest event `reviews/changed { workspaceId, propertyIds[] }` → triggers snapshot publishing (§7.5).

### 5.6 Airbnb-channel reviews arriving via PMS APIs
Hostaway and Guesty both expose Airbnb as a channel. Hostaway's own booking engine hides Airbnb review text: "Due to Airbnb's T&Cs, Airbnb reviews are hidden in the Booking Engine. However, they are still used for average rating calculations." (https://support.hostaway.com/hc/en-us/articles/13949494929051)
**MVP policy (default, mirrors Hostaway):**
- Import Airbnb-channel reviews with `display_policy='text_restricted'`.
- Widgets **may include them in aggregate rating/count** and show "Airbnb: 4.9 ★ (212 reviews)" with a link to the listing (if the user provides the URL).
- Widgets **do not render their text, author or avatar**.
- Org-level setting `airbnbTextDisplay` exists but is **disabled in code behind a feature flag** until the owner gets legal advice. ⚠ VERIFY with counsel. Don't build any UI that enables it.

### 5.7 Direct post-stay review collection (Milestone 6)
- Create `review_requests` manually, by CSV, or (post-MVP) from PMS reservations with `departureDate` in the last N days. ⚠ VERIFY reservation endpoints and the guest email availability/terms per PMS.
- Email via Resend: "How was your stay at {property}?" with a tokenized link `https://app/r/{token}` (token = 32-byte random, store sha256 only, expires in 30 days, single use).
- The form has: overall stars (1–5), optional categories (cleanliness, accuracy, communication, location, check-in, value), title, body, display name (prefilled "First L."), and a consent checkbox: "I agree that my review and first name/initial may be published on {brand}'s website." Add hCaptcha/Turnstile and rate limiting.
- Saved as `channel='direct'`, linked to `consents`, verified-stay badge ("Verified stay, {Month YYYY}").
- Unsubscribe link; CAN-SPAM footer with the org's address (required setting before sending).

### 5.8 Auto-matching external listings → properties (Milestone 4)
Run after each listings sync, in `packages/core/match.ts`:
1. **Same-connection bootstrap:** if a workspace has no properties yet, offer "Create properties from Hostaway/Guesty listings" (1 property per listing, auto-mapped, `method='auto_exact'`).
2. **Exact:** normalized address (lowercase, USPS-style abbreviations, strip unit noise) + postal code equal → confidence 1.0.
3. **Geo + name:** distance ≤ 75 m (haversine) AND name similarity (trigram/Jaro-Winkler) ≥ 0.6 → confidence = 0.5·geoScore + 0.5·nameScore.
4. **Name only:** similarity ≥ 0.85 within the same workspace → confidence 0.7.
5. Auto-apply when confidence ≥ 0.9. Otherwise put it in a **"Review matches" queue** with suggestions, plus manual bulk mapping (table with a dropdown per row, "accept all suggestions").
6. A property can have many external listings (e.g. the same home in Hostaway and a Google location). An external listing maps to at most one property.

### 5.9 Sync orchestration (Inngest)
- `connection/connected` → `syncListings` → `match` → `syncReviews(full)`.
- Cron every 6 h per active connection: `syncReviews(since=last_synced_at−48h)`. Daily: `syncListings`.
- Concurrency: `key = connection_id, limit = 1`. Throttle per provider using the documented limits.
- On 401/403: refresh the token once (Guesty: respect the 5/day budget), then mark the connection `error` with a readable message + email the org admins.
- Each run writes `sync_runs.stats` (`fetched, inserted, updated, skipped, errors`).
- "Sync now" button, rate limited to 1 per 10 min per connection.

---

## 6. Plans, limits & Stripe billing (Milestone 8)

| Plan | Monthly | Annual (2 months free) | Included active properties | Overage | Workspaces | Key flags |
|---|---|---|---|---|---|---|
| Host | $9 | $90 | 2 | none (upgrade) | 1 | branding badge on (removable: no) |
| Starter | $19 | $190 | 5 | none (upgrade) | 1 | all layouts |
| Growth | $49 | $490 | 25 | none (upgrade) | 1 | PMS sync, multi-language, remove branding |
| Scale | $99 | $990 | 75 | **$1 / property / mo** | 3 | + direct review collection, priority support |
| Agency | $199 | $1,990 | 150 (pooled across workspaces) | **$0.75 / property / mo** | unlimited | + white-label, client logins, bulk setup, API keys |

- **MVP feature gating:**
  - Host and Starter: CSV/manual + Google + direct form only.
  - Growth and up: PMS connections.
  - Direct review collection: allow on all plans in MVP (simplest); revisit later. Record this in DECISIONS.md.
- Plan definitions live in code (`apps/web/lib/plans.ts`) as the single source of truth, seeded into `plans`.
- **Stripe objects:** one Product per plan with two Prices (monthly, yearly). For Scale/Agency, add a second **per-unit overage Price** (monthly $1.00 / $0.75; for annual subscriptions use an annual overage price of $10 / $7.50 per unit-year, i.e. 2 months free, and ⚠ confirm with owner). The subscription has a base item + an overage item with `quantity = max(0, activeProperties − included)`.
- **Usage sync:** on property create/archive/delete, and nightly, recompute active properties → update the overage item quantity (`proration_behavior: 'create_prorations'`). Write `usage_snapshots`.
- **Enforcement:**
  - Host/Starter/Growth: block creating property #N+1 with an upgrade CTA (API returns 402 `plan_limit_reached`).
  - Scale/Agency: allow and bill the overage; show a "You'll be billed $X/mo extra" confirmation.
  - Workspace limits enforced likewise.
  - On `past_due` > 14 days or `canceled`: widgets keep serving the last snapshot for 7 days (grace), then the snapshot is replaced by an empty payload (widget renders nothing; never an error box on the customer's site). Dashboard goes read-only.
- **Trial:** 14-day trial, no card, on Growth features (card required to continue). Founding-customer coupon support (Stripe coupon, e.g. 30% forever) via promotion codes.
- **Flows:** Stripe Checkout for new subs; Customer Portal for card/plan changes. Webhooks handled: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_failed|paid`. Verify signatures; make handlers idempotent (store `event.id`).

---

## 7. Widgets

### 7.1 Types (all in MVP)
| Type | Use | Notes |
|---|---|---|
| `carousel` | Home page, property page | swipeable, autoplay optional (respects `prefers-reduced-motion`) |
| `grid` (review wall) | Property page / reviews page | masonry-ish CSS grid, "Load more", sort (newest / highest), filter by channel |
| `list` | Booking sidebar, narrow columns | compact |
| `badge` | Header/footer/near CTA | "4.92 ★ · 318 reviews" + channel icons; click opens modal with reviews |
| `rating_line` | Under the price / title | one line, no text reviews |
| `floating` | Site-wide corner tab | collapsed badge → expands to panel; `position` bottom-left/right; hidden on mobile optional |
**Scope** for every type: `property` (fixed), `portfolio` (all properties in the workspace, optional property filter tabs), or `auto` (resolve from the page; §7.3).

### 7.2 Config (zod `WidgetConfig`, stored in `widgets.config`)
```ts
{
  layout: { columns?: 1|2|3|4, maxReviews: number /*default 12, max 50 per page*/, cardStyle: 'card'|'minimal'|'quote' },
  filters: { minRating: 0..5, channels: Channel[] /*default all*/, withTextOnly: boolean, featuredFirst: boolean,
             propertyIds?: string[] /*portfolio subset*/, maxAgeMonths?: number },
  sort: 'newest'|'highest'|'featured',
  header: { show: boolean, showAggregate: boolean, showChannelBreakdown: boolean, title?: string },
  display: { showAvatar: boolean, showDate: boolean, dateFormat: 'month_year'|'relative', showStayDate: boolean,
             showChannelIcon: boolean, showHostReply: boolean, truncateChars: number, showPropertyName: boolean /*portfolio*/ },
  theme: { mode: 'light'|'dark'|'auto', primary: string, text: string, background: string, radius: 0..24,
           fontFamily: 'inherit'|string, starColor: string, customCss?: string /*agency plan only, sanitized, scoped to shadow root*/ },
  i18n: { locale: 'auto'|'en'|'es'|'fr'|'de'|'it'|'pt'|'nl', labels?: Record<string,string> },
  floating?: { position: 'bottom-left'|'bottom-right', hideOnMobile: boolean, delayMs: number },
  seo: { jsonLd: 'off'|'aggregate'|'aggregate_and_reviews', schemaType: 'VacationRental'|'LodgingBusiness'|'Accommodation', ssrFallback: boolean },
  branding: { showPoweredBy: boolean /*forced true on Host/Starter*/ }
}
```
MVP UI strings are English only. Ship the i18n framework with `en` complete and `es` as a proof of the pipeline. Review texts are shown in the original language (machine translation is Phase 2).

### 7.3 Embed: one script, data attributes
```html
<script src="https://cdn.staywall.app/w.js" async></script>
<div data-staywall="w_8k2Jd9"></div>
<!-- per-property override on a template page -->
<div data-staywall="w_8k2Jd9" data-property="sea-breeze-cottage"></div>
<!-- floating widget: no container needed -->
<script src="https://cdn.staywall.app/w.js" data-staywall-floating="w_Fl0at1" async></script>
```
- The loader finds all `[data-staywall]` nodes (plus a MutationObserver for SPA builders like Webflow interactions/Wix). For each node: attach a Shadow root, lazy-render when within 200 px of the viewport (IntersectionObserver), fetch the snapshot.
- **Scope `auto`:** property resolved in this order: `data-property` (slug or id) → `property_url_rules` match on `location.pathname` (rules are included in the workspace snapshot) → fall back to portfolio. This solves PMS site builders that allow only **one script** for the whole site.
- `window.Staywall.refresh()` API for SPAs.
- **Never throw into the host page:** wrap everything in try/catch, render nothing on failure, and report to a sampled error beacon.

### 7.4 Performance budget (CI-enforced with `size-limit`)
- `w.js` (loader + Preact + all layouts) **≤ 30 KB gzipped**. Target 20 KB. Code-split rarely used layouts into lazy chunks if needed.
- Snapshot JSON for a property ≤ 50 KB gz (cap 50 reviews per snapshot page, paginate `p2.json` …).
- No layout shift: the container reserves height using `data-min-height` or a skeleton with fixed aspect.
- No fonts loaded by default (`inherit`). Images (avatars) lazy-loaded, 48 px, served via a resized CDN copy (never hotlink provider images if their terms forbid; ⚠ VERIFY per source. Default: initials avatars).
- Long-cache `w.js` by version (`/w.js` is a 5-min-cache stub that imports `/v/{hash}/w.js`, which is immutable).
- Lighthouse: embedding the grid on the fixture page must not lower the Performance score by more than 3 points vs. without (Playwright + Lighthouse CI).

### 7.5 Snapshot publishing
- Inngest `snapshots/publish { workspaceId, propertyIds? }`, debounced 60 s per workspace.
- Writes to R2:
  - `/{workspaceId}/workspace.json`: widget configs, property slugs, URL rules, aggregates per property and portfolio.
  - `/{workspaceId}/p/{propertyId}/reviews-{page}.json`.
  - `/{workspaceId}/portfolio/reviews-{page}.json`.
- Only `visibility='visible'` reviews. `text_restricted` reviews are included only as counts in aggregates (no text/author).
- Cache headers: `Cache-Control: public, max-age=300, stale-while-revalidate=86400`. Purge via versioned paths (`?v={snapshotVersion}` from `workspace.json`, which itself has max-age 60).
- Aggregates: `avg_rating_5` (weighted by count across channels), `count`, per-channel `{avg, count}`. Show per-channel breakdown by default (users dislike a single opaque blended index).

### 7.6 JSON-LD done the Google-compliant way
Google's review snippet guidelines say LocalBusiness/Organization review stars are only eligible "for sites that capture reviews about other local businesses" (self-serving reviews aren't eligible). Google's VacationRental rich results require a Google Technical Account Manager + Hotel Center. (https://developers.google.com/search/docs/appearance/structured-data/review-snippet, https://developers.google.com/search/docs/appearance/structured-data/vacation-rental)
Therefore:
- `seo.jsonLd` defaults to **`off`**. The dashboard explains: "Structured data helps search engines and AI understand your reviews. Google does not show review stars for a business's own reviews of itself."
- When on, emit **only** for `scope=property` (or auto-resolved property) widgets, as one `<script type="application/ld+json">` **in the light DOM** (outside the shadow root), with:
  - `@type` = configured type (`VacationRental` default) + `name` + `url` (canonical page),
  - `aggregateRating { ratingValue, reviewCount, bestRating: 5, worstRating: 1 }` computed **only from reviews whose text is rendered on that page** (exclude `text_restricted`), and
  - optionally up to 10 `review` items **that are visibly rendered** (author, datePublished, reviewRating, reviewBody).
- **Never** use `Product` or another type to farm stars. Never mark up reviews that aren't visible. Never emit markup for portfolio widgets. Don't emit if a page already has the widget's JSON-LD (dedupe by `data-staywall-ld` id).
- `ssrFallback`: the WordPress plugin can server-render the first 5 reviews as plain HTML (from the snapshot via PHP fetch + transient cache) so text is crawlable without JS. Webflow/Wix/Squarespace get JS-only in MVP.
- Acceptance: the Rich Results Test / schema.org validator shows no errors on a fixture page (manual check, documented in RUNBOOK).

### 7.7 Platform embed notes (write in `docs/EMBED.md` + in-app copy)
- **WordPress:** plugin `staywall-reviews` (WP 6.0+, PHP 7.4+): settings page (paste widget IDs), shortcode `[staywall id="w_x" property="slug"]`, Gutenberg block, enqueue `w.js` once with `async`, optional SSR fallback. Also document "Custom HTML block" for no-plugin installs. Elementor: HTML widget.
- **Webflow:** site settings → custom code (footer) for the script; Embed element for `<div data-staywall>`; on CMS property templates bind `data-property` to the CMS slug field.
- **Wix:** Settings → Custom Code (body end, all pages) for the script; "Embed HTML" element renders in an iframe, so the div must include the script inside that embed (document both; MutationObserver handles late inserts). ⚠ VERIFY current Wix iframe behavior while testing.
- **Squarespace:** Code Injection (footer) for the script (Business plan+ ⚠ VERIFY); Code Block for the div.
- **Hostaway / Guesty / Lodgify / Boostly booking sites:** paste the script in the site's head/footer script setting; use one `auto`-scope widget + URL rules when the builder allows only one script. Document the exact menu paths only after testing each one (⚠ VERIFY).

---

## 8. Security & multi-tenancy
- **RLS on every tenant table.** Helper SQL functions:
  - `auth.uid()` (Supabase),
  - `app.is_org_member(org uuid)`,
  - `app.can_access_workspace(org uuid, ws uuid)`: true if an org-wide membership exists OR a membership exists for that workspace,
  - `app.has_role(org, roles[])`.
- Policies: SELECT where `can_access_workspace`; INSERT/UPDATE/DELETE where role permits (client roles only on their workspace, and never on `connections`, `subscriptions` or `memberships`).
- **Server access pattern:** the dashboard and API use a Drizzle client that runs each request in a transaction with `set local role authenticated; set local request.jwt.claims = '<jwt claims json>'`, so **RLS applies to app queries**. Only Inngest jobs and Stripe webhooks use the service role, via a separate `adminDb` export, and must pass `org_id` explicitly. Lint rule: `adminDb` can't be imported under `app/(app)` or `app/api/v1`.
- **Tests:** a dedicated RLS test suite seeds 2 orgs × 2 workspaces × each role and asserts cross-tenant reads/writes fail (must pass in CI).
- **Secrets:** PMS credentials encrypted (AES-256-GCM, per-record nonce, key version byte for rotation); never returned by the API (only `meta`); never logged (pino redaction paths).
- **Public endpoints** (`/api/public/*`, review form, beacon): Upstash rate limits.
  - Review form submit: 5/min/IP.
  - Beacon: 60/min/IP, sampled 10% for views.
  - Invitation accept: 10/min/IP.
  - `/api/v1/*`: 300/min per user, 60/min per API key.
- Turnstile on the public review form.
- **Widget data is public by design** (snapshots on the CDN contain only display-safe fields). Never include private feedback, guest emails, reservation ids or internal notes. Unit-test the snapshot serializer against a denylist.
- `widget_domains` is a soft allowlist used for stats and abuse response, not access control.
- CSP-safe widget (no `eval`, no inline event handlers). `customCss` is sanitized (strip `@import`, `url()` except https images, `expression`) and scoped to the shadow root.
- Audit log for: connection changes, member/role changes, review hide/unhide, plan changes, exports.
- GDPR basics: delete a review on request (hard delete + republish snapshot within 15 min); org data export (CSV) and org deletion.

---

## 9. Caching summary
| Data | Where | TTL / invalidation |
|---|---|---|
| `w.js` versioned bundle | CDN | immutable, 1 year |
| `w.js` stub | CDN | 5 min |
| `workspace.json` | R2 + CDN | max-age 60, SWR 1 day; republished on change |
| review pages JSON | R2 + CDN | versioned URL, max-age 300, SWR 1 day |
| PMS access tokens | Postgres (encrypted) + Redis lock | Hostaway: until 403; Guesty: 24 h, refresh at T−45 min |
| Dashboard queries | none in MVP (server components, simple) | |

---

## 10. Dashboard pages
Under `/{orgSlug}`. Agencies see a workspace switcher; other orgs see one implicit workspace.
1. **Onboarding wizard:** org type (agency / manager / host) → first workspace (agency: "first client") → connect source (Hostaway / Guesty / CSV / skip) → create properties from listings → pick a widget template → copy embed code.
2. **Workspaces** (agency only): list, create, archive; per-workspace counts (properties, reviews, avg rating, last sync); "Invite client".
3. **Properties:** table (name, slug, mapped sources, review count, avg), bulk create from listings, bulk CSV create (name, slug, address, url), archive. Property detail: sources, reviews, URL rules, widget embed snippet with `data-property`.
4. **Sources & connections:** connect/disconnect Hostaway, Guesty, Google; status, last sync, errors, "Sync now"; **Review matches** queue (§5.8).
5. **Reviews inbox:** filter by property/channel/rating/visibility/date; hide/unhide, feature, bulk actions; Airbnb-channel rows show a "text not displayed on websites" badge; CSV import/export; "Add review".
6. **Review requests:** create single/bulk (CSV), status (sent/opened/submitted), resend; sender settings (from name, reply-to, physical address).
7. **Widgets:** list; builder with a **live preview** (renders the real widget component against the current snapshot or draft data), type/scope/config controls, "Publish", embed code tabs (HTML, WordPress shortcode, Webflow, Wix, Squarespace).
8. **Analytics (basic):** views/interactions/clicks per widget per day (from beacon), CSV export.
9. **Settings:**
   - Org: name, branding (logo, color, hide app branding when the plan allows), custom CDN host (Phase 2), members & roles, API keys (agency).
   - Billing: plan, usage meter (active properties vs included, projected overage), Stripe portal.
10. **Client portal** (`client_viewer` / `client_editor`): the same app scoped to one workspace, showing the agency's logo/colors instead of ours when `whiteLabel` is enabled. No billing/connections nav.

### Agency white-label (MVP scope)
- Client workspaces, client logins (invite by email with a client role), bulk property setup (from PMS listings or CSV), per-workspace defaults, copy widget config across workspaces ("Apply this design to all clients").
- Branding: agency logo + primary color in the dashboard for client users; "Powered by" removed from widgets; review-request emails sent with the agency/client sender name.
- **Phase 2:** custom dashboard domain (`reviews.agency.com`) and custom CDN host for `w.js` (Cloudflare for SaaS custom hostnames; ⚠ VERIFY cost), plus agency-branded login page.

---

## 11. Widget beacon & stats (lightweight)
`POST https://app/api/public/b` with `{w, e: 'view'|'interact'|'click_source', p?: propertyId}`.
- `navigator.sendBeacon`, sampled views at 10% (scale ×10 on aggregation), no cookies, no IP stored (only used transiently for rate limiting).
- Inngest batches events into `widget_daily_stats`.

---

## 12. API (REST, JSON, `/api/v1`, Supabase session cookie or `Authorization: Bearer <api_key>`)
Conventions:
- Cursor pagination (`?cursor&limit≤100`).
- Errors: `{ error: { code, message, details? } }`.
- zod-validated input; OpenAPI generated with `zod-to-openapi` into `docs/API.md`.

```
GET    /workspaces                      POST /workspaces              PATCH/DELETE /workspaces/:id
GET    /workspaces/:ws/properties       POST (single|bulk[])          PATCH/DELETE /properties/:id
POST   /workspaces/:ws/properties/import-csv        (multipart; returns preview → POST ...?commit=1)
GET    /workspaces/:ws/connections      POST /workspaces/:ws/connections {provider, credentials}
POST   /connections/:id/test            POST /connections/:id/sync    DELETE /connections/:id
GET    /oauth/google/start?ws=          GET /oauth/google/callback
GET    /workspaces/:ws/external-listings?unmapped=1
GET    /workspaces/:ws/match-suggestions            POST /listing-mappings {externalListingId, propertyId}   DELETE /listing-mappings/:id
GET    /workspaces/:ws/reviews?property&channel&minRating&visibility&q
PATCH  /reviews/:id {visibility, featured}          POST /reviews/bulk {ids[], action}
POST   /workspaces/:ws/reviews (manual)             POST /workspaces/:ws/reviews/import-csv
GET    /workspaces/:ws/reviews/export.csv
POST   /workspaces/:ws/review-requests (single|bulk) GET ... ; POST /review-requests/:id/resend
GET    /workspaces/:ws/widgets          POST          PATCH /widgets/:id   POST /widgets/:id/publish   DELETE
GET    /widgets/:id/stats?from&to
GET    /workspaces/:ws/url-rules        POST          DELETE /url-rules/:id
GET    /members  POST /invitations  PATCH /memberships/:id  DELETE /memberships/:id
GET    /billing  POST /billing/checkout {plan, interval}  POST /billing/portal
Public (no auth):
GET    /api/public/r/:token            POST /api/public/r/:token   (review form)
POST   /api/public/b                   (beacon)
POST   /api/webhooks/stripe            POST /api/inngest
```

---

## 13. Out of scope for MVP (with notes)
- **Airbnb / Vrbo / Booking.com scraping:** not now, possibly never. Legal (Airbnb Terms) and reliability risk. Revisit only with counsel.
- **Displaying Airbnb review text:** behind a disabled flag (see §5.6).
- **AI features (Phase 2):** theme highlights (cleanliness, location, hot tub…), per-property "What guests love" summaries, AI reply drafts, review translation. Plan: nightly job → LLM with a strict JSON schema → store in `review_insights` (property_id, theme, sentiment, quote_review_ids[]); only quote verbatim snippets from visible reviews.
- **OwnerRez connector (Phase 2):** API v2 `GET /v2/reviews` exists. Reviews/Listings endpoints need an **OAuth app with listing access (partnership agreement)** or the customer's WordPress Plugin + Integrated Websites premium; email partnerhelp@ownerrez.com. Rate limit 300 req / 5 min per IP and 1,000 per token. (https://api.ownerrez.com/help/v2, https://www.ownerrez.com/support/articles/api-overview) ⚠ VERIFY before building.
- **Hospitable connector (Phase 2):** Public API `GET https://public.api.hospitable.com/v2/properties/{id}/reviews`. Partners must use **OAuth** (`auth.hospitable.com/oauth/authorize` / `/oauth/token`) after a **partner application**; PATs are for a host's own use only. (https://help.hospitable.com/en/articles/16234154, https://help.hospitable.com/en/articles/8609392) Note: Hospitable states Airbnb reviews can't be published on direct sites, so apply §5.6.
- Google Places live rating (§5.3 B), owner PDF reports, review reply-back to OTAs, booking attribution, indexable per-property review pages hosted by us, custom domains, Zapier, more PMSs (Lodgify, Hostfully, Track, Streamline), Vrbo/Booking direct APIs, SMS requests, multi-currency billing, SSO.

---

## 14. Milestones (do them in order)
Each milestone ends with: green CI (lint, typecheck, unit, e2e for that area), updated `docs/`, a short `CHANGELOG.md` entry, and a demo script in `docs/RUNBOOK.md`.

### M0: Foundations
- Monorepo scaffold (§3); Next.js app with Tailwind/shadcn; Supabase project (local via `supabase start`); Drizzle wired; Inngest dev server; Upstash; Sentry; `.env.example` listing every variable; GitHub Actions CI.
- File external access requests and record status in `docs/CONNECTORS.md`: Google Business Profile API access application; Hostaway and Guesty partner/marketplace inquiries (owner sends; you draft the text).
- **Done when:** `pnpm dev` runs web + widget + inngest; CI passes on an empty test; `docs/DECISIONS.md` exists.

### M1: Auth, orgs, workspaces, roles, RLS
- Supabase Auth (magic link + Google); onboarding creates org + default workspace + owner membership; invitations; role checks; full schema §4.1–4.2 (properties) with RLS; audit log.
- **Done when:** RLS test suite proves user A (org 1) can't read or write any org 2 row via the app DB client, and a `client_viewer` can't see another workspace or any connection; e2e: sign up → create agency → create 2 workspaces → invite a client viewer → viewer sees only their workspace.

### M2: Properties, reviews core, CSV/manual import, moderation
- Properties CRUD + bulk CSV; review_sources/reviews schema; normalization (§5.5) with unit tests; CSV import with preview + errors + dedupe; manual add; reviews inbox with filters + hide/feature + bulk; export CSV.
- **Done when:** importing `fixtures/reviews_sample.csv` (100 rows, 3 properties, mixed channels/scales, 5 dupes, 3 invalid) yields 92 reviews with correct `rating_5`, 3 row errors shown, and 0 duplicates on re-import; moderation changes persist and are audited.

### M3: Widget runtime + snapshots + embed
- Snapshot publisher (§7.5) to R2 (MinIO/local folder adapter in dev); `apps/widget` with all 6 types, scopes property/portfolio/auto, config schema, theme, i18n (en + es), lazy load, Shadow DOM, beacon; widget builder page with live preview; embed code tabs; JSON-LD (§7.6) with tests; `size-limit` budget.
- **Done when:**
  - Playwright renders each widget type on the 3 fixture host pages (plain, WordPress-like, Webflow-like) with no console errors and no CSS leakage (host page styles unchanged; widget unaffected by host `* { all: unset }` test CSS).
  - `w.js` ≤ 30 KB gz in CI; `auto` scope resolves via `data-property` and via URL rules; a hidden review disappears from the CDN JSON within 2 min of hiding (Inngest debounce).
  - JSON-LD validates (schema.org validator in a test using a JSON-LD parser) and is never emitted for portfolio widgets or with `text_restricted` reviews counted; widget failure (404 snapshot) renders nothing and throws nothing.

### M4: Hostaway connector + sync pipeline + auto-matching
- Connector per §5.1 with MSW-mocked tests from recorded fixtures (sanitize any real data); connect form with credential test; Inngest jobs (§5.9); match algorithm (§5.8) with unit tests; Review-matches UI; "create properties from listings"; Airbnb `text_restricted` handling (§5.6).
- **Done when:**
  - Against mocks: 3 listings + 40 reviews (incl. host-to-guest, Airbnb channel, private feedback, rating-only) sync. The result: only guest reviews stored, `privateFeedback` never persisted in `body` or the snapshot, Airbnb reviews counted in aggregates but absent from rendered text.
  - A 429 with `X-RateLimit-Retry-After` is honored; re-sync is idempotent.
  - Tested once against a real Hostaway sandbox/account if the owner provides credentials (⚠ VERIFY field mappings; update fixtures + DECISIONS.md).

### M5: Guesty connector
- Per §5.2 with a token-budget guard (Redis lock + persisted token; alert if ≥ 3 token requests in 24 h).
- **Done when:** mocked tests pass (incl. the token-limit scenario: the 6th token request is never attempted; the connection shows a clear error); the real response shape is captured and typed (⚠ VERIFY with owner-provided credentials).

### M6: Direct review collection
- Review requests (single, CSV), Resend email, public form with Turnstile + consent, verified-stay badge, unsubscribe, sender settings.
- **Done when:** e2e: create request → email captured in the dev inbox (Resend test mode/mailpit) → submit form → review appears in inbox as `channel=direct` with a consent record → shows on the widget after publish; token is single-use, expires, and is rate limited.

### M7: Google Business Profile
- OAuth (business.manage), location picker, map a location to a property or portfolio, review sync, reply text stored as `host_reply`. Must render "Google" attribution per source.
- **Done when:** mocked flow passes end-to-end; if GBP access is not yet approved, ship behind the flag `GOOGLE_GBP_ENABLED=false`, with the UI showing "Coming soon"; document approval status.

### M8: Billing & plan enforcement
- Stripe products/prices script (`pnpm stripe:seed`, test mode); Checkout, Portal, webhooks, usage sync, limits, trial, coupons, grace/read-only states.
- **Done when (Stripe test clock tests):**
  - Host blocked at property 3.
  - Scale with 80 properties bills $99 + 5 × $1.
  - Agency with 160 pooled properties across 4 workspaces bills $199 + 10 × $0.75.
  - Annual Growth = $490.
  - Downgrade below current usage is blocked with a clear message.
  - Cancellation → widgets serve last snapshot for 7 days, then empty.
  - Webhooks are idempotent on replay.

### M9: Agency white-label & bulk ops
- Client portal (scoped nav, agency branding), copy widget config to all workspaces, bulk property setup across workspaces, branding removal per plan, agency API keys (scoped to org).
- **Done when:** e2e: an agency with 3 client workspaces bulk-creates properties from a CSV containing a `workspace` column, applies one widget design to all 3, and a client_editor logs in and sees the agency logo, only their workspace and no billing/connections; widgets show no "Powered by" on the Agency plan.

### M10: WordPress plugin, embed docs, hardening, launch
- WP plugin (shortcode, block, settings, SSR fallback with transient cache); `docs/EMBED.md` for Webflow/Wix/Squarespace/booking-site builders (tested manually; screenshots or exact steps); security review checklist (§8); load test of the snapshot path (CDN only); runbook (rotate encryption key, revoke connection, delete guest data); error budget alerts.
- **Done when:**
  - The plugin installs on a clean WP (wp-env) and renders a widget via shortcode and block; SSR fallback HTML contains review text with JS disabled.
  - Lighthouse delta ≤ 3 points on the fixture page.
  - All RLS + snapshot-denylist tests pass.
  - A pilot workspace (Maverick client) is live on a real site.

---

## 15. Definition of done (MVP overall)
1. An agency can onboard a client with a Hostaway or Guesty account in **under 15 minutes**: connect → properties auto-created/mapped → reviews visible → widget embedded on a WordPress site, with per-property widgets on property pages and a portfolio widget on the home page from a single script.
2. No OTA scraping anywhere in the codebase (CI grep check for airbnb.com/vrbo.com/booking.com fetches outside docs/tests).
3. Widgets never break the host page; bundle ≤ 30 KB gz; no view caps (CDN-served).
4. Billing matches the plan table exactly, including overage and annual pricing.
5. Tenant isolation is proven by automated RLS tests.

## 16. Open questions for the owner (ask, don't assume)
1. Final product name and domain (for `APP_NAME`, CDN host, email sender).
2. Hostaway/Guesty partner status: who applies, and is beta with customer-pasted keys acceptable?
3. Legal review of §5.6 (Airbnb-channel review text) before any change to the default.
4. Annual overage pricing for Scale/Agency ($10 / $7.50 per property-year proposed).
5. Which Maverick client sites will be the pilot (and on which builder)?
