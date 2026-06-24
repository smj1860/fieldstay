# FieldStay — Claude Code Instructions

Read this file in full before touching any code. It contains the decisions,
patterns, and guardrails that govern this entire codebase. Violations here
create bugs that are expensive to find and fix.

---

## What FieldStay Is

A local-first property operations platform for short-term rental managers.
Target user: a PM managing 10–50 STR properties who needs automated turnovers,
crew scheduling, vendor management, owner reporting, and inventory restocking
without the overhead of enterprise software.

**The core automation promise:** FieldStay removes cognitive overhead — not
just records things. When a turnover completes, expenses post automatically.
When inventory drops below par, a Kroger cart builds itself. When a WO is
created from a maintenance schedule, the right vendor is selected and notified.

---

## Tech Stack — Non-Negotiable

| Layer | Tool | Notes |
|---|---|---|
| Framework | Next.js 14+ App Router | Server Components, Server Actions, Route Handlers |
| Hosting | Vercel | Edge runtime where applicable |
| Database | Supabase (PostgreSQL) | RLS on every table, no exceptions |
| Auth | Supabase Auth | `createServerClient` from `@supabase/ssr` |
| Sync | Dexie (IndexedDB) | Crew PWA reads/writes local IndexedDB only — never Supabase directly for reads |
| Background jobs | Inngest | All async work, crons, multi-step workflows |
| Email | Resend + React Email | Transactional only, never marketing |
| Payments | Stripe | Webhook signature verification required |
| Retailer API | Kroger API | Cart automation for below-par inventory |
| Geocoding | Mapbox | Properties and vendors — one call on save |

**Never introduce:** Vite, Turborepo, tRPC, Prisma, or any ORM.
**Never add** client-side Supabase reads that bypass the Dexie local-first sync layer
in the crew PWA (`lib/dexie/*`).

---

## Critical Security Rules

These are non-negotiable. Violating them creates security vulnerabilities or
data leaks that could expose tenant data.

### 1. Service Role Key
- `SUPABASE_SERVICE_ROLE_KEY` is used ONLY in Inngest steps and specific
  server-side route handlers where RLS must be bypassed intentionally.
- Never pass it to client components, never return it in API responses,
  never log it.
- Use `createServiceClient()` from `lib/supabase/server.ts` for service role.
- Use `createServerClient()` from `lib/supabase/server.ts` for normal auth.

### 2. Row Level Security
- **Every table has RLS enabled.** No exceptions. If you create a table,
  immediately add `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` and write
  SELECT, INSERT, UPDATE, DELETE policies.
- All policies use these two helper functions:
  ```sql
  -- Read access: returns all org IDs the current user belongs to
  get_user_org_ids()

  -- Write access: checks role membership
  -- IMPORTANT: 'owner' role ALWAYS passes, regardless of p_roles array
  is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])
  ```
- Standard policy template:
  ```sql
  CREATE POLICY "table_select"
    ON my_table FOR SELECT
    USING (org_id IN (SELECT get_user_org_ids()));

  CREATE POLICY "table_manage"
    ON my_table FOR ALL
    USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  ```

### 3. Stripe Webhooks
Always verify signature. No exceptions.
```typescript
const event = stripe.webhooks.constructEvent(
  rawBody,
  req.headers.get('stripe-signature')!,
  process.env.STRIPE_WEBHOOK_SECRET!
)
```

### 4. Tenant Isolation
- Every query that touches `org_id` must scope to the authenticated user's org.
- Never query without an `org_id` filter unless the table is explicitly public.
- Use `requireOrgMember()` from `lib/auth` as the first line of every Server
  Action and Route Handler that touches org data.

---

## The Table That Breaks Everything If Wrong

```
CORRECT:  organization_members
WRONG:    memberships  ← this table does NOT exist
```

Any `.from('memberships')` anywhere in the codebase is a bug. Audit and fix
before running any feature work. The query to find them:
```bash
grep -r "from('memberships')" --include="*.ts" --include="*.tsx" .
```

