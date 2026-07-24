# FieldStay — Architecture

This document describes the system architecture, data flow, and the reasoning behind key design decisions. It is intended for engineers onboarding to the codebase and for architectural review.

For coding conventions and guardrails, see [`CLAUDE.md`](CLAUDE.md). For integration-specific details, see [`CLAUDE_INTEGRATIONS.md`](CLAUDE_INTEGRATIONS.md).

---

## System Overview

FieldStay is a **local-first, event-driven, multi-tenant SaaS** application. These three properties drive almost every architectural decision in the stack.

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser / PWA (Crew Mobile)                                     │
│                                                                  │
│  React Server Components (read-only, server-rendered)            │
│  React Client Components (interactive)                           │
│  Dexie.js IndexedDB (local-first reads — zero latency)          │
│  Mutation outbox → SyncEngine → Server Actions / Route Handlers  │
└──────────────┬───────────────────────────────────────────────────┘
               │ pull sync / mutation drain
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Next.js 16 on Vercel (IAD1)                                    │
│  App Router · Server Components · Server Actions                 │
└──────────────┬───────────────────────────────────────────────────┘
               │ queries (RLS enforced)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Supabase PostgreSQL                                             │
│  RLS on every table · get_user_org_ids() · is_org_member()      │
└──────────────┬───────────────────────────────────────────────────┘
               │ inngest.send() / webhook events
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Inngest                                                         │
│  Durable step functions · cron jobs · event-driven workflows     │
└──────────────┬───────────────────────────────────────────────────┘
               │ third-party API calls
               ▼
  OwnerRez · Stripe · Resend · Telnyx · Kroger · Mapbox · Anthropic
  Tomorrow.io · Hostaway · Upstash
```

---

## The Local-First Constraint

The crew PWA client never reads from Supabase directly. This is an absolute
architectural constraint enforced in code review.

All client reads in `app/crew/*` go through Dexie.js, a local IndexedDB database
maintained by `lib/dexie/`. A custom sync service (`lib/dexie/syncService.ts`) pulls
data from Supabase on a polling interval and on reconnect, keeping Dexie current.
This means:

- All reads are zero-latency (IndexedDB is local)
- The crew app works offline — checklists, inventory counts, and photos all function
  without network access
- UI reactivity is driven by `useLiveQuery` hooks on Dexie tables, not Supabase Realtime
- Tenant isolation is enforced server-side by RLS on every Supabase query the sync
  engine makes — the client never queries Supabase directly

All writes go through the server. Crew client components enqueue mutations into a local
`mutations` outbox table in Dexie. `SyncEngine` drains the outbox in insertion order,
pushing each mutation to Supabase via Server Actions or Route Handlers, retrying on
failure and stopping the drain on first error (to prevent out-of-order writes).

**Note:** The PM dashboard (`app/(dashboard)/*`) reads from Supabase directly via
Server Components and Server Actions — Dexie is scoped to the crew PWA only.

---

## Multi-Tenancy

The organizational unit is `organizations`. Every data table has an `org_id` foreign key and RLS policies that enforce isolation.

### RLS Helper Functions

```sql
-- Used in SELECT policies
-- Returns all org_ids the current JWT user belongs to
get_user_org_ids() → uuid[]

-- Used in INSERT/UPDATE/DELETE policies
-- Returns true if the current user has one of the required roles in the given org
-- 'owner' role always passes regardless of the roles array
is_org_member(org_id uuid, roles member_role[]) → boolean
```

### Role Hierarchy

```
admin    — full org management, billing, member invite
manager  — property and crew management, financial visibility
crew     — turnover and WO completion via mobile PWA
viewer   — read-only dashboard access
owner    — property owner; read-only portal access (tokenized, not session-based)
```

The `owner` role is special: it always passes `is_org_member()` regardless of the role array. This reflects the reality that property owners have financial visibility rights that managers cannot revoke by accident.

---

## Request / Response Flow

### Server Actions (mutations)

```
Client Component
  → onClick → Server Action (app/(dashboard)/*/actions.ts)
    → requireOrgMember()         ← validates session + org membership
    → createServerClient()       ← uses anon key, RLS enforced
    → supabase.from('table').insert(...)
    → (optionally) inngest.send('entity/action', { data })
    → return { success: true, data }
                                        ↓
                            Dexie sync pulls change back
                            to local IndexedDB on next interval
