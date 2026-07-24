# FieldStay

> Automated field operations for short-term rental managers.

FieldStay is a local-first, multi-tenant SaaS platform that automates turnover operations for property management companies. It eliminates the cognitive overhead of managing crews, work orders, maintenance schedules, inventory restocking, and owner financials — transforming manual coordination into event-driven, zero-touch workflows.

---

## What It Does

| Module | Description |
|---|---|
| **Turnovers** | Auto-generates turnover jobs from PMS booking data; assigns crews based on availability and proximity scoring |
| **Work Orders** | Full WO lifecycle with vendor assignment, compliance gating, photo documentation, and cost tracking |
| **Maintenance** | Recurring schedule engine that auto-creates WOs and notifies vendors |
| **Inventory** | Par-level tracking with automated Kroger cart generation when stock drops below threshold |
| **Owner Financials** | Auto-posts cleaning fees, WO expenses, and booking revenue to per-owner P&L ledger |
| **Asset Health** | Data plate scanning via AI OCR, depreciation tracking, and maintenance history |
| **RepuGuard** | AI-generated review response drafts with flag detection (legal, safety, billing), regeneration limits, and manual review paste (2/week per org) |
| **Crew Mobile** | Offline-first PWA for crew members powered by Dexie.js (IndexedDB) local storage with a custom sync outbox |
| **Guidebook** | Guest-facing portal with WiFi credentials, check-in instructions, and local recommendations. Sponsors pay $15/month per slot for featured placement. Contextual SMS nudges (hot tub timing, fire pit weather, dinner recommendations) are driven by OwnerRez amenity data and live Tomorrow.io weather. Opt-in via door code delivery hook achieves ~100% conversion |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router, Server Components, Server Actions) |
| Hosting | Vercel (IAD1 region) |
| Database | Supabase (PostgreSQL 15, Row Level Security, Realtime) |
| Auth | Supabase Auth (email + password) |
| Client Sync | Dexie.js (offline-first IndexedDB, local-first reads, custom mutation outbox) |
| Background Jobs | Inngest (durable step functions, crons, event-driven workflows) |
| Email | Resend + React Email |
| Payments | Stripe (subscriptions, webhooks, customer portal) |
| Rate Limiting | Upstash Redis |
| PMS Integration | OwnerRez (OAuth2 + webhooks) |
| Grocery API | Kroger (cart automation) |
| Geocoding | Mapbox |
| AI | Anthropic Claude (data plate OCR, RepuGuard draft generation) |
| SMS | Telnyx (A2P 10DLC) |
| Weather | Tomorrow.io |
| Observability | Axiom (Inngest logs) + Sentry (errors + performance traces) + Grafana Cloud (custom business metrics) |

---

## Architecture Overview

```
Browser (Dexie.js IndexedDB)
    ↕ mutation outbox / pull sync
Next.js Server Actions / Route Handlers
    ↕ queries
Supabase PostgreSQL (RLS on every table)
    ↕ events
Inngest (async workflows, crons)
    ↕ integrations
OwnerRez  ·  Stripe  ·  Resend  ·  Kroger  ·  Mapbox  ·  Anthropic
```

**Key architectural constraint:** Client components **never** read from Supabase directly. All client reads go through Dexie's local IndexedDB layer (`lib/dexie/`). Mutations are written to a local `mutations` outbox table and drained by `SyncEngine` (`lib/dexie/syncService.ts`), which pushes them to Supabase via Server Actions/Route Handlers; remote changes are pulled back down on the same cadence. This replaces the project's earlier PowerSync-based sync layer — see `CHANGELOG.md` for the migration.

---

## Prerequisites

- Node.js ≥ 18.17
- A Supabase project (free tier works for development)
- An Inngest account (local dev works without one — see below)
- Stripe account (test mode is fine)
- Resend account

All other integrations (OwnerRez, Kroger, Mapbox, Anthropic, Upstash) are optional for local development.

---

## Local Development Setup

### 1. Clone and install

```bash
git clone https://github.com/your-org/fieldstay.git
cd fieldstay
pnpm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Open `.env.local` and fill in the required values. See [`.env.example`](.env.example) for the full list with per-variable documentation.

**Minimum required for a working local dev session:**

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
INNGEST_EVENT_KEY=         # set to 'local' for inngest-cli dev
INNGEST_SIGNING_KEY=       # set to 'local' for inngest-cli dev
```