---

## Database Schema

### Auth & Org Structure
```
profiles                    — extends auth.users (id = auth.uid())
organizations               — tenant root. Has plan, auto_assign_mode, preferred_retailer,
                              kroger OAuth fields, Uplisting API key
organization_members        — user ↔ org join. role: admin|manager|crew|viewer|owner
                              MUST have invite_accepted_at IS NOT NULL to pass RLS
org_invites                 — pending invitations
```

### Properties & Owners
```
properties                  — core property record. Has lat/lng, cleaning_cost,
                              same_day_premium_pct, square_footage, bedrooms
property_owners             — owner contact linked to a property
owner_portal_tokens         — signed tokens for owner portal access
owner_transactions          — P&L ledger. Has source, source_reference_id (idempotency),
                              visible_to_owner. source enum:
                              manual|wo_completion|booking_revenue|
                              uplisting_booking|inventory_purchase|cleaning_fee
```

### Turnovers & Crew
```
turnovers                   — Has turnover_status, is_same_day_turnover,
                              suggested_crew_ids, suggestion_reasoning, suggestion_status
turnover_assignments        — crew → turnover join
crew_members                — Has home_lat/lng, reliability_score, capacity_score
crew_availability           — crew marks available/unavailable by date
assignment_outcomes         — learning loop: PM accepts/overrides, duration from
                              checklist timestamps, pm_rating
```

### Work Orders
```
work_orders                 — canonical WO. Has wo_status, wo_category, priority_level,
                              wo_source, asset_id (links to property_assets),
                              assigned_crew_member_id (NOT assigned_crew_id — deprecated)
work_order_line_items       — labor/material line items
work_order_photos           — attached photos
work_order_updates          — status change log
wo_number_counters          — per-org WO number sequence
```

### Maintenance
```
maintenance_schedules       — Has auto_create_wo (DEFAULT TRUE), vendor_specialty_hint,
                              assigned_vendor_id, next_due_date, schedule_frequency
org_master_checklist_items  — seed checklist tasks (73 items, 7 sections)
org_master_maintenance_schedules — seed maintenance schedules
checklist_templates         — property-level checklist templates
checklist_template_sections
checklist_template_items
checklist_instances         — active checklist for a turnover
checklist_instance_items    — Has completed_at timestamp — used for duration tracking
```

### Inventory
```
inventory_catalog           — global seed catalog (115 items, 10 categories)
                              categories: paper_goods|cleaning|kitchen|bath|laundry|
                              outdoor|bedroom_linens|maintenance_safety|guest_experience|
                              technology|bedroom|other
inventory_templates         — org-level inventory template
inventory_template_items    — Has preferred_brand column
inventory_items             — property-level. Has preferred_brand (overrides template brand)
inventory_counts            — periodic count sessions
purchase_orders             — Has po_status: draft|sent|acknowledged|ordered|received|cancelled
purchase_order_items
```

### Vendors & Compliance
```
vendors                     — Has lat/lng/service_zip/service_radius_miles,
                              vendor_specialty enum:
                              plumbing|electrical|hvac|landscaping|cleaning|
                              pest_control|pool|roofing|general|other
vendor_compliance_documents — COI, licenses, bonding. Has expiry_date,
                              first_warned_at, hard_blocked_at
vendor_compliance_status    — VIEW. compliance_status:
                              compliant|expiring_soon|grace_period|hard_blocked
                              grace_period = expired 1–30 days (soft warn + ack)
                              hard_blocked = expired 31+ days (no WO assignment)
```

### Asset Health
```
asset_type_standards        — 21 asset types: lifespan ranges + replacement costs
property_assets             — asset ledger. Has health_score (0–100, cached),
                              macrs_class, placed_in_service_date, purchase_price,
                              warranty_expiry_date, is_active, replaced_by_asset_id
asset_depreciation_entries  — annual MACRS records. UNIQUE (asset_id, tax_year)
```

