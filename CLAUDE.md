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
| Sync | PowerSync | Client reads SQLite only — never Supabase directly |
| Background jobs | Inngest | All async work, crons, multi-step workflows |
| Email | Resend + React Email | Transactional only, never marketing |
| Payments | Stripe | Webhook signature verification required |
| Retailer API | Kroger API | Cart automation for below-par inventory |
| Geocoding | Mapbox | Properties and vendors — one call on save |

**Never introduce:** Vite, Turborepo, tRPC, Prisma, or any ORM.
**Never add** client-side Supabase reads that bypass PowerSync.

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

### PowerSync — Client-Side Data Access
```typescript
// Client components read from local SQLite via PowerSync hooks
// NEVER call supabase directly from a client component for reads
import { usePowerSync } from '@powersync/react'

function MyComponent() {
  const db = usePowerSync()
  const results = db.getAll('SELECT * FROM turnovers WHERE property_id = ?', [propertyId])
}

// Mutations go through Server Actions, which write to Supabase
// PowerSync then streams the change back to the local SQLite cache
// This is the core local-first pattern — never short-circuit it
```

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
| Shopping cart Inngest function | `inngest/functions/build-shopping-cart.ts` |
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
| `.modify(q => ...)` on a Supabase query | Not a real method. Build the query conditionally with `if` blocks before awaiting it |
| Direct Supabase reads in client components | PowerSync hooks + local SQLite |
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
