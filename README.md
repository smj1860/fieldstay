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
| **RepuGuard** | AI-generated review response drafts, bundled for all OwnerRez-connected accounts |
| **Crew Mobile** | Offline-first PWA for crew members powered by PowerSync SQLite sync |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router, Server Components, Server Actions) |
| Hosting | Vercel (IAD1 region) |
| Database | Supabase (PostgreSQL 15, Row Level Security, Realtime) |
| Auth | Supabase Auth (email + password) |
| Client Sync | PowerSync (offline-first SQLite, local-first reads) |
| Background Jobs | Inngest (durable step functions, crons, event-driven workflows) |
| Email | Resend + React Email |
| Payments | Stripe (subscriptions, webhooks, customer portal) |
| Rate Limiting | Upstash Redis |
| PMS Integration | OwnerRez (OAuth2 + webhooks) |
| Grocery API | Kroger (cart automation) |
| Geocoding | Mapbox |
| AI | Anthropic Claude (data plate OCR, RepuGuard draft generation) |

---

## Architecture Overview

```
Browser (PowerSync SQLite)
    ↕ sync rules / JWT
PowerSync Cloud
    ↕ replication
Supabase PostgreSQL (RLS on every table)
    ↕ Server Actions / Route Handlers
Next.js on Vercel
    ↕ events
Inngest (async workflows, crons)
    ↕ integrations
OwnerRez  ·  Stripe  ·  Resend  ·  Kroger  ·  Mapbox  ·  Anthropic
```

**Key architectural constraint:** Client components **never** read from Supabase directly. All client reads go through PowerSync's local SQLite layer. All mutations go through Next.js Server Actions or Route Handlers, which write to Supabase. PowerSync then streams changes back down.

---

## Prerequisites

- Node.js ≥ 18.17
- A Supabase project (free tier works for development)
- A PowerSync instance
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
npm install
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
NEXT_PUBLIC_POWERSYNC_URL=
INNGEST_EVENT_KEY=         # set to 'local' for inngest-cli dev
INNGEST_SIGNING_KEY=       # set to 'local' for inngest-cli dev
```

### 3. Apply database migrations

Run the migrations in order against your Supabase project:

```bash
# In the Supabase SQL editor, or using the CLI:
psql $DATABASE_URL -f fieldstay_migration_v1.sql
psql $DATABASE_URL -f fieldstay_migration_v2.sql
```

> All migrations are idempotent. Re-running them is safe.

> `fieldstay_migration_v1.sql`/`v2.sql` are superseded — current schema additions live as timestamped files in [`supabase/migrations/`](supabase/migrations/), including `20260618000002_baseline_schema_snapshot.sql`, which backfills CREATE TABLE/RLS/constraints/indexes/policies/grants for tables that predate this migration history. See `supabase/schema_reference.sql` for the full live-schema reference.

### 4. Generate TypeScript types

```bash
npm run types:supabase
```

This writes `types/supabase.ts` from the live schema. Re-run after every migration.

### 5. Start the development servers

**Terminal 1 — Next.js:**
```bash
npm run dev
```

**Terminal 2 — Inngest dev server (processes background jobs locally):**
```bash
npm run inngest:dev
```

The Inngest dev UI is available at `http://localhost:8288`.

App runs at `http://localhost:3000`.

---

## Available Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Next.js in development mode |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run inngest:dev` | Start Inngest local dev server |
| `npm run types:supabase` | Regenerate Supabase TypeScript types from live schema |

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
│   └── api/
│       ├── inngest/        # Inngest serve() handler
│       ├── webhooks/       # Stripe + OwnerRez webhook handlers
│       └── integrations/   # OAuth callback handlers
├── lib/
│   ├── supabase/           # Supabase client factory (server, client, service)
│   ├── inngest/            # Inngest client, event types, all functions
│   ├── powersync/          # PowerSync schema + sync rules
│   ├── stripe/             # Stripe client + helpers
│   ├── email/              # React Email components
│   └── kroger/             # Kroger API client
├── types/
│   ├── database.ts         # Hand-maintained DB types (being migrated to generated)
│   └── supabase.ts         # Generated from schema — do not edit manually
├── fieldstay_migration_v1.sql   # Initial schema
├── fieldstay_migration_v2.sql   # Incremental schema updates
└── CLAUDE.md               # AI coding assistant instructions (read before touching code)
```

---

## Key Conventions

**Never break these.** See [`CLAUDE.md`](CLAUDE.md) for the full rule set.

- Every database table has RLS enabled. No exceptions.
- Client components read from PowerSync's local SQLite only — never call Supabase directly from the browser.
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

**Security headers** are set globally in `vercel.json`: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Strict-Transport-Security`, and a restrictive `Content-Security-Policy`.

**Required environment variables in Vercel:** All variables from `.env.example` must be set in your Vercel project settings before deploying. The app will deploy silently with missing optional keys but will fail at runtime when that feature is first used.

---

## Integrations

### OwnerRez (PMS)
OAuth2 connection. After connecting, FieldStay syncs properties and bookings via the OwnerRez API and receives booking events via webhook. See [`CLAUDE_INTEGRATIONS.md`](CLAUDE_INTEGRATIONS.md) for full setup.

### Stripe
Subscription billing. Webhook endpoint: `/api/webhooks/stripe`. Always uses `constructEvent()` for signature verification.

### PowerSync
Offline-first sync. The sync rules determine which rows from Supabase are replicated to each user's local SQLite database. Rules are scoped by `org_id` to enforce tenant isolation at the sync layer.

### Kroger
Cart automation for inventory restocking. OAuth2 connection per organization. Cart is built automatically when inventory items drop below par level.

---

## Contributing

This is a private repository. If you have access, please read [`CLAUDE.md`](CLAUDE.md) in full before making any changes — it documents every architectural decision, naming convention, and guardrail in the codebase.

---

## License

Proprietary. All rights reserved.
