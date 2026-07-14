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
| SMS | Telnyx | Guest opt-in, door code delivery, morning/evening nudges. `SMS_ENABLED=false` env var gates all sends — do not flip to true until 10DLC is verified |
| Weather | Tomorrow.io | Contextual SMS — rain/temperature signals for guest recommendations |
| Observability | Axiom | Native Vercel integration. All Inngest logger calls route here |

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

### 5. SMS — Gate on SMS_ENABLED

All SMS sends must be gated on the `SMS_ENABLED` environment variable:

```typescript
if (process.env.SMS_ENABLED !== 'true') {
  logger.info('SMS_ENABLED=false — skipping send')
  return
}
```

This flag is `false` until 10DLC campaign verification clears. Never send
to guests without this gate in place. The flag lives in `lib/sms/telnyx.ts` —
check that any new SMS-sending code respects it.

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
powersync_crew_*            — LEGACY. Tables from the original PowerSync sync layer,
                              replaced by Dexie.js. Do not use in new code.
```

### Guidebook & Guest Messaging
```
guidebook_configurations    — per-org guidebook settings, sponsor tier config,
                              grace period state, gap night messaging settings
guidebook_property_configs  — per-property guest-facing content: WiFi, check-in
                              instructions, house rules, checkout instructions
guidebook_sponsors          — local business sponsors with offer details, slot type,
                              media kit token, Stripe subscription tracking
guidebook_guest_sms_optins  — guest SMS consent records with TCPA audit fields.
                              UNIQUE(booking_id). Scoped to phone_e164 globally
                              for STOP compliance (not per-org)
stay_extension_requests     — gap night offer tracking. UNIQUE(booking_id).
                              status: pending | accepted | declined
crew_feedback               — crew-submitted app feedback. Inserted via service
                              client through /api/crew/feedback only
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

- **CSS variables** for all colors — never hardcode hex in components, and
  that includes Tailwind's own color utilities (`text-red-500`, `bg-blue-500`,
  `hover:text-red-600`, etc.) — those are just hardcoded hex under a Tailwind
  name, not an exception to the rule. Use `style={{ color: 'var(--accent-red)' }}`
  for static cases, or the arbitrary-value bracket syntax for variants/pseudo-
  states that need to stay in `className` (`hover:text-[var(--accent-red)]`,
  `focus:ring-[var(--accent-gold)]`).
  ```tsx
  style={{ color: 'var(--text-primary)' }}
  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
  style={{ color: 'var(--text-muted)' }}
  style={{ color: 'var(--accent-gold)' }}
  ```
