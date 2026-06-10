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
│  PowerSync SQLite (local-first reads — zero latency)             │
└──────────────┬───────────────────────────────────────────────────┘
               │ sync rules (JWT-scoped per org)
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  PowerSync Cloud                                                 │
│  (replication layer — Supabase → SQLite)                        │
└──────────────┬───────────────────────────────────────────────────┘
               │ replication
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Supabase PostgreSQL                                             │
│  RLS on every table · get_user_org_ids() · is_org_member()      │
└──────────────┬───────────────────────────────────────────────────┘
               │ Server Actions / Route Handlers
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Next.js 15 on Vercel (IAD1)                                    │
│  App Router · Server Components · Server Actions                 │
└──────────────┬───────────────────────────────────────────────────┘
               │ inngest.send() / webhook events
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  Inngest                                                         │
│  Durable step functions · cron jobs · event-driven workflows     │
└──────────────┬───────────────────────────────────────────────────┘
               │ third-party API calls
               ▼
  OwnerRez · Stripe · Resend · Kroger · Mapbox · Anthropic · Upstash
```

---

## The Local-First Constraint

**The client never reads from Supabase directly.** This is an absolute architectural constraint enforced in code review.

All client reads go through PowerSync's local SQLite database. PowerSync maintains a background sync connection and keeps the local database current with the user's Supabase data. This means:

- All reads are zero-latency (SQLite is local)
- The app works offline (reads still function without network)
- UI reactivity is driven by local SQLite subscriptions, not Supabase Realtime
- Sync rules enforce tenant isolation at the data layer — a user's local SQLite contains only their org's data

**All writes go through the server.** Client components trigger Server Actions, which write to Supabase. PowerSync then streams the change back to the client's local SQLite. This means the client never has write access to Supabase directly.

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
                            PowerSync streams change back
                            to client SQLite
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
5. PowerSync propagates the changes to the client

### Key Automated Workflows

| Event | Trigger | Automation |
|---|---|---|
| `turnover/completed` | PM marks turnover complete | Post cleaning fee to `owner_transactions`; optionally trigger inventory restock check |
| `work_order/completed` | WO marked complete | Post actual cost to `owner_transactions` |
| `purchase_order/approved` | PO approved | Post inventory purchase cost to `owner_transactions` per property |
| `booking/confirmed` | OwnerRez webhook or iCal sync | Post booking revenue to `owner_transactions`; schedule guest messages |
| `maintenance_schedule/due` | Inngest cron (daily) | Create `work_orders` for due schedules; notify assigned vendor |
| `vendor_compliance/expiring` | Inngest cron (daily) | Email PM and vendor; set `first_warned_at` |
| `vendor_compliance/hard_blocked` | Inngest cron (daily) | Block vendor from WO assignment |
| `inventory/cart_requested` | Below-par inventory scan | Build Kroger cart; notify PM |
| `asset/health_score_critical` | Asset health scoring | Alert PM; create maintenance WO |

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

## Data Sync Architecture (PowerSync)

### Sync Rules Design Principle

Sync rules define **what data each user gets in their local SQLite**. The rules are scoped by `org_id`:

- A crew member gets only their assigned turnovers, the relevant properties, and their own checklist instances
- A manager gets all turnovers, WOs, inventory, and financials for their org
- Owner portal users get only their property's financial data (separate token-based flow, not PowerSync)

### What Stays Server-Side

The following **never** enters the PowerSync sync stream:
- `SUPABASE_SERVICE_ROLE_KEY` usage or results
- Stripe data (subscription status is synced via the `organizations` table, not raw Stripe objects)
- Vendor compliance documents (file contents)
- Owner portal tokens
- Inngest event payloads

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
  → grace_period     (expired 1–30 days → soft block + acknowledgement required)
  → hard_blocked     (expired 31+ days → no WO assignment possible)
```

The state is computed in the `vendor_compliance_status` VIEW. Application code should query the view, not the raw `vendor_compliance_documents` table.

---

## Security Boundaries

| Boundary | Enforcement |
|---|---|
| Tenant data isolation | RLS on every table; PowerSync sync rules scoped by `org_id` |
| Service role access | `createServiceClient()` only in Inngest steps and specific server Route Handlers |
| Client-side reads | PowerSync SQLite only — Supabase client never called from browser |
| Webhook authenticity | Stripe: `constructEvent()` HMAC verification; OwnerRez: Basic Auth |
| Crew WO completion | Tokenized URL — no session required, token validated server-side |
| Owner portal access | Tokenized URL — no session required, token validated server-side; read-only data |
| Rate limiting | Upstash Redis on AI endpoints (data plate OCR, RepuGuard generation) |

---

## Third-Party Integration Architecture

### OwnerRez

OAuth2 flow stores tokens in `organizations` table. Incoming webhooks use Basic Auth (credentials set by us in the OwnerRez portal, stored in env vars). Webhook deduplication is done via payload ID before any processing occurs.

### Stripe

Subscription lifecycle managed via webhooks. The app reads plan/status from the `organizations` table (synced from Stripe via webhook handler). No Stripe API calls happen client-side — billing portal redirects go through a Server Action.

### PowerSync ↔ Supabase

PowerSync connects to Supabase using a dedicated read-only replication user. The sync rules file (`powersync.yaml` or equivalent) defines the sync scope. Never add tables to sync rules without reviewing what data they expose to the client.

### Anthropic

Used for two features: data plate OCR (asset scanning) and RepuGuard review response generation. Both endpoints are gated behind rate limiting and require valid session auth. API key is server-side only — never exposed to the client.