### Integrations & Comms
```
integration_providers       — registered OAuth providers
integration_connections     — org ↔ provider tokens
ical_feeds                  — calendar sync feeds per property
bookings                    — confirmed bookings (from iCal, OwnerRez, Uplisting, manual)
communication_logs          — all PM↔vendor/crew communication history
guest_message_templates     — automated guest messaging templates
guest_messages_sent
reviews / review_responses  — guest reviews + PM responses
```

### Supporting
```
org_milestones              — key-value store for org state flags + async job results
                              Used by PowerSync to surface Inngest job completions to UI
audit_events                — append-only audit log
push_subscriptions          — PWA push notification endpoints
oauth_states                — CSRF state tokens for OAuth flows
powersync_crew_*            — PowerSync-specific crew views (do not modify directly)
```

---

## All Enum Types (Use Exact Values)

```typescript
member_role:       'admin' | 'manager' | 'crew' | 'viewer' | 'owner'
turnover_status:   'pending_assignment' | 'assigned' | 'in_progress' |
                   'completed' | 'flagged' | 'cancelled'
wo_status:         'pending' | 'quote_requested' | 'assigned' |
                   'in_progress' | 'completed' | 'cancelled'
wo_category:       'hvac' | 'plumbing' | 'electrical' | 'appliance' |
                   'cleaning' | 'landscaping' | 'roofing' | 'flooring' |
                   'windows_doors' | 'pest_control' | 'pool' | 'structural' |
                   'general' | 'other'
wo_source:         'manual' | 'maintenance_schedule' | 'crew_flag' | 'guest_report'
priority_level:    'low' | 'medium' | 'high' | 'urgent'
vendor_specialty:  'plumbing' | 'electrical' | 'hvac' | 'landscaping' |
                   'cleaning' | 'pest_control' | 'pool' | 'roofing' |
                   'general' | 'other'
compliance_doc_type: 'coi' | 'workers_comp' | 'business_license' |
                   'contractor_license' | 'bonding' | 'other'
po_status:         'draft' | 'sent' | 'acknowledged' | 'ordered' |
                   'received' | 'cancelled'
txn_type:          'revenue' | 'expense'
txn_category:      'booking_revenue' | 'cleaning_fee' | 'maintenance' |
                   'restock' | 'utility' | 'insurance' | 'supplies' | 'other'
schedule_frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' |
                   'semi_annual' | 'annual'
asset_type:        'hvac' | 'water_heater' | 'roof' | 'refrigerator' |
                   'washer' | 'dryer' | 'dishwasher' | 'microwave' |
                   'oven_range' | 'pool_pump' | 'hot_tub' | 'garage_door' |
                   'smart_lock' | 'deck_structure' | 'electrical_panel' |
                   'plumbing_system' | 'septic_system' | 'well_pump' |
                   'generator' | 'solar_system' | 'other'
macrs_class:       '5_year' | '15_year' | '27_5_year' | '39_year' | 'section_179'
inventory_category: 'paper_goods' | 'cleaning' | 'kitchen' | 'bath' |
                   'laundry' | 'outdoor' | 'bedroom_linens' |
                   'maintenance_safety' | 'guest_experience' | 'technology' |
                   'bedroom' | 'other'
booking_source:    'airbnb' | 'vrbo' | 'booking_com' | 'direct' | 'manual' | 'other'
booking_status:    'confirmed' | 'cancelled' | 'blocked' | 'tentative'
org_plan:          'starter' | 'growth' | 'pro' | 'enterprise'
crew_role:         'cleaning' | 'landscaping' | 'maintenance' | 'general'
```

---

## Code Patterns — Follow These Exactly