- **Tailwind core utilities** for layout, spacing, flex/grid — no custom compiler
- **No `@apply` in component files** — inline styles or className for variants
- Dark navy aesthetic. The app looks like serious professional tooling, not a pastel SaaS.
- **Reuse shared `components/ui/*` primitives instead of hand-rolling** — a
  hand-rolled tab bar on the Assets page shipped without a focus state simply
  because nothing forced consistency with the one other tab bar in the app.
  Before building a new instance of a common pattern (tabs, dialogs, badges,
  status dots), check `components/ui/` first. `scripts/check-raw-ui-classes.sh`
  (run via `npm run check:ui-classes`, part of the standard verification pass)
  greps for hand-written `btn-*`/`badge-*`/`card` class strings outside this
  directory specifically to catch call sites that bypassed these primitives —
  a hand-rolled equivalent that reaches the same visual result via raw
  Tailwind utilities instead will slip past that check, so reuse is the real
  guardrail, not just the lint step.

  | Component | Use for | Notes |
  |---|---|---|
  | `Button` | Any clickable button | `variant`: `primary`\|`cta`\|`secondary`\|`danger`\|`ghost`. For an element that must render button *styling* but can't be a `<Button>` itself (a `<Link>` styled as a button, a disabled-look `<span>`) — call `buttonVariantClass(variant)`, never hand-write `"btn-primary"` etc. as a literal string |
  | `Card` | Any card-style container | Thin wrapper around the `.card` class |
  | `Badge` | Small status/count pill | `tone`: `green`\|`amber`\|`red`\|`blue`\|`gold`\|`slate` |
  | `Dialog` | Any modal | Built-in focus trap, Escape-to-close, body-scroll lock, portal render, mobile bottom-sheet mode via `mobileSheet`. Don't hand-roll a new modal's overlay/focus-trap logic |
  | `Input` | Any text input | Plain `forwardRef` wrapper — spreads all native input props |
  | `Checkbox` | Any checkbox | Gold accent color + focus ring baked in — don't hand-roll a bare `<input type="checkbox">` |
  | `StatusDot` | Colored status indicator dot + screen-reader label | `status` is an internal lookup key (`good`\|`warning`\|`critical`\|`attention`\|`offline`\|`unknown`), not display text — see the note below on not renaming these |
  | `Tabs` | Any tab bar | `role="tablist"`/`role="tab"`, `aria-selected`, built-in focus ring |

  - **Migrating an *existing* hand-rolled tab bar** onto `Tabs` is a judgment
    call, not automatic —
    a tab bar with its own established, intentionally different visual
    treatment (e.g. `settings-tabs.tsx`'s gold-underline-with-primary-text
    style vs. `Tabs`'s gold-underline-with-gold-text) is a design decision,
    not a bug, and forcing it onto the shared component would mean changing
    its look or bolting on props just to preserve behavior. Only migrate
    when the existing implementation is a plain miss (no focus state, no
    `role`/`aria-selected`) rather than a deliberate variant.
  - **Focus rings on elements flush against a neighbor** (tab bars, sidebar
    cluster headers) → `focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]`.
    `ring-inset` keeps the ring inside the element's own bounds; a default
    outset ring with an offset visually collides with the adjacent element
    in these flush horizontal/vertical layouts.
- **Internal lookup/status keys are not display strings — don't rename them
  together.** Some helpers return a short internal key used to select a
  color/icon/variant (e.g. `healthDot()`'s `'critical'`/`'offline'` return
  values, which are `StatusDot` status keys, not text) alongside a separate
  helper that returns the actual user-facing label (`healthLabel()`). A copy
  change ("Critical" → "End of Life") only ever touches the label helper and
  any hardcoded JSX string literals — never the internal key, since other
  code branches on that key's exact value and renaming it silently breaks
  the color mapping for no visible symptom until someone notices the wrong
  dot color.

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
| Hardcoded colors in components, incl. Tailwind color utilities (`text-red-500`, `hover:text-red-600`) | CSS variables (`var(--text-primary)` etc.) — use the arbitrary-value bracket syntax (`hover:text-[var(--accent-red)]`) if it needs to stay in `className` |
| Hand-rolling a new tab bar | `components/ui/Tabs.tsx` |
| Renaming an internal status/lookup key (e.g. `healthDot()`'s `'critical'`/`'offline'` return values) during a copy change | Only rename the display-string helper (`healthLabel()`) and hardcoded JSX text — internal keys are branched on elsewhere and renaming them silently breaks color/variant mapping |
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

**Current state:** 147+ migrations applied to project `vpmznjktllhmmbfnxuvk`.
All migrations live in `supabase/migrations/` as `YYYYMMDDHHMMSS_description.sql`.

`fieldstay_migration_v1.SUPERSEDED.sql` and `fieldstay_migration_v2.SUPERSEDED.sql`
at the repo root are early hand-written schema dumps. Do not run them — they are
kept for historical reference only and no longer match the live schema.

### Schema Reference File

`supabase/schema_reference.sql` is AUTO-GENERATED. Do not edit it manually.
Regenerate before any audit or schema review:

```bash
bash scripts/generate-schema-reference.sh
```

If the file does not contain a `Generated:` timestamp in its header, it is stale
and should not be used as a reference for live DB state. The live Supabase database
is always authoritative over the snapshot file.

### Adding new schema

Write a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`
and apply it via:
- Supabase CLI: `supabase db push`
- Supabase MCP: `apply_migration` tool against project `vpmznjktllhmmbfnxuvk`

Always update `types/database.ts` in the same commit as the migration.

### Known legacy tables

`powersync_crew_*` tables exist in the DB from an earlier PowerSync-based sync layer
that was replaced by Dexie.js. They are not used by any active code path. Do not
write new code that reads from or writes to these tables.

---

## Schema Reference

`supabase/schema_reference.sql` is AUTO-GENERATED and may be stale.

Before any schema audit, regenerate it:
  bash scripts/generate-schema-reference.sh

Never trust the file if it lacks a "Generated:" timestamp in the header.
The live Supabase database is always authoritative over the snapshot file.

---

## Canonical Patterns — Real Signatures and Locations

These were validated against the live codebase. Do not assume from docs or spec files.

### Helper signatures

**getPmEmail**
```typescript
getPmEmail(supabase, orgId)  // supabase client FIRST, orgId second
// Returns: string | null   — the email address directly, not an object
```

**renderPmAlert**
```typescript
renderPmAlert({ heading, body, ctaLabel, ctaUrl, details?, table?, sections?, note? })
// heading, body, ctaLabel, ctaUrl are REQUIRED. details/table/sections/note are optional.
// NOT: actionLabel, actionUrl, pmName — those never existed on this component.
```

### Auth patterns

**Crew API routes** — no helper exists, use inline pattern from issue-reports:
```typescript
const { data: { user } } = await supabase.auth.getUser()
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const { data: crew } = await supabase
  .from('crew_members').select('id, org_id').eq('user_id', user.id).single()
if (!crew) return NextResponse.json({ error: 'Not a crew member' }, { status: 403 })
```

### Table and column names

| What you might assume | What actually exists |
|---|---|
| `work_order_notes` | `work_order_updates` |
| `inventory_count_draft_items.inventory_item_id` | `item_id` |
| `inventory_count_draft_items.submitted_quantity` | `counted_qty` |
| `memberships` | `organization_members` |
| `membership.user_id` | `user.id` |
| `assigned_crew_id` | `assigned_crew_member_id` |

**Two inventory tables with different column names — do not mix them:**
- `inventory_count_draft_items`: `item_id`, `counted_qty`, `note`, `notes`, `previous_quantity`
- `inventory_count_items` (legacy direct-commit): `inventory_item_id`, `quantity_counted`

### UI component locations

- Crew assignment pills on turnovers → `turnovers/turnover-board.tsx` (NOT maintenance-board.tsx)
- Vendor context → `maintenance/maintenance-board.tsx`

### Inngest constraints

- `step.sleep` at top level only — never nested inside another step
- `createServiceClient()` inside `step.run()` only — never in outer function scope
- `for...of` inside `step.run()`: use `continue` to skip iterations, never `return` — `return` aborts the entire step and silently skips all remaining iterations
- Exactly one `serve()` call in the Inngest route file
- Every new event registered in `FieldStayEvents` before its closing brace

### Supabase patterns

- All DDL uses `IF NOT EXISTS` / `DROP POLICY IF EXISTS` — idempotent always
- Nested joins always return arrays, not single objects
- RLS policies need both `USING` and `WITH CHECK` on UPDATE — `USING` alone is not enough
- `supabase.raw()` and `.modify()` are not used in this codebase

---

## Code Quality Standards

These rules are enforced by SonarQube and must be followed in all new code
and refactors. Violations will appear as SonarQube findings on the next scan.

### Complexity & Structure
- **Cognitive complexity ≤ 15** per function — extract named helper functions,
  custom hooks, or named predicates to reduce branching
- **Nesting depth ≤ 4** — use guard clauses and early returns to flatten nested
  `if` blocks rather than indenting further
- **No nested template literals** — extract inner expressions to named variables
  first, or use `cn()` for className construction if already imported in the file
- **No invariant conditionals** — a ternary where both branches return the same
  value is always a bug; review intent before fixing

### Type Safety
- All component props must be wrapped in `Readonly<Props>` or
  `Readonly<{ ... }>` — no mutable prop types
- `useState` setters must exactly follow the `set[ValueName]` convention:
  `const [confirmDelete, setConfirmDelete]` not `setConfirm`
- Use `!== null && value !== undefined` or nullish coalescing `??` — never
  loose `!= null` checks
- Optional chaining `?.` over manual `&&` null guards wherever applicable
- Never use `as any` or `// @ts-ignore` — fix the type, not the error

### React Rules
- **Rules of Hooks:** Hooks must always be called in the exact same order on
  every render. Never call `useState`, `useEffect`, `useCallback`, `useMemo`,
  `useTransition`, or any hook:
  - Inside an `if` / `else` block
  - After an early `return` statement
  - Inside a loop
  - Move all hooks to the top of the component before any conditional logic.
    If a guard is needed before the hooks run, extract the inner content to a
    child component.
- Non-native elements (`div`, `span`, `li`, etc.) with `onClick` must have:
  - `role="button"` (or appropriate ARIA role)
  - `tabIndex={0}`
  - `onKeyDown` handler firing on `Enter` and `Space`
  - Prefer converting to an actual `<button type="button">` wherever possible —
    native elements get keyboard handling for free
- `onMouseOver` must always be paired with `onFocus` on the same element
- `onMouseOut` must always be paired with `onBlur` on the same element
- Every `<label>` must have `htmlFor` matching the `id` of its associated
  control — no orphaned labels

### Security & Best Practices
- **Never use `Math.random()`** for IDs, storage paths, or tokens —
  use `crypto.randomUUID()` (native in Node.js 14.17+ and all modern browsers,
  no import needed)
- **Never use `window` directly** — use `globalThis` for SSR safety in Next.js.
  `window` throws a ReferenceError during server-side rendering
- Remove all unused imports before committing — run `npx tsc --noEmit` to
  surface them if ESLint is not configured to catch them
- No chained ternary expressions — break them into `if/else` blocks or a
  named classification function

### Accessibility Checklist (apply to all new UI)
- Non-native click targets → `role`, `tabIndex`, `onKeyDown` or convert to `<button>`
- Mouse hover events → paired focus events
- Form labels → `htmlFor` on every `<label>`
- Inputs without a visible label → `aria-label` attribute required
- Tab bars → `components/ui/Tabs.tsx`, not hand-rolled — it already has
  `role="tablist"`/`role="tab"`, `aria-selected`, and a visible focus ring