### 3. Apply database migrations

```bash
# Install Supabase CLI if needed
npm install -g supabase

# Link to the project
supabase link --project-ref vpmznjktllhmmbfnxuvk

# Apply all migrations
supabase db push
```

> `fieldstay_migration_v1.SUPERSEDED.sql` and `fieldstay_migration_v2.SUPERSEDED.sql`
> at the repo root are SUPERSEDED and must not be run. Current schema is
> maintained as timestamped files in `supabase/migrations/`.

**Migration rollback policy:** migrations in this repo are forward-only —
there are no paired "down" migrations. To undo a bad migration, write and
apply a new corrective migration (e.g. `DROP COLUMN`, restore a dropped
constraint) rather than trying to reverse-apply the original file. Before
running `supabase db push` against production, validate the migration on a
Supabase preview branch first (`supabase branches create`, or the
`create_branch` Supabase MCP tool) — see [`CLAUDE.md`](CLAUDE.md#database-migrations--schema-drift)
for the full migration workflow.

### 4. Generate TypeScript types

```bash
pnpm run types:supabase
```

This writes `types/supabase.ts` from the live schema. Re-run after every migration.

### 5. Start the development servers

**Terminal 1 — Next.js:**
```bash
pnpm run dev
```

**Terminal 2 — Inngest dev server (processes background jobs locally):**
```bash
pnpm run inngest:dev
```

The Inngest dev UI is available at `http://localhost:8288`.

App runs at `http://localhost:3000`.

---

## Available Scripts

| Script | Description |
|---|---|
| `pnpm run dev` | Start Next.js in development mode |
| `pnpm run build` | Production build |
| `pnpm start` | Start production server |
| `pnpm run lint` | Run ESLint |
| `pnpm run inngest:dev` | Start Inngest local dev server |
| `pnpm run types:supabase` | Regenerate Supabase TypeScript types from live schema |

---

## Project Structure

```
fieldstay/
├── app/
│   ├── (auth)/             # Login, signup, password reset
│   ├── (dashboard)/        # All authenticated app routes
│   │   ├── ops/            # Ops snapshot (home dashboard)
│   │   ├── properties/     # Property management + setup wizard
│   │   ├── maintenance/    # Work orders + maintenance board
│   │   ├── inventory/      # Inventory manager + purchase orders
│   │   ├── crew-manage/    # Crew roster + availability
│   │   ├── owners/         # Owner contacts + P&L ledger
│   │   ├── bookings/       # Booking view (PMS-synced)
│   │   ├── reviews/        # RepuGuard review management
│   │   ├── messages/       # Guest messaging
│   │   ├── comms-log/      # Communication history
│   │   └── settings/       # Account + billing settings
│   ├── g/                  # Guest guidebook public routes (/g/[slug], /g/b/[token])
│   ├── crew/
│   │   └── work-orders/    # Crew work order detail pages
│   └── api/
│       ├── inngest/        # Inngest serve() handler
│       ├── webhooks/       # Stripe + OwnerRez webhook handlers
│       └── integrations/   # OAuth callback handlers
├── lib/
│   ├── supabase/           # Supabase client factory (server, client, service)
│   ├── inngest/            # Inngest client, event types, all functions
│   ├── dexie/              # Dexie.js schema, local DB, mutation outbox, sync engine
│   ├── stripe/             # Stripe client + helpers
│   ├── email/              # React Email components
│   ├── kroger/             # Kroger API client
│   ├── guidebook/          # Guidebook helpers, slug generation, PM emails
│   ├── sms/                # Telnyx SMS client, message builders, NANP validation
│   └── weather/            # Tomorrow.io weather client
├── types/
│   ├── database.ts         # Hand-maintained DB types (being migrated to generated)
│   └── supabase.ts         # Generated from schema — do not edit manually
├── fieldstay_migration_v1.SUPERSEDED.sql   # Initial schema — historical reference only, do not run
├── fieldstay_migration_v2.SUPERSEDED.sql   # Incremental schema updates — historical reference only, do not run
└── CLAUDE.md               # AI coding assistant instructions (read before touching code)
```

---

## Key Conventions

**Never break these.** See [`CLAUDE.md`](CLAUDE.md) for the full rule set.

- Every database table has RLS enabled. No exceptions.
- Client components read from Dexie's local IndexedDB only — never call Supabase directly from the browser.
- All mutations go through Server Actions or Route Handlers.
- `SUPABASE_SERVICE_ROLE_KEY` is used only in Inngest steps and specific server-side handlers — never in client code.
- Stripe webhook handlers always verify the signature via `stripe.webhooks.constructEvent()`.
- All Inngest steps are idempotent. Database inserts check `source_reference_id` before creating records.
- TypeScript strict mode is enforced. No `any`, no `unknown` without a type guard.
- Colors always use CSS custom properties (`var(--text-primary)`) — never hardcoded hex or Tailwind color utilities in component files.

---

## Database

The schema is documented in [`CLAUDE.md`](CLAUDE.md) under "Database Schema". Key tables:

- **`organizations`** — tenant root record
- **`organization_members`** — user ↔ org join with role (`admin | manager | crew | viewer | owner`)
- **`properties`** — STR properties with geocoordinates and financial fields
- **`turnovers`** — generated from bookings, drives crew assignment
- **`work_orders`** — full WO lifecycle including vendor assignment
- **`maintenance_schedules`** — recurring maintenance with auto-WO creation
- **`inventory_items`** — property-level inventory with par levels
- **`owner_transactions`** — per-owner P&L ledger with idempotency via `source_reference_id`

### RLS Helper Functions

All policies are built on two Postgres functions:

```sql
-- Returns all org IDs the current user belongs to
get_user_org_ids() → uuid[]

-- Returns true if current user has the required role in the given org
-- The 'owner' role always passes regardless of the roles array
is_org_member(org_id uuid, roles member_role[]) → boolean
```

---

## Deployment

The app deploys to Vercel automatically on push to `main`. Configuration is in [`vercel.json`](vercel.json).

**Function timeout overrides:**
- Inngest handler: 300s (durable workflows)
- Stripe webhook handler: 30s
- AI routes (data plate scan, RepuGuard): 30–60s

**Security headers:** `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and `Strict-Transport-Security` are set globally in `vercel.json`. `Content-Security-Policy` is owned solely by `next.config.ts` — it is not duplicated in `vercel.json`, to avoid the two configs drifting out of sync.

**Required environment variables in Vercel:** All variables from `.env.example` must be set in your Vercel project settings before deploying. The app will deploy silently with missing optional keys but will fail at runtime when that feature is first used.

---

## Integrations

### OwnerRez (PMS)
OAuth2 connection. After connecting, FieldStay syncs properties and bookings via the OwnerRez API and receives booking events via webhook. See [`CLAUDE_INTEGRATIONS.md`](CLAUDE_INTEGRATIONS.md) for full setup.

### Stripe
Subscription billing. Webhook endpoint: `/api/webhooks/stripe`. Always uses `constructEvent()` for signature verification.

### Dexie.js
Offline-first sync. Client reads come from a local IndexedDB database (`lib/dexie/schema.ts`); writes are queued in a local `mutations` outbox and drained by `SyncEngine` (`lib/dexie/syncService.ts`), which pushes them to Supabase and pulls remote changes back down. Tenant isolation is enforced server-side by RLS on every Supabase query the sync engine makes — the client never queries Supabase directly.

### Kroger
Cart automation for inventory restocking. OAuth2 connection per organization. Cart is built automatically when inventory items drop below par level.

### Telnyx (SMS)
A2P 10DLC messaging for guest SMS delivery. Webhook endpoint: `/api/webhooks/telnyx`.
All sends are gated on `SMS_ENABLED=true` — do not enable until 10DLC campaign
verification clears. Handles STOP/START/HELP keywords with TCPA-compliant consent
tracking. Ed25519 signature verification required on the webhook endpoint
(`TELNYX_WEBHOOK_PUBLIC_KEY` env var).

### Tomorrow.io (Weather)
Real-time and forecast weather data used to drive contextual guest SMS messages.
Rain probability, temperature, and condition codes determine which sponsor slot
type fires in the morning and evening cron functions.

### Hostaway (PMS)
OAuth2 connection with API key auth. Property and booking sync adapter built and
in the codebase (`lib/inngest/functions/hostaway/`). Integration listing pending.

### Hospitable (PMS)
OAuth2 application submitted. Integration in design phase — not yet built.

---

## Contributing

This is a private repository. If you have access, please read [`CLAUDE.md`](CLAUDE.md) in full before making any changes — it documents every architectural decision, naming convention, and guardrail in the codebase.

---

## License

Proprietary. All rights reserved.