### Authentication (Server Actions & Route Handlers)
```typescript
// Every server action that touches org data starts with this
import { requireOrgMember } from '@/lib/auth'

export async function myServerAction(data: MyInput) {
  const { user, supabase, membership } = await requireOrgMember()
  // user.id            ← authenticated user UUID
  // membership.org_id  ← their organization
  // membership.role    ← 'admin' | 'manager' | 'crew' | 'viewer' | 'owner'
  // membership.org     ← { name, plan, plan_status, max_properties, trial_ends_at }
  // supabase           ← scoped to authenticated user (RLS enforced)
  //
  // ⚠️  OrgMembership has NO user_id field.
  //     Use user.id for the authenticated user's UUID — never membership.user_id
}
```

### Supabase Clients
```typescript
// In server actions and route handlers — RLS enforced via auth cookie
import { createServerClient } from '@/lib/supabase/server'
const supabase = createServerClient()

// In Inngest steps and admin operations — bypasses RLS intentionally
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient()
```

### Dexie — Client-Side Data Access (Crew PWA)
The crew PWA (`app/crew/*`) is local-first, but it does **not** use PowerSync —
that was the original design and is referenced in `lib/dexie/*` code comments
purely as a frame of reference (those comments document which parts of the
PowerSync design Dexie's tables/sync logic mirror). The actual sync layer is a
hand-rolled Dexie (IndexedDB) cache plus a local mutation outbox:

- `lib/dexie/schema.ts` — `FieldStayDexie`, the Dexie database class. Table
  shapes mirror the Supabase tables they cache. Get an instance via
  `getDexieDb(userId)`.
- `lib/dexie/context.tsx` — `DexieProvider` pulls turnovers/properties/
  inventory/checklists/messages from Supabase into Dexie tables on an interval
  and on reconnect; client components read from Dexie, never from Supabase
  directly.
- `lib/dexie/syncService.ts` — `enqueueMutation()` queues a local write into
  the `mutations` outbox table and fires `SyncEngine.processOutbox()` in the
  background, which drains the outbox in insertion order and pushes each
  mutation to Supabase (or a Route Handler, for flows like turnover
  completion that need server-side side effects), retrying on failure and
  stopping the drain on first error so later mutations against the same
  record aren't applied out of order.

```typescript
// Client components read from the local Dexie cache, not Supabase directly
import { getDexieDb } from '@/lib/dexie/schema'
import { useLiveQuery } from 'dexie-react-hooks'

function MyComponent({ userId, propertyId }: { userId: string; propertyId: string }) {
  const turnovers = useLiveQuery(
    () => getDexieDb(userId).turnovers.where({ property_id: propertyId }).toArray(),
    [userId, propertyId],
  )
}

// Writes go through enqueueMutation(), which queues to the local outbox and
// syncs to Supabase in the background — this is the core local-first pattern
// for the crew PWA, never short-circuit it with a direct Supabase write.
import { enqueueMutation } from '@/lib/dexie/syncService'
await enqueueMutation(userId, 'turnovers', turnoverId, 'PATCH', { status: 'in_progress' })
```

The rest of the app (PM dashboard) reads Supabase directly via Server
Components/Server Actions per the patterns above — Dexie is scoped to the
crew PWA only.

### Inngest Functions

**File location:** ALL Inngest functions live at `lib/inngest/functions/`.
**Never** create them at `inngest/functions/` — that path does not exist in this repo.

```typescript
// Correct import path — always lib/inngest/functions/
import { myFunction } from '@/lib/inngest/functions/my-function'

export const myFunction = inngest.createFunction(
  { id: 'my-function-id', name: 'Human Readable Name', retries: 3 },
  { event: 'entity/action' },  // naming: entity/action e.g. turnover/completed
  async ({ event, step }) => {

    // Each step is independently retried — make them idempotent
    const result = await step.run('descriptive-step-name', async () => {
      // Do one atomic thing here
      // If this throws, Inngest retries only this step
      return data
    })

    await step.run('next-step', async () => {
      // Use result from previous step
    })
  }
)
```

**⚠️ MANDATORY — Register every new event in `lib/inngest/events.ts`:**
The Inngest client uses `EventSchemas().fromRecord<FieldStayEvents>()`.
TypeScript enforces at compile time that every event name used in `inngest.send()`
or `{ event: '...' }` is a declared key in `FieldStayEvents`. The build will fail
with a type error if you skip this. Every new function and every new `inngest.send()`
call requires a matching entry in `lib/inngest/events.ts` first.

```typescript
// lib/inngest/events.ts — add before using any new event name
export type FieldStayEvents = {
  // ... existing events ...

  'my-new/event': {      // ← add this BEFORE writing the function or send call
    data: {
      org_id:     string
      some_field: string
    }
  }
}
```

**After writing the function, register it in `app/api/inngest/route.ts`:**
```typescript
import { myFunction } from '@/lib/inngest/functions/my-function'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ...existingFunctions,
    myFunction,   // ← add here, inside the ONE serve() call
  ],
})
```
There must be exactly ONE `export const { GET, POST, PUT } = serve({...})` in that file.
Adding a second one causes a "defined multiple times" build error.

**Idempotency rule:** Any step that creates a database record must check
`source_reference_id` first for `owner_transactions`, or use `ON CONFLICT DO NOTHING`
for other tables. A step that runs twice must never create duplicate records.

### Inngest Event Naming
```
entity/action pattern:
turnover/completed          inventory/cart_requested
turnover/created            work_order/completed
work_order/created          purchase_order/approved
booking/confirmed           crew/assigned
maintenance_schedule/due    asset/health_score_critical
vendor_compliance/expiring  vendor_compliance/hard_blocked
```

### Error Handling in Server Actions
```typescript
export async function myAction(input: MyInput): Promise<ActionResult> {
  try {
    const { supabase, membership } = await requireOrgMember()
    // ... work
    return { success: true, data: result }
  } catch (err) {
    console.error('[myAction]', err)
    return { success: false, error: 'Descriptive message for the user' }
    // Never return raw error messages to the client
    // Never log PII or Stripe tokens
  }
}
```

### types/database.ts — Keep in Sync With Every Migration

**This is the most important housekeeping rule in the codebase.**

Whenever a DB migration adds or changes a column, update `types/database.ts`
in the same commit. The Supabase TypeScript client infers return types from
this file — not from the live database schema. A column that exists in the DB
but not in `types/database.ts` causes TypeScript build failures even when
the SQL query and select string are perfectly correct.

Pattern for every migration:
```typescript
// types/database.ts — find the matching interface and add the field

// For a nullable column added via migration:
export interface MyTable {
  // ... existing fields
  new_column: string | null    // ← add here, matching DB nullability
}

// For a required column with a default:
export interface MyTable {
  new_column: string           // ← non-null if DB has NOT NULL DEFAULT
}
```

Tables most likely to need updates as new features are built:
- `property_assets` — all asset health fields
- `vendor_compliance_documents` — compliance vault fields
- `asset_depreciation_entries` — CapEx/depreciation fields
- `organization_members`, `organizations` — any new org-level settings

### Geocoding (Mapbox) — One Call on Save
```typescript
// Called in createProperty and updateProperty server actions
// when address or zip changes. Stored on properties.lat / properties.lng
// Same pattern for vendors: vendors.lat / vendors.lng

async function geocodeZip(zip: string): Promise<{ lat: number; lng: number } | null> {
  const token = process.env.MAPBOX_PUBLIC_TOKEN
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${zip}.json?country=US&types=postcode&access_token=${token}`
  const res = await fetch(url)
  if (!res.ok) return null
  const data = await res.json()
  const [lng, lat] = data.features?.[0]?.center ?? []
  return lat && lng ? { lat, lng } : null
}
```

---

## TypeScript Rules

- **No `any`** — use concrete types or generics
- **No `unknown` without a type guard** — narrow it before use
- **Strict null checks** — handle every nullable DB field explicitly
- **Server/Client boundary** — never import server-only code into client components.
  Mark server-only files with `import 'server-only'` at the top.
- **React Server Components** — use for all data fetching. Pass data as props to
  Client Components. Client Components are opt-in with `'use client'`.

---

## Styling Conventions

- **CSS variables** for all colors — never hardcode hex in components
  ```tsx
  style={{ color: 'var(--text-primary)' }}
  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
  style={{ color: 'var(--text-muted)' }}
  style={{ color: 'var(--accent-gold)' }}
  ```
- **Tailwind core utilities** for layout, spacing, flex/grid — no custom compiler
- **No `@apply` in component files** — inline styles or className for variants
- Dark navy aesthetic. The app looks like serious professional tooling, not a pastel SaaS.

---

## Files Written — Commit These First

These files exist in the project context and need to be committed to the correct
paths with imports verified against actual path aliases:

| File | Location |
|---|---|
| Kroger API types | `lib/kroger/types.ts` |
| Kroger API client | `lib/kroger/client.ts` |
| Shopping cart Inngest function | `lib/inngest/functions/build-shopping-cart.ts` |
| Kroger OAuth initiate | `app/api/kroger/connect/route.ts` |
| Kroger OAuth callback | `app/api/kroger/callback/route.ts` |
| triggerShoppingCart() server action | `app/(dashboard)/inventory/actions.ts` (add to existing) |
| CartReadyBanner component | `app/(dashboard)/inventory/inventory-portfolio.tsx` (add to existing) |

After committing, register `buildShoppingCart` in `app/api/inngest/route.ts`
alongside existing Inngest functions.

**Environment variables required for Kroger:**
```
KROGER_CLIENT_ID=
KROGER_CLIENT_SECRET=
MAPBOX_PUBLIC_TOKEN=
```

---

## What to Do First — In This Order

### Step 0: Audit (do before any feature work)
```bash
grep -rn "from('memberships')" --include="*.ts" --include="*.tsx" src/ app/ lib/
```
Replace every hit with `from('organization_members')`. This is the single most
common cause of silent auth failures across the entire codebase.

### Step 1: Mobile Layout Fixes
- Property setup wizard: step nav sidebar + content panel must stack vertically
  on mobile (< 640px). Currently renders side-by-side and clips content off-screen.
- Onboarding wizard step 3 (Inventory): the two-column layout clips off the right
  edge on narrow screens. Stack vertically at < 640px.

### Step 2: Property Card Financial Fields
Add `cleaning_cost`, `same_day_premium_pct`, and `square_footage` to:
- Property detail view (display + edit)
- Property setup wizard step 1 (initial capture)

These fields exist in the DB. This is pure UI work.

### Step 3: Financial Automation Inngest Functions
Four functions, all following the same pattern:

**turnover/completed → cleaning fee expense**
- Read `property.cleaning_cost`
- If `turnover.is_same_day_turnover = true`, apply `property.same_day_premium_pct`
- INSERT into `owner_transactions` with `source = 'cleaning_fee'`, `source_reference_id = turnover.id`
- Idempotency: skip if a row already exists with that `source_reference_id`

**work_order/completed → expense**
- Read `work_order.actual_cost`
- INSERT `owner_transactions` with `source = 'wo_completion'`, `source_reference_id = work_order.id`

**purchase_order/approved → expense**
- INSERT `owner_transactions` per property with `source = 'inventory_purchase'`, `source_reference_id = purchase_order.id`

**booking/confirmed → revenue** (OwnerRez and Uplisting paths)
- INSERT `owner_transactions` with `source = 'booking_revenue'` or `'uplisting_booking'`
- `source_reference_id = booking.id`

---

## Current Roadmap Reference

Full roadmap with sprint order: `FIELDSTAY_MASTER_ROADMAP.md`

Current state summary:
- **28 DB migrations applied** — schema is ahead of codebase
- **7 files written** — need commit (listed above)
- **Step 0–3 above** = immediate unblocked work
- **Auto-assignment scoring engine** = Sprint 2 (after geocoding)
- **Owner Portal automation** = Sprint 3
- **Asset Health module** = Sprint 5

---

## Things That Will Break If You Do Them

| Don't do this | Do this instead |
|---|---|
| `.from('memberships')` | `.from('organization_members')` |
| `assigned_crew_id` on work_orders | `assigned_crew_member_id` (old column deprecated) |
| `membership.user_id` in server actions | `user.id` — OrgMembership has no user_id field. Destructure `user` from `requireOrgMember()` |
| `supabase.raw('column_name')` | Does not exist on Supabase JS client. For column-to-column comparisons (e.g. `current_quantity < par_level`), fetch the rows and filter in JavaScript |
| Adding a DB column via migration without updating `types/database.ts` | Every migration that adds a column must also add that column to the matching interface in `types/database.ts` in the same commit. Supabase's TS client infers return types from this file, not from the live DB. Missing columns here cause build failures even when the query and select string are correct |
| Adding a new event to `events.ts` outside the closing `}` of `FieldStayEvents` | The final `}` in `events.ts` closes the `FieldStayEvents` type. Every new event entry must be placed before it, with a comma after the preceding entry's closing brace |
| `.modify(q => ...)` on a Supabase query | Not a real method. Build the query conditionally with `if` blocks before awaiting it |
| Direct Supabase reads in crew PWA client components (`app/crew/*`) | Dexie (`getDexieDb` / `useLiveQuery`) reading the local IndexedDB cache |
| Service role key in client code | Server Actions and Inngest steps only |
| Hardcoded colors in components | CSS variables (`var(--text-primary)` etc.) |
| Creating a table without RLS | Always `ENABLE ROW LEVEL SECURITY` + policies |
| Multiple Inngest steps creating same record | Check `source_reference_id` first |
| `any` type | Explicit interface or generic |
| Logging `actual_cost`, email, Stripe tokens | Never log PII or financial data |
| Checking `role = 'admin'` manually | Use `is_org_member()` — it handles `owner` automatically |
| Skipping Stripe webhook signature verification | Always `constructEvent()` first |
| Using a new event name in `inngest.send()` without registering it | Add to `FieldStayEvents` in `lib/inngest/events.ts` first — build fails with type error if missing |
| Creating Inngest functions at `inngest/functions/` | All functions live at `lib/inngest/functions/` |
| Adding a second `export const { GET, POST, PUT } = serve({...})` to the Inngest route | There is exactly ONE serve() call in `app/api/inngest/route.ts` — add functions to its array |

---

## Supabase Project Reference

Project ID: `vpmznjktllhmmbfnxuvk`
Region: Check dashboard — US East
Auth: Email + password. Supabase Auth. No social providers currently.

Key functions in `public` schema:
- `is_org_member(p_org_id uuid, p_roles member_role[])` — **'owner' role always passes**
- `get_user_org_ids()` — returns array of org IDs for current user

---

## Database Migrations & Schema Drift

**Current status:** the live project (`vpmznjktllhmmbfnxuvk`) has **64 tracked
migrations** applied directly (from `20260524165615_fieldstay_v1_extensions_enums`
through `20260609213733_grant_missing_tables_vendor_address`). The local
`supabase/migrations/` directory only contains 4 files
(`20260601000000_repuguard.sql`, `20260602000000_team_access.sql`,
`20260608000001_rls_hardening.sql`, `20260608000002_repuguard_bundled.sql`).
This is **known drift** — the local migration history is incomplete relative
to the live database.

`fieldstay_migration_v1.SUPERSEDED.sql` and `fieldstay_migration_v2.SUPERSEDED.sql`
(repo root) are early hand-written schema dumps that predate the migration
history above. They are kept for historical reference only — **do not run
them**, they no longer match the live schema.

For the current live schema (all tables, enums, functions, triggers, views,
indexes, and RLS policies as of 2026-06-10), see:

```
supabase/schema_reference.sql
```

This file is a **read-only reference snapshot** generated by introspecting the
live database via the Supabase MCP server. It is **not a migration** — it is
intentionally located outside `supabase/migrations/` so `supabase db push`
will never pick it up. Do not run it against any database.

### Workflow going forward

- **New schema changes**: write a new file in `supabase/migrations/` named
  `YYYYMMDDHHMMSS_description.sql` and apply it via the Supabase CLI
  (`supabase db push`) or the Supabase MCP `apply_migration` tool against the
  live project. Always update `types/database.ts` in the same commit (see
  "types/database.ts — Keep in Sync With Every Migration" above).
- **Reconciling local history with live**: before running `supabase db pull`
  or any command that rewrites `supabase/migrations/`, be aware that the
  local migration history is far behind the live project's
  `supabase_migrations.schema_migrations` table. Pulling will likely produce
  a large new migration capturing everything not yet represented locally —
  review it carefully against `supabase/schema_reference.sql` before
  committing.
- **Verifying schema state**: use `supabase/schema_reference.sql` as the
  source of truth for "what does the live DB actually look like right now,"
  rather than trying to reconstruct it from the 4 local migration files.

### types/database.ts drift

`types/database.generated.ts` is a **read-only reference** generated directly
from the live schema via the Supabase MCP `generate_typescript_types` tool
(standard Supabase `Database` shape — `public.Tables.<table>.Row/Insert/Update`).
It is **not imported anywhere** — `types/database.ts` (hand-maintained flat
interfaces) remains the file the app actually imports from, and the Supabase
client is untyped (`Schema = any`, see `lib/supabase/server.ts`), so this is
not a build-breaking issue today.

As of 2026-06-10, the following live tables have **no corresponding interface**
in `types/database.ts`: `assignment_outcomes`, `audit_events`,
`inventory_count_drafts`, `inventory_count_draft_items`, `inventory_templates`,
`inventory_template_items`, `org_invites`, `powersync_crew_instances`,
`powersync_crew_properties`, `powersync_crew_turnovers`, `review_responses`,
`reviews`, `stripe_processed_events`, `wo_number_counters`. When building
features against these tables, add the matching interface to
`types/database.ts` using `types/database.generated.ts` as the source of
truth for column names/types/nullability.

### Known anomalies (observed, not yet remediated)

- `owner_transactions` has **two duplicate** `UNIQUE(source_reference_id, source)`
  constraints (`owner_transactions_source_ref_unique` and
  `uq_owner_txn_source`). Functionally harmless (Postgres just maintains two
  identical indexes) but redundant — a future migration could drop one.
- Several tables grant broad privileges to the `anon` Postgres role
  (e.g. full CRUD on `bookings`, SELECT on `audit_events`,
  `owner_transactions`, `work_orders`, `reviews`, `review_responses`,
  `property_owners`, `owner_portal_tokens`; full CRUD on
  `integration_connections`, `integration_providers`, `org_invites`,
  `organization_members`, `oauth_states`, `inventory_*`, `org_master_*`).
  RLS policies still gate row-level access for these tables, so this is not
  an active vulnerability, but the grants are broader than necessary and
  should be tightened in a future migration.

---

## Context Documents

Read these before working on specific features:

| Document | When to read |
|---|---|
| `FIELDSTAY_MASTER_ROADMAP.md` | Before starting any sprint |
| `CLAUDE_7_0.md` | For Phase 7 context (property setup, checklists, inventory) |
| `CLAUDE_8_0.md` | For Phase 8 context (work orders, vendor management, comms) |
| `CLAUDE_WO_COMPLETION.md` | For WO detail page and line items implementation |
| `CLAUDE_9_0.md` | For Phase 9 features (messaging, maintenance broadcast) |
| `CLAUDE_7_8_PATCH.md` + `CLAUDE_Patch_7_8v2.md` | For patch context and known issues |