```

### Route Handlers (webhooks, OAuth callbacks, token-gated routes)

```
External POST (Stripe, OwnerRez, crew app)
  → app/api/webhooks/*/route.ts
    → Verify signature / Basic Auth / token
    → createServiceClient()      ← bypasses RLS for trusted payloads
    → DB write
    → (optionally) inngest.send(...)
    → return 200
```

### Background Jobs (Inngest)

```
inngest.send('entity/action', { data: { org_id, ... } })
  → Inngest queues the event
  → POST to /api/inngest
    → lib/inngest/functions/my-function.ts
      → step.run('step-name', async () => {
          const supabase = createServiceClient()  ← service role in Inngest only
          // idempotent work
        })
      → step.run('next-step', ...)
```

---

## Event-Driven Automation

FieldStay uses Inngest as the event bus and workflow engine. The pattern is:

1. A user action or external webhook fires a Supabase write
2. The server action or webhook handler calls `inngest.send('entity/action', payload)`
3. Inngest durably executes the workflow in steps
4. Each step writes back to Supabase
5. Dexie sync pulls the changes to the crew PWA's local IndexedDB on the next interval

### Key Automated Workflows

| Event | Trigger | Automation |
|---|---|---|
| `turnover/completed` | PM marks turnover complete | Post cleaning fee to `owner_transactions`; trigger inventory restock check |
| `work_order/created` | WO created with vendor assigned | Generate completion token; send vendor dispatch email with portal link |
| `work-order/vendor.assigned` | Vendor assigned to existing WO | Generate completion token if absent; send dispatch email to new vendor |
| `work-order/crew.assigned` | Crew member assigned to WO | WO surfaces in crew app via Dexie sync (push notification scaffolded) |
| `work-order/crew.completed` | Crew marks WO complete in PWA | Notify PM via email |
| `work_order/completed` | WO signed off via vendor portal | Post actual cost to `owner_transactions` |
| `purchase_order/approved` | PO approved | Post inventory purchase cost to `owner_transactions` per property |
| `booking/confirmed` | OwnerRez webhook or iCal sync | Post booking revenue to `owner_transactions`; schedule guest messages |
| `maintenance_schedule/due` | Inngest cron (daily) | Create `work_orders` for due schedules; notify assigned vendor |
| `vendor_compliance/expiring` | Inngest cron (daily) | Email PM and vendor; set `first_warned_at` |
| `vendor_compliance/hard_blocked` | Inngest cron (daily) | Block vendor from WO assignment |
| `inventory/cart_requested` | Below-par inventory scan | Build Kroger cart; notify PM |
| `asset/health_score_critical` | Asset health scoring | Alert PM; create maintenance WO |
| `guidebook/sponsor.payment.succeeded` | Stripe invoice paid | Activate sponsor slot; apply plan credit if threshold met |
| `guidebook/sponsor.deactivated` | Subscription cancelled or lapsed | Deactivate slot; set grace period; notify PM |
| `guidebook/guest.opted.in` | Guest submits SMS opt-in form | Send door code + WiFi + portal link via Telnyx SMS (atomic claim) |
| `guidebook/stay.extension.request` | Gap night cron detects qualifying gap | Send extension offer SMS to opted-in guest; notify PM |
| `ownerrez/initial-sync` | PM connects OwnerRez account | Sync all properties, bookings, reviews; register webhooks; create guidebook configs |
| `repuguard/batch.generate` | PM requests batch generation | AI-generate review responses for all pending reviews (Claude Sonnet) |

### Idempotency

Every Inngest step that creates a database record is idempotent. The `owner_transactions` table uses `source_reference_id` (the ID of the triggering entity) as a uniqueness key. Other tables use `ON CONFLICT DO NOTHING` or explicit pre-insert existence checks. A step that retries must never create duplicate records, double-bill, or send duplicate emails.

---

## Authentication Flow

```
User visits protected route
  → proxy.ts middleware
    → updateSession(request)     ← refreshes Supabase session cookie
    → user = null?
      → redirect to /login?next=/original-path
    → user exists, route is public (e.g. /login)?
      → redirect to /ops
    → otherwise: pass through
```

Token-gated routes (owner portal `/owner/[token]`, crew WO completion `/work-orders/[token]/complete`) bypass the session middleware entirely. They authenticate via signed tokens validated server-side.

---

## Data Sync Architecture (Dexie.js)

The crew PWA uses a hand-rolled local-first sync layer built on Dexie.js (IndexedDB).
This replaced an earlier PowerSync-based design. The core components are:

**`lib/dexie/schema.ts`** — `FieldStayDexie` class defining all local tables.
Table shapes mirror their Supabase counterparts. Current tables: `turnovers`,
`properties`, `checklist_instances`, `checklist_instance_items`, `inventory_items`,
`crew_work_orders`, `crew_availability`, `messages`, `turnover_issue_reports`,
`pending_photo_uploads`, `mutations`, `sync_meta`.

**`lib/dexie/context.tsx`** — `DexieProvider` runs the pull sync cycle. On mount
and on reconnect, it fetches the crew member's assigned data from Supabase and writes
it into the local Dexie tables. Polling interval keeps data fresh during active sessions.

**`lib/dexie/syncService.ts`** — `SyncEngine` manages the mutation outbox. Writes
are enqueued locally first, then drained in order to Supabase via Server Actions or
Route Handlers. On network failure, the drain stops and retries — later mutations
against the same record are never applied out of order.

**`lib/dexie/photo-sync.ts`** — Handles deferred photo uploads from the crew PWA.
Photos are stored locally first, then uploaded to Supabase Storage when connectivity
is available.

### What Stays Server-Side

The following never enters the Dexie sync stream or the client IndexedDB:

- `SUPABASE_SERVICE_ROLE_KEY` usage or results
- Stripe data (subscription status is synced via the `organizations` table only)
- Vendor compliance documents (file contents)
- Owner portal tokens
- Inngest event payloads
- Guidebook WiFi passwords (served via tokenized server-rendered portal only)
- Guest phone numbers (never passed to client components)

### Crew Data Scoping

The sync service fetches only data relevant to the authenticated crew member:

- Turnovers assigned to this crew member (current + next 14 days)
- Properties for those turnovers
- Checklist instances and items for those turnovers
- Inventory items for those properties
- Work orders where `assigned_crew_member_id` = this crew member
- Messages where this crew member is a participant

---

## Database Design Decisions

### `organization_members` vs `memberships`

The join table is `organization_members`. `memberships` does not exist. This is the single most common cause of silent auth failures in the codebase. Every new query must use `organization_members`.

### `assigned_crew_member_id` vs `assigned_crew_id`

Work orders use `assigned_crew_member_id`. The old column `assigned_crew_id` is deprecated and does not exist in the current schema.

### `source_reference_id` on `owner_transactions`

This is the idempotency key for the financial ledger. Every automated transaction insert checks for an existing row with the same `source` + `source_reference_id` pair before inserting. This prevents double-posting if an Inngest step retries.

### Vendor Compliance State Machine

```
compliant
  → expiring_soon    (expires within 30 days → email warning)
  → grace_period     (expired 1–45 days → soft block + acknowledgement required)
  → hard_blocked     (expired 46+ days → no WO assignment possible)
```

The state is computed in the `vendor_compliance_status` VIEW. Application code should query the view, not the raw `vendor_compliance_documents` table.

---

## Security Boundaries

| Boundary | Enforcement |
|---|---|
| Tenant data isolation | RLS on every table; Dexie sync engine queries scoped by `org_id` server-side |
| Service role access | `createServiceClient()` only in Inngest steps and specific server Route Handlers |
| Client-side reads (crew PWA) | Dexie.js IndexedDB only — Supabase client never called from the browser; all reads go through the local cache |
| Webhook authenticity | Stripe: `constructEvent()` HMAC; OwnerRez: Basic Auth; Telnyx: ed25519 signature verification (`createVerify('ed25519')` over `timestamp\|body`) |
| Crew WO completion | Tokenized URL — no session required, token validated server-side |
| Owner portal access | Tokenized URL — no session required, token validated server-side; read-only data |
| Rate limiting | Upstash Redis on AI endpoints (data plate OCR, RepuGuard generation) |

---

## Third-Party Integration Architecture

### OwnerRez (PMS)

OAuth2 flow stores tokens in Supabase Vault via `integration_connections`. Incoming
webhooks use Basic Auth (credentials set in the OwnerRez portal, stored in env vars).
Webhook deduplication via `ownerrez_processed_webhooks` table before any processing.

Initial sync fans out per-property for external API calls (one memoized Inngest step
per property) to ensure retries only re-run failed properties, not the full portfolio.

Synced data: properties (with amenity flags from `GET /v2/listings`), bookings,
guest reviews. WiFi credentials and guest instructions come from the listings endpoint
— not the property detail endpoint.

### Stripe

Subscription lifecycle managed via webhooks. The app reads plan/status from the `organizations` table (synced from Stripe via webhook handler). No Stripe API calls happen client-side — billing portal redirects go through a Server Action.

### Telnyx (SMS)

A2P 10DLC messaging for guest SMS delivery. Webhook endpoint: `/api/webhooks/telnyx`.
Signature verification uses ed25519 (`TELNYX_WEBHOOK_PUBLIC_KEY` env var). Handles
STOP/START/HELP keywords with TCPA-compliant consent writes to
`guidebook_guest_sms_optins`. All sends are gated on `SMS_ENABLED=true` — do not
enable until 10DLC campaign verification clears.

### Tomorrow.io (Weather)

Real-time and forecast weather used by the guidebook morning/evening SMS crons.
Rain probability and temperature determine which sponsor slot type fires and whether
a rain-alert override takes precedence over a dinner recommendation.

### Hostaway (PMS)

OAuth2 connection with API key auth. Property and booking sync adapter built at
`lib/inngest/functions/hostaway/`. Integration listing pending marketplace approval.

### Dexie.js ↔ Supabase

The crew PWA's local-first sync layer. Dexie.js (IndexedDB) holds a scoped local
cache of the crew member's data. `SyncEngine` (`lib/dexie/syncService.ts`) drains
a local `mutations` outbox to Supabase and pulls remote changes back down on a
polling interval. Tenant isolation is enforced server-side by RLS on every Supabase
query the sync engine makes — the client never queries Supabase directly.

Never add tables to the Dexie schema without considering:
1. What data they expose to the client IndexedDB (no secrets, no PII beyond what crew needs)
2. Whether the sync service needs a corresponding pull query in `DexieProvider`
3. Whether a mutation handler is needed in `SyncEngine`

### Anthropic

Used for two features: data plate OCR (asset scanning) and RepuGuard review response generation. Both endpoints are gated behind rate limiting and require valid session auth. API key is server-side only — never exposed to the client.
