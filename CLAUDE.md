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
| Framework | Next.js 16 App Router | Server Components, Server Actions, Route Handlers |
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
| Observability | Axiom, Sentry | Axiom: native Vercel integration, all Inngest logger calls route here (independent of OpenTelemetry — a Vercel log capture, not a trace exporter). Sentry (`@sentry/nextjs`, added 2026-07-15): errors + performance traces for the Next.js app. Owns the OTEL tracer-provider registration in `instrumentation.ts`/`instrumentation-client.ts` — do not add a second one (e.g. `@vercel/otel`, removed when Sentry was added) |

**Never introduce:** Vite, Turborepo, tRPC, Prisma, or any ORM.
**Never add** client-side Supabase reads that bypass the Dexie local-first sync layer
in the crew PWA (`lib/dexie/*`).

---

## Critical Security Rules

These are non-negotiable. Violating them creates security vulnerabilities or
data leaks that could expose tenant data.

### 1. Service Role Key
- `SUPABASE_SERVICE_ROLE_KEY` is used ONLY in Inngest steps, specific
  server-side route handlers, and Server Components where RLS must be
  bypassed intentionally.
- Server Component (`page.tsx`) use of `createServiceClient()` is accepted
  when — and only when — the component calls `requireOrgMember()` or
  validates a token first, and every query it runs is explicitly scoped
  with `.eq('org_id', ...)` (or the token's equivalent). Service role in a
  Server Component removes RLS as a defense-in-depth backstop for that
  page, so a missing `.eq('org_id', ...)` filter there fails open with no
  safety net — prefer `createServerClient()` (RLS-enforced) unless the page
  genuinely needs the bypass (e.g. cross-org aggregation re-filtered to the
  caller's authorized scope, as in the owner-portal pages).
- Never pass it to client components, never return it in API responses,
  never log it.
- Use `createServiceClient(context)` from `lib/supabase/server.ts` for
  service role — the `ServiceRoleContext` argument is required and names why
  the RLS bypass is justified (see the Supabase Clients pattern section).
- Use `createServerClient()` from `lib/supabase/server.ts` for normal auth.
- Use `adminFetch()` from `lib/supabase/server.ts` for raw calls to the
  Supabase Admin REST API (e.g. `/auth/v1/admin/users?email=`) that aren't
  covered by the JS client's gotrue/postgrest wrapper — never build a
  one-off `fetch()` with the service role key inline.

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

The daily nudge budget check in `lib/sms/telnyx.ts` (`claimNudgeBudgetSlot`)
fails CLOSED on a Redis error — the nudge is skipped, not sent — unlike the
abuse-rate limiters in `lib/rate-limit.ts`/`proxy.ts`, which deliberately
fail open; a spend ceiling must not disappear during an outage.

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
crew_availability           — crew marks available/unavailable by date. NOT in the crew
                              Dexie cache: time off is an online-only screen (server-rendered
                              rows + a Server Action), so it is not synced to devices.
                              `messages` is the same — history is server-rendered and the
                              unread badge is a server-side count; only SENDING is offline
                              (an outbox mutation). `property_assets`/`inventory_items` are
                              cached but pulled on assigned-property-set change plus screen
                              open (lib/dexie/sync/scope.ts), not on the safety poll
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
room_templates              — Templates Hub: org-level room library (name, auto_include,
                              is_system). Backs the Turnover Checklist tile at /templates —
                              replaced the old org_master_checklist_items seed table,
                              dropped by 20260721150000_drop_org_master_checklist_items.sql
org_maintenance_catalog_items — Templates Hub: org-level maintenance catalog item (name,
                              category, suggested_recurrence, asset_category). Backs the
                              Scheduled Maintenance tile at /templates — replaced the old
                              org_master_maintenance_schedules seed table, dropped by
                              20260721170000_drop_org_master_maintenance_schedules.sql
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
org_inventory_catalog       — Templates Hub: org's own editable copy of inventory_catalog,
                              seeded from it on first touch. platform_catalog_item_id
                              nullable/ON DELETE SET NULL (added 2026-07-21)
inventory_templates         — org-level inventory template. Since 2026-07-21, an org can
                              have more than one (unique on (org_id, name), not just org_id)
inventory_template_items    — Has preferred_brand column
inventory_items             — property-level. Has preferred_brand (overrides template brand).
                              current_quantity is numeric(12,2), NOT integer (20260815152007) —
                              real stock is fractional (half a case, 1.5 gallons). par_level was
                              already numeric. Parse every quantity input through
                              lib/inventory/quantity.ts: parseInt('2.5') is 2, which is how a
                              half-case count silently became a whole one
inventory_counts            — periodic count sessions
inventory_count_items       — quantity_counted is numeric(12,2) (20260815152007). The
                              apply_inventory_counts RPC casts it as `qty numeric` in its
                              jsonb_to_recordset — that cast, not the column type, is what
                              rejects a fraction, so the two must change together
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
                              grace_period = expired 1–45 days (soft warn + ack)
                              hard_blocked = expired 46+ days (no WO assignment)
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
reservation_messages        — automated guest messaging (superseded guest_message_templates /
                              guest_messages_sent, dropped by 20260611000006)
reviews / review_responses  — guest reviews + PM responses
```

### Supporting
```
system_job_runs             — Inngest run ledger. Written ONLY by
                              lib/inngest/functions/cron/job-run-recorder.ts, which
                              subscribes to Inngest's built-in
                              `inngest/function.finished` (once per run, guaranteed —
                              the middleware `finished` hook is NOT). Read by
                              cron/watchdog.ts to detect jobs that have gone silent.
                              Unique on (run_id, function_id), NOT run_id alone.
                              function_id is stored BARE (`cron-daily-wrapup`), with
                              Inngest's `fieldstay-` prefix stripped — WATCHED_JOBS
                              is written in bare ids and the two must agree
org_milestones              — key-value store for org state flags + async job results
                              Polled by the UI to surface Inngest job completions
audit_events                — append-only audit log
push_subscriptions          — PWA push notification endpoints
oauth_states                — CSRF state tokens for OAuth flows
notifications                — in-app notification bell event log (added 2026-07-15).
                              Has type, title, subtitle, href, severity
                              (red|amber|green|blue), dedupe_key (unique when
                              NOT NULL — cron/retry idempotency), read_at.
                              System-inserted only (service role from Inngest);
                              org members can SELECT and can UPDATE only
                              read_at via RLS (no column-level lock-down yet).
                              Superseded 7 PM email categories — see
                              lib/notifications.ts.
notification_digest_state    — per-org/category snapshot for the daily 6pm PM
                              wrap-up digest (added 2026-07-16). PK
                              (org_id, category), snapshot jsonb. Used by
                              diffDigestSnapshot() to show new/unchanged/
                              removed items vs. yesterday. SERVICE-ROLE ONLY —
                              org members have no RLS policy at all (the
                              read policy was dropped by
                              20260730104000_grant_authenticated_and_drop_dead_policies.sql;
                              nothing but lib/inngest/helpers.ts ever read it).
                              Listed in check-db-invariants.mjs's
                              SERVICE_ROLE_ONLY_TABLES, so the policy-less
                              state is deliberate rather than a missed table.
```

`powersync_crew_*` tables from the original PowerSync sync layer (replaced by
Dexie.js) were fully dropped by `20260611063549_drop_powersync_helper_views.sql`
and `20260622123556_drop_dangling_powersync_crew_sync_triggers.sql` — they no
longer exist in the live schema at all, not merely "unused." Do not reference
them in any form.

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

// In Inngest steps and admin operations — bypasses RLS intentionally.
// The context argument is REQUIRED (compile-time only, runtime ignores it):
// it forces every call site to name why the RLS bypass is justified.
// See the ServiceRoleContext type in lib/supabase/server.ts for all
// variants and when each applies.
import { createServiceClient } from '@/lib/supabase/server'
const supabase = createServiceClient({ authorizedBy: membership })   // server actions (from requireOrgMember/requireOrgRole)
const supabase = createServiceClient({ system: 'inngest:my-function' })      // Inngest steps/crons
const supabase = createServiceClient({ crew })                       // crew routes (from requireCrewMember)
const supabase = createServiceClient({ authenticatedUser: user })    // self-scoped session routes
const supabase = createServiceClient({ publicSurface: 'owner-portal' })      // token-gated/webhook routes that validate in-file
```

### Dexie — Client-Side Data Access (Crew PWA)
The crew PWA (`app/crew/*`) is local-first. PowerSync was the original design
and is **fully gone** — no dependency, no `lib/powersync/` directory, no
`powersync_crew_*` tables, and as of 2026-07-27 no references left in
`lib/dexie/*` comments either. The sync layer is a hand-rolled Dexie
(IndexedDB) cache plus a local mutation outbox:

- `lib/dexie/schema.ts` — `FieldStayDexie`, the Dexie database class. Table
  shapes mirror the Supabase tables they cache. Get an instance via
  `getDexieDb(userId)`.
- `lib/dexie/context.tsx` — `DexieProvider` pulls turnovers/properties/
  inventory/checklists from Supabase into Dexie tables on an interval
  and on reconnect; client components read from Dexie, never from Supabase
  directly.
- `lib/dexie/syncService.ts` — `enqueueMutation()` queues a local write into
  the `mutations` outbox table and fires `SyncEngine.processOutbox()` in the
  background, which drains the outbox in insertion order and pushes each
  mutation to Supabase (or a Route Handler, for flows like turnover
  completion that need server-side side effects), retrying on failure and
  stopping the drain on first error so later mutations against the same
  record aren't applied out of order.

**Two conventions every crew-side write and cached table must satisfy**
(both added after the 2026-07-30 pre-launch audit found them violated across
almost the whole crew surface):

- **An upload builder may only write a column the mutation actually carried.**
  Inside a Supabase update payload built from an outbox mutation, a field is
  assigned from `payload.<x>` only behind an explicit `'<x>' in payload`
  presence check. `completed_at: payload.completed_at ?? null` writes a real
  NULL when the mutation never mentioned the field — photo-sync's
  photo-only PATCH wiped the completion timestamp off items that were still
  `is_completed = true`, and it failed silently because the write succeeded.
  (`undefined` is harmless — JSON drops it; `?? null` is the bug.) Enforced by
  `unit/guardrails/upload-payload-null-fields.test.ts`.
- **Every cached table is bounded, and every dead-letterable mutation is
  visible.** A Dexie-cached Supabase table is either reconciled at pull time
  (the sync function bulkDeletes ids no longer present) or pruned by
  `lib/dexie/prune.ts` — `messages` grew forever at 500 rows a pull. And every
  member of the `MutationTable` union must have a retry affordance in
  `app/crew/_components/failed-sync-banner.tsx`: a mutation that dead-letters
  where no crew member can see it is work silently thrown away. BOTH outboxes
  (`mutations` and `pending_photo_uploads`) need a dead-letter query AND a
  stalled-queue query there — a transport failure never sets `failed`, so the
  stalled surface is its only visible one. Enforced by
  `unit/guardrails/crew-dead-letter-coverage.test.ts`.
- **The optimistic local write and its outbox row commit in ONE Dexie
  transaction.** Use `writeAndQueue()`/`enqueueMutationTx()` (`lib/dexie/
  helpers.ts`, `lib/dexie/syncService.ts`) — never a bare `table.update()`
  followed by a separate `enqueueMutation()`. As two transactions, a PWA
  reclaimed between them left the cache updated with nothing queued to send
  it, and no delta pull corrects that because the server row's `updated_at`
  never changed. Nothing async-external may go inside the block: an IDB
  transaction auto-commits the moment an await leaves it, so the
  `processOutbox()` kick stays outside.
- **Abandoning a queued mutation rewinds the cursor that was masking the
  server row.** `discardFailedMutation()` and `pruneExpiredDeadLetters()` call
  `invalidateCursorsFor()`. While a mutation is queued, `shadow.ts` replays it
  over every pull AND `advanceCursor()` moves past the server row it masks —
  drop it without rewinding and the delta filter skips that row forever.
  `forceFullCrewResync()` is the whole-cache version, for a device that has
  already diverged.
- **`failed` is `0 | 1`, never a boolean** (`DeadLetterFlag`). IndexedDB has no
  boolean key type, so a boolean `failed` is silently absent from its index and
  every dead-letter query degrades to a full scan — three of which are
  `useLiveQuery`s live on every crew screen, over a table written on every
  checklist tick. Truthiness checks (`!m.failed`) are unaffected; only literal
  `true`/`false` writes.

**Crew Sync v2 coverage convention** (`docs/CREW_SYNC_V2_PHASES.md` section 5e):
every Supabase-backed table the crew PWA caches in Dexie is covered by the
safety poll (the full `resync()`/`resyncV2()` covers all of them); every such
table must ALSO either have a broadcast trigger in the crew-sync trigger
migration (`supabase/migrations/*crew_sync_broadcast_triggers.sql` — low-
latency entities) or be explicitly listed in the `SAFETY_POLL_ONLY` allowlist
in `unit/guardrails/crew-sync-coverage.test.ts`. This is a union check, not
exclusive-or — a broadcast-triggered table is deliberately covered by both
mechanisms, the poll being the correctness backstop. A new cached table must
be added to `CREW_SYNCED_TABLES` or `LOCAL_ONLY_TABLES` in
`lib/dexie/schema.ts` in the same PR that adds it, and (if synced) placed in
either `TRIGGERED_TABLES` or `SAFETY_POLL_ONLY` in the guardrail test —
`crew-sync-coverage` fails CI otherwise.

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

There are now TWO type files, and a migration touches both:

- `types/database.generated.ts` — GENERATED from the live schema, never
  hand-edited. Regenerate with
  `npx supabase gen types typescript --project-id vpmznjktllhmmbfnxuvk > types/database.generated.ts`
  (or the Supabase MCP `generate_typescript_types` tool). It owns `Json` and
  `Database`; `types/database.ts` re-exports both from it. It exists because
  the hand-written interfaces do not satisfy postgrest-js's `GenericSchema`
  constraint, which is why `lib/supabase/server.ts` still omits the
  `<Database>` generic and no `.from()`/`.rpc()` call is type-checked yet —
  see the comment in that file for the remaining work.
- `types/database.ts` — hand-written named interfaces (`Property`,
  `WorkOrder`, `MemberRole`, …), the app's import surface. Diffed against the
  live schema on 2026-08-02 and accurate: the only differences were two
  PostgREST embed aliases (not columns) and the deliberately-omitted
  deprecated `work_orders.assigned_crew_id`. `scripts/check-type-drift.mjs`
  keeps it honest.

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
| Naming a `GENERATED ALWAYS` column in an `.insert()`/`.update()` payload (`work_order_line_items.line_total`, `assignment_outcomes.duration_minutes`, `checklist_item_signals.flag_probability`/`.dynamic_photo_required`) | Omit it and let the database compute it. Postgres rejects the WHOLE statement with `428C9`, not just that column — and where the error is only logged, the entire write vanishes silently. This shipped twice: every vendor completion stored zero line items, and the crew-scoring learning loop recorded nothing. `supabase/schema_reference.sql` renders these as plain `DEFAULT`s, which is what made both inserts look correct — the LIVE DB is authoritative. Enforced by `unit/guardrails/generated-column-writes.test.ts` |
| Adding a DB column via migration without updating `types/database.ts` | Every migration that adds a column must also add that column to the matching interface in `types/database.ts` in the same commit. Supabase's TS client infers return types from this file, not from the live DB. Missing columns here cause build failures even when the query and select string are correct |
| Adding a new event to `events.ts` outside the closing `}` of `FieldStayEvents` | The final `}` in `events.ts` closes the `FieldStayEvents` type. Every new event entry must be placed before it, with a comma after the preceding entry's closing brace |
| An unbounded `.select()` in a platform-wide cron | PostgREST's `max_rows = 1000` truncates it silently — 200, no error, no signal. Paginate via `fetchAllRows()` (`lib/inngest/paginate.ts`) or use a `count`/`head` aggregate |
| Reading a new `process.env.X` without declaring it in `lib/env.ts` | Add it to `ENV_SPEC` with a tier and a one-line `why`. Undeclared means the deploy will NOT fail on it when it is missing — it becomes `undefined` and surfaces later as an unrelated-looking error. `unit/guardrails/env-schema-coverage.test.ts` fails on drift in either direction |
| `.modify(q => ...)` on a Supabase query | Not a real method. Build the query conditionally with `if` blocks before awaiting it |
| Direct Supabase reads in crew PWA client components (`app/crew/*`) | Dexie (`getDexieDb` / `useLiveQuery`) reading the local IndexedDB cache |
| Service role key in client code | Server Actions and Inngest steps only |
| Hardcoded colors in components, incl. Tailwind color utilities (`text-red-500`, `hover:text-red-600`) | CSS variables (`var(--text-primary)` etc.) — use the arbitrary-value bracket syntax (`hover:text-[var(--accent-red)]`) if it needs to stay in `className` |
| Hand-rolling a new tab bar | `components/ui/Tabs.tsx` |
| Renaming an internal status/lookup key (e.g. `healthDot()`'s `'critical'`/`'offline'` return values) during a copy change | Only rename the display-string helper (`healthLabel()`) and hardcoded JSX text — internal keys are branched on elsewhere and renaming them silently breaks color/variant mapping |
| Giving a new table a `PRIMARY KEY (a_id, b_id)` where both are FKs to different tables | Make the PK single-column (drop the derivable FK — a child of a property-scoped parent already knows its property). PostgREST reads that shape as a many-to-many JUNCTION and starts offering a second embed path between the two parents, so EVERY pre-existing `.select('*, parent(...)')` between them breaks with HTTP 300 / `PGRST201` — queries that never mention your new table. This shipped on 2026-08-10 and broke four call sites (inventory page, `inventory/actions.ts`, `lib/notifications.ts`, `lib/support/account-tools.ts`); only one had a test. A `UNIQUE` on the same pair is fine — the detection keys on the PRIMARY KEY. Enforced by `scripts/check-db-invariants.mjs` check 10 |
| Flipping an "only one row may be true" flag in ONE `UPDATE` (`SET is_default = (id = $1) WHERE is_default OR id = $1`) | Clear then set, as two statements inside a function/transaction — see `set_default_platform_inventory_template`. Postgres checks a unique index per row as each new row version is written, not at statement end, and a **partial** unique index cannot be `DEFERRABLE` (there is no partial unique CONSTRAINT, only a partial unique INDEX). So if the scan reaches the row being SET before the row being CLEARED, two rows momentarily hold the flag and the statement aborts with `23505`. Verified: flipping to a higher id succeeded, flipping to a lower id rolled back with nothing changed — i.e. it passes any test written against a fresh fixture and fails for about half of real inputs |
| Creating a table without RLS | Always `ENABLE ROW LEVEL SECURITY` + policies |
| Multiple Inngest steps creating same record | Check `source_reference_id` first |
| `any` type | Explicit interface or generic |
| Logging `actual_cost`, email, Stripe tokens | Never log PII or financial data |
| Checking `role = 'admin'` manually | Use `is_org_member()` — it handles `owner` automatically |
| Skipping Stripe webhook signature verification | Always `constructEvent()` first |
| Using a new event name in `inngest.send()` without registering it | Add to `FieldStayEvents` in `lib/inngest/events.ts` first — build fails with type error if missing |
| Completing a work order by writing `status: 'completed'` yourself | Write `workOrderCompletionFields()` and then call `finalizeWorkOrderCompletion()` with the rows the UPDATE returned (`app/(dashboard)/maintenance/complete-work-order-helpers.ts`) — the status write alone skips the `work-order/completed` event (so no `owner_transactions` maintenance expense), `completed_date`, the `work_order_updates` row, and the source-schedule advance. Enforced by `unit/guardrails/work-order-completion-side-effects.test.ts` |
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

**Current state:** 310+ migrations applied to project `vpmznjktllhmmbfnxuvk` (as of 2026-07-23 — check `ls supabase/migrations/ | wc -l` rather than trusting this number as it ages).
All migrations live in `supabase/migrations/` as `YYYYMMDDHHMMSS_description.sql`.

`docs/archive/schema/` holds the two early hand-written schema dumps
(`fieldstay_migration_v1.SUPERSEDED.sql`, `fieldstay_migration_v2.SUPERSEDED.sql`;
moved there from the repo root 2026-07-27). Do not run them — they are kept for
historical reference only and no longer match the live schema.

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

Migration discipline: every schema change is a local .sql file in
supabase/migrations/, applied via `supabase db push`. MCP apply_migration
is for verification/introspection only — it records live history without
a local file, which is exactly the drift closed on 2026-07-30
(CLAUDE_MIGRATION_RECONCILE_1). Local files and live history were
verified identical on that date (276/276).

**It drifted straight back, and the "verified identical" line above is why
this is now a CI gate rather than a promise.** By 2026-08-03 production was
36 local-only / 35 ledger-only (audit H10, reconciled to 313/313 exact
parity; runbook in `docs/migration-reconciliation/`). Two of those 35 were
SECURITY DEFINER functions living in production with no file anywhere. If
you apply schema through MCP — which is sometimes the only option, e.g. the
operator has no Supabase CLI — you MUST also commit the matching file at the
SAME version the ledger recorded, and renumbering an already-applied file
orphans its ledger row. `scripts/check-migration-ledger.mjs` now fails CI on
either; run `pnpm run check:migration-ledger:prod` after any out-of-band
apply.

Write a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`
and apply it via `supabase db push` against project `vpmznjktllhmmbfnxuvk`.

**Apply it to the E2E project (`syhthijeqlnltufdawyb`) in the same sitting.**
`scripts/check-type-drift.mjs` runs against E2E, not production, and refuses
to run against prod at all — so a migration applied only to prod fails CI with
what looks like a types problem and is really a project-skew one. The rule was
already in `docs/E2E_SETUP.md` ("keep the E2E project migrated in lockstep");
it is repeated here because this section naming only the production ref is
what made it easy to miss.

Always update `types/database.ts` in the same commit as the migration.

### Known legacy tables

`powersync_crew_*` tables were dropped entirely (see the Supporting schema section
above) — they no longer exist in the live DB at all. Do not write new code that
references these tables in any form.

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
// Required: heading, body, ctaLabel, ctaUrl
// Optional: details, table, sections, note
// See lib/resend/emails/pm-alert.tsx PmAlertProps for the authoritative interface —
// NOT: actionLabel, actionUrl, pmName (these were never valid props)
// heading, body, ctaLabel, ctaUrl are REQUIRED. details/table/sections/note are optional.
// NOT: actionLabel, actionUrl, pmName — those never existed on this component.
```

### Shared helpers — use these, don't re-roll them

Each of these exists because the same defect was found open-coded in many
places at once during the 2026-07-30 pre-launch audit. Reaching for the raw
primitive instead is how that drift comes back.

| Helper | Module | Use it for |
|---|---|---|
| `checkLimit(limiter, id, { onError, site })` | `lib/rate-limit.ts` | Every rate-limit check. Returns a `LimitDecision` with an EXPLICIT `onError` fail policy (`'allow'` \| `'deny'`) rather than each call site quietly deciding what a Redis outage means, and distinguishes `skipped` (Upstash unconfigured) from `errored` |
| `unwrap` / `unwrapList` / `unwrapCount` / `tryUnwrap*` | `lib/supabase/unwrap.ts` | Every read. `const { data } = await …` collapses "the query errored" and "zero rows" into the same `null`, so an RLS regression renders as a friendly empty state with nothing logged. These log with context, `reportError()` to Sentry, then throw (`unwrap*`) or return a discriminated result the caller must branch on (`tryUnwrap*`) |
| `fetchAllRows` / `fetchDistinctOrgIds` | `lib/inngest/paginate.ts` | Any platform-wide scan — see the `max_rows = 1000` rule under Supabase patterns |
| `assertSafeExternalUrl` / `safeFetch` | `lib/security/url-guard.ts` | Every outbound fetch to a URL that is even partly tenant-supplied (iCal feeds, webhook targets, image URLs). Hostname string-matching is defeated by redirects, DNS, IPv6, and alternate IPv4 encodings; `safeFetch` re-validates every redirect hop |
| `getPmMembersByOrgIds` / `getOrgDispatcher` | `lib/inngest/helpers.ts` | Resolving an org's PM recipients. The `ByOrgIds` form takes MANY org ids and returns a `Map` — the per-org `getPmMembers` inside a tenant loop is the N+1 that `unit/guardrails/n-plus-one-loops.test.ts` exists to catch |
| Timeout budgets (`GEOCODE_TIMEOUT_MS`, …) + `isTimeoutError()` | `lib/http/timeout.ts` | Every outbound `fetch()`. A `fetch()` with no `AbortSignal` has no timeout at all — it hangs until the platform kills the function. Enforced by `unit/guardrails/external-fetch-timeout.test.ts` |

### Auth patterns

**Crew auth (API routes AND server actions)** — always use the canonical
`requireCrewMember()` from `lib/crew-auth.ts`. NEVER write an inline
`crew_members` lookup as an auth gate, and NEVER filter on
`invite_accepted_at` for crew (that's the PM-side `organization_members`
rule only — ~a third of live crew rows have it NULL because they were
onboarded outside the invite-link flow; filtering on it silently locks
those crew out). This exact drift shipped as a live bug three times
(crew/turnovers actions, crew/feedback route, crew/work-order-reports
route, plus the crew layout gate) and was fixed 2026-07-22.
```typescript
import { requireCrewMember } from '@/lib/crew-auth'

const auth = await requireCrewMember()
if (!auth.ok) return auth.response   // Route Handler (NextResponse)
// if (!auth.ok) return { error: 'Crew member not found' }   // Server Action
const { supabase, crew, user } = auth
```

### Table and column names

| What you might assume | What actually exists |
|---|---|
| `work_order_notes` | `work_order_updates` |
| `memberships` | `organization_members` |
| `membership.user_id` | `user.id` |
| `assigned_crew_id` | `assigned_crew_member_id` |

**One inventory count family.** `inventory_counts` + `inventory_count_items`
(`inventory_item_id`, `quantity_counted`) is now the only one, used by the PM's
own counts and by the crew route. The parallel `inventory_count_drafts` /
`inventory_count_draft_items` pair — with its own, different column vocabulary —
was dropped by `20260804125424_drop_inventory_count_drafts.sql`: it was
unreachable (its only writer was a crew page nothing linked to), held zero rows,
and gated crew counts behind a PM approval that product never wanted.

### UI component locations

- Crew assignment pills on turnovers → `turnovers/turnover-board.tsx` (NOT maintenance-board.tsx)
- Vendor context → `maintenance/maintenance-board.tsx`

### Inngest constraints

- `step.sleep` at top level only — never nested inside another step
- **NO step tooling of any kind inside a `step.run()` callback** — not
  `sendEvent`, `sleep`, `waitForEvent`, `invoke`, or another `run`, and not
  via a helper that closes over `step` (that indirection is how two of these
  shipped). The SDK only WARNS on nesting, then unwinds the request to
  schedule the nested op, leaving the enclosing `step.run` unresolved — its
  callback re-runs from the top next pass, replaying every side effect
  written before the nested call. Have the `step.run` return a DECISION and
  do the step tooling at the function's top level;
  `lib/integrations/connection-error-notify.ts` is the worked example.
  Enforced by `unit/guardrails/inngest-nested-steps.test.ts`
- `createServiceClient()` inside `step.run()` only — never in outer function scope
- `for...of` inside `step.run()`: use `continue` to skip iterations, never `return` — `return` aborts the entire step and silently skips all remaining iterations
- Exactly one `serve()` call in the Inngest route file
- Every new event registered in `FieldStayEvents` before its closing brace

### Supabase patterns

- All DDL uses `IF NOT EXISTS` / `DROP POLICY IF EXISTS` — idempotent always
- Nested joins always return arrays, not single objects
- RLS policies need both `USING` and `WITH CHECK` on UPDATE — `USING` alone is not enough
- `supabase.raw()` and `.modify()` are not used in this codebase
- **`max_rows = 1000` — an unbounded `.select()` truncates SILENTLY.**
  PostgREST caps every response at `max_rows` (`supabase/config.toml`, also
  the Supabase cloud default) and returns the first 1000 rows with a 200, no
  error, and no truncation signal. It is not an exception a retry surfaces —
  it is a quietly wrong result set, and it was the single highest-impact
  systemic finding of the 2026-07-30 pre-launch audit: eight platform-wide
  crons had each stopped covering every tenant past row 1000 (iCal fan-out,
  asset health scoring, metrics snapshot, Kroger cart, notification digest,
  priority decay, crew scoring, stale-feed alert), all with CI green.
  Fine for a request handler rendering one org's page; never acceptable for a
  platform-wide scan. Every such read must be explicitly bounded —
  `fetchAllRows()` from `lib/inngest/paginate.ts` (`.range()` pagination),
  `.limit()`, `.single()`/`.maybeSingle()`, or a `count: 'exact', head: true`
  aggregate that ships no rows at all. Enforced for `lib/inngest/**` by
  `unit/guardrails/unbounded-select.test.ts`.

---

## Code Quality Standards

These rules are enforced by SonarQube and must be followed in all new code
and refactors. Violations will appear as SonarQube findings on the next scan.

### Complexity & Structure
- **Cognitive complexity ≤ 15** per function — extract named helper functions,
  custom hooks, or named predicates to reduce branching. ESLint-enforced
  (`sonarjs/cognitive-complexity`, `eslint.config.mjs`) at `warn` while the
  pre-existing violations get cleared (236 at rollout, 36 as of 2026-08-15),
  and ratcheted per-file by `npm run check:complexity` — new code at over 15
  fails CI outright, and an already-complex function may not get worse. The
  `--max-warnings` total does NOT cover this: it is fungible, and
  `no-nested-conditional` alone is 92 of the 165 warnings, so there is ample
  currency to pay for a complexity regression with
- **Nesting depth ≤ 4** — use guard clauses and early returns to flatten nested
  `if`/`for`/`while`/`switch`/`try` blocks rather than indenting further, and
  extract named sibling functions rather than nesting closures more than 4
  levels deep. ESLint-enforced (`sonarjs/nested-control-flow` for blocks,
  `sonarjs/no-nested-functions` for closures) — `warn` for the same rollout
  reason as above
- **No nested template literals** — extract inner expressions to named variables
  first, or use `cn()` for className construction if already imported in the file.
  ESLint-enforced (`sonarjs/no-nested-template-literals`) — `warn` for the same
  rollout reason as above
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
  named classification function. ESLint-enforced (`sonarjs/no-nested-conditional`,
  `eslint.config.mjs`) — `warn` while pre-existing violations get cleared,
  same rollout pattern as the jsx-a11y block

### Accessibility Checklist (apply to all new UI)
- Non-native click targets → `role`, `tabIndex`, `onKeyDown` or convert to `<button>`
- Mouse hover events → paired focus events
- Form labels → `htmlFor` on every `<label>`
- Inputs without a visible label → `aria-label` attribute required
- Tab bars → `components/ui/Tabs.tsx`, not hand-rolled — it already has
  `role="tablist"`/`role="tab"`, `aria-selected`, and a visible focus ring

---

## Architectural Conventions & Standing Audit Checklist

This is the consolidated list of things every self-audit pass on new or
changed code runs through in this repo. Several of these are elaborated in
full detail elsewhere in this file (linked below) — this section exists so
the full set has one place to be checked against, instead of being
re-derived from scratch each time. When in doubt, treat "did I check every
item below" as part of the definition of done for any non-trivial change.

### Data Integrity & Concurrency

- **N+1 queries and loops** — never issue one query per iteration of a
  loop (`for (const x of xs) { await supabase.from(...).select() }`).
  Fetch every row needed in one query (`.in('id', ids)` or a join), build
  an in-memory lookup, then iterate. This applies equally to Inngest
  functions processing many tenants/records and to React Server
  Components rendering lists.
- **Dedup** — anything reachable more than once (a retried webhook, a
  cron that re-runs, a step Inngest replays) needs an explicit dedup key,
  not an assumption that it'll only ever run once:
  - `owner_transactions` → `source_reference_id` checked first
  - `notifications` → `dedupe_key` unique index (NULL = no protection needed)
  - Generic provider webhooks → content-hash keyed row in `processed_webhooks`
    (see `app/api/webhooks/[provider]/route.ts`) — not `payload.id`, whose
    semantics vary by provider and aren't trustworthy as a dedup key on their own
  - Anywhere else → `ON CONFLICT DO NOTHING` / a `UNIQUE` constraint the
    write can safely collide against
- **Idempotency** — related to dedup but distinct: a step that already ran
  halfway (crashed mid-way, got retried) must be safe to run again without
  double side effects. Every Inngest step that creates a record must check
  for an existing one first (see Inngest Functions section above); this
  matters even when a dedup key also exists, since the dedup key only
  stops a second *identical* delivery, not a partially-applied first one.
- **Concurrency / race conditions** — a load-then-decide-then-write
  sequence (check something, then act on what you saw) is a TOCTOU risk
  the moment two requests can run it at the same time — guard with a DB
  constraint or atomic update (`UPDATE ... WHERE` with the precondition
  in the `WHERE` clause), not just an application-level `if` before the
  write. Async work that can complete out of order (two overlapping
  refreshes, a stale closure winning a race against a newer one) needs an
  explicit generation/version guard — see `refreshChecklistSubscription`'s
  and `refreshAssetsSubscription`'s generation-token pattern in
  `lib/dexie/context.tsx`.
- **Foreign keys & referential integrity** — every reference column gets
  a real `REFERENCES` constraint with a deliberately chosen `ON DELETE`
  behavior (`CASCADE` / `SET NULL` / `RESTRICT`) — never left to default,
  and never enforced only in application code, which doesn't catch rows
  written by another path (a migration backfill, the Supabase dashboard,
  a different service).
- **Atomic multi-step writes** — when one logical action touches more
  than one table (or an external system plus a table), either make it a
  single transaction/RPC, or make every step idempotent and give the
  overall flow an explicit cleanup/rollback path for a step that fails
  partway through. Don't leave a half-committed sequence with no way back
  — see the orphaned-Vault-secret fix in `lib/integrations/vault.ts`'s
  pending-link claim flow and the vendor-connect-invite
  orphan-on-email-failure fix (`lib/stripe/vendor-connect-invite.ts`) as
  examples of exactly this failure mode being closed.

### Security & Isolation

- **Tenant isolation** — every query touching org-scoped data filters on
  `org_id` (or the equivalent token scope) derived from
  `requireOrgMember()`/the validated token — never trust an `org_id` a
  client supplied directly. See Critical Security Rules #4.
- **Row Level Security** — every table has RLS enabled with real
  SELECT/INSERT/UPDATE/DELETE policies. See Critical Security Rules #2.
  A Postgres `GRANT` to `authenticated`/`anon` is a separate prerequisite
  RLS depends on but doesn't replace — Postgres checks the grant *before*
  RLS ever evaluates, so a table can have perfect RLS policies and still
  throw "permission denied for table X" on every query if the grant is
  missing (this exact bug shipped and was fixed via
  `supabase/migrations/20260710200000_grant_authenticated_missing_tables.sql`).
- **IDOR (authorization by object ID)** — `requireOrgMember()` proves the
  caller belongs to *an* org; it does not by itself prove the specific
  object they're requesting by ID belongs to *their* org or *them*
  specifically. Any lookup keyed by an ID from the request needs its own
  ownership check, not just an org-membership check.
- **Rate limiting on unauthenticated/token-guessable routes** — public
  token routes (owner portal, vendor-connect, work-order public links)
  and auth entry points (login/signup) need their own rate limiter (see
  `lib/rate-limit.ts` and `proxy.ts`'s `rateLimiterForPathname()`) —
  token entropy alone is not a substitute for throttling.
- **Sensitive-data logging** — never log guest phone numbers, SMS body
  content, `actual_cost`/financial specifics, Stripe tokens, or any
  secret/API key. See Code Quality Standards and the "Things That Will
  Break" table.
- **Stale grants and permissions** — when narrowing or removing access,
  check both the RLS policies *and* the raw Postgres `GRANT`s — a leftover
  `anon`/`authenticated` grant on a table or column survives even after
  the RLS policy itself looks correct, and won't show up just from
  reading the policy SQL.
- **Sanitization** — this codebase's XSS defense today depends entirely
  on never introducing `dangerouslySetInnerHTML` (there are currently
  zero uses of it anywhere in the app) — React's default JSX rendering
  already escapes user/guest-generated text (guidebook content, notes
  fields, checklist crew notes, guest messages). Adding raw-HTML
  rendering for any of this content requires a real sanitization library
  (e.g. DOMPurify) at that point — never ship it unsanitized. Similarly:
  never build a query with raw string interpolation (`.rpc()` or SQL
  built via template literals) — every current query goes through the
  Supabase client's parameterized builder, which is what actually
  prevents SQL injection here, not manual escaping. Validate and
  normalize input at the boundary (the Server Action/Route Handler) —
  format-check phone/email, enforce length limits, strip control
  characters — rather than trusting it to already be clean by the time
  it reaches a DB write.
- **Audit logging** — security- and account-relevant actions should call
  `logAuditEvent()` (or `logAuditEvents()` for more than one entry in a
  loop — batches into a single insert instead of one round-trip per
  entry, the same N+1 concern as above) from `lib/audit.ts`, using one of
  the existing `AuditAction` values where it fits (`auth.*`, `team.*`,
  `integration.*`, `billing.*`, `security.route.mismatch`, etc.) or a new
  one added to that union. Covers things like: role/membership changes,
  integration connect/disconnect/revoke, owner portal token access,
  billing changes, account/data deletion, and anywhere a request lands on
  a route it structurally shouldn't be able to reach (see
  `app/crew/layout.tsx`'s `security.route.mismatch` log for a PM landing
  on `/crew`). Never put PII or secrets in the `metadata` field — same
  rule as the sensitive-data-logging item above; audit rows are meant to
  be readable by staff investigating an incident, not a second place for
  the same data that shouldn't be logged at all.

### Code Quality

- **Cognitive complexity ≤ 15, nesting depth ≤ 4** — see Code Quality
  Standards above for the full detail; extract named helpers/predicates
  and use guard clauses rather than nesting further.
- **Silent failures** — a caught error must do something visible: log it
  with real context (not just `console.error('failed')` with no detail),
  surface it to the UI, or both. Distinguish "the query returned zero
  rows" from "the query itself errored" — collapsing both into the same
  empty-state UI hides real outages behind what looks like normal empty
  data.
- **Styling conventions** — see the Styling Conventions section above and
  the "Things That Will Break" table for the full detail; CSS variables
  only for color (Tailwind's own color utilities like `text-red-500`
  count as hardcoded hex, not an exception), and reuse `components/ui/*`
  primitives (`Button`, `Card`, `Badge`, `Dialog`, `Tabs`, etc.) instead of
  hand-rolling an equivalent with raw Tailwind utilities — the latter
  slips past `check:ui-classes` since that script only greps for literal
  `btn-*`/`badge-*`/`card` class strings, not visually-equivalent
  hand-rolled markup.

---

## Structural Enforcement — Guardrails

Conventions in this file are enforced in code wherever they can be, so
following them stops being a memory test. Five layers, checked in CI via
`npm run lint` and `vitest run` (plus the `db-invariants` CI job for layer
4, which runs two scripts, and the `semgrep` job for layer 5):

1. **ESLint rules** (`eslint.config.mjs`, the "Structural enforcement"
   config block) — AST-level bans scoped to `app/`, `lib/`, `components/`:
   `.from('memberships')`, `assigned_crew_id`, `.from('work_order_notes')`,
   `dangerouslySetInnerHTML`, `supabase.raw()`, reading
   `SUPABASE_SERVICE_ROLE_KEY` outside `lib/supabase/server.ts`,
   `Math.random`, bare `window`. A legitimate
   exception gets an inline `eslint-disable-next-line` WITH a one-line
   justification (see the sampling/jitter sites for the pattern). The same
   block also runs `eslint-plugin-sonarjs` for the Code Quality Standards
   thresholds above (cognitive complexity, nesting depth, nested
   ternaries/template literals) — previously SonarCloud-only (caught on the
   PR, not locally); currently `warn` pending a cleanup pass on the 236
   pre-existing violations the rollout surfaced, then ratchets to `error`.

2. **Guardrail tests** (`unit/guardrails/`) — cross-file invariants no
   per-file rule can express:
   - `service-role-authorization` — every `createServiceClient()` call
     site in `app/` contains a recognized authorization step (or a
     justified entry in its EXCEPTIONS list). This is the structural
     backstop for Critical Security Rule #1.
   - `crew-auth-drift` — the `invite_accepted_at` crew-lockout regression.
   - `forbidden-patterns` — Telnyx API confined to `lib/sms/telnyx.ts`
     (the SMS_ENABLED + budget chokepoint), service-key string confined,
     Inngest functions confined to `lib/inngest/functions/`, exactly one
     `serve()` in the Inngest route.
   - `migration-hygiene` — filename format, unique version prefixes,
     CREATE TABLE ⇒ ENABLE ROW LEVEL SECURITY in the same file.
   - `tailwind-color-ratchet` — files that predate the color-token rule
     are baselined; new files may not hardcode Tailwind color utilities,
     and cleaned-up files must leave the baseline. Never add entries.
   - `n-plus-one-loops` — no Supabase query (or `rpc()` call) inside a
     per-row loop body (`for...of`, `for await...of`, `.forEach`,
     `.map(async`) outside a named, justified `EXCEPTIONS` entry. Classic
     numeric pagination loops and a loop whose body is an Inngest
     `step.run(...)` boundary are structurally exempt.
   - `inngest-insert-idempotency` — every `.from(table).insert(...)` inside
     an Inngest `step.run(...)` body is either guarded (a same-table
     pre-check `select`/`delete`, `onConflict`/`ignoreDuplicates`, a
     `23505` catch, a `dedup(e)?_key` column, or `createPmNotification()`)
     or a named, justified `EXCEPTIONS` entry — the structural backstop for
     the Inngest Functions section's idempotency rule.
   - `inngest-nested-steps` — no step tooling inside a `step.run()` callback,
     checked in BOTH shapes: written there directly, and reached through a
     same-file helper that closes over `step`. The second shape is the point —
     it is how `ownerrez-reviews-sync.ts` read as clean to a lexical scan while
     duplicating an audit row on every connection revocation. Also bans step
     tooling in shared `lib/` modules outside `lib/inngest/`, so the defect
     cannot be relocated somewhere a reviewer of the Inngest function will not
     look. Carries self-check fixtures: the scan is asserted to FIRE on both
     shapes, since a broken checker and a clean tree both return zero.
   - `sensitive-data-logging` — no `console.log`/`error`/`warn`/`info`,
     `reportError()`, or `logAuditEvent(s)(` call references `actual_cost`,
     a guest phone field, SMS body content, or a Stripe/client-secret token
     without masking it — the structural backstop for the sensitive-data
     rule in Code Quality Standards and the Standing Audit Checklist. A
     clean-baseline ratchet, same model as `tailwind-color-ratchet`.
   - Added by the 2026-07-30 pre-launch remediation, one line each — read the
     header comment in each file for the defect it encodes:
     `unbounded-select` (the `max_rows = 1000` rule, `lib/inngest/**`),
     `unbounded-fanout-loops` (a per-tenant fan-out must be bounded/batched),
     `upload-payload-null-fields` (`'x' in payload` in Dexie upload builders),
     `crew-dead-letter-coverage` (cached-table pruning + a retry affordance for
     every `MutationTable`), `external-fetch-timeout` (no `fetch()` without a
     timeout budget), `supabase-error-handling` + `error-reporting-coverage`
     (reads go through `lib/supabase/unwrap.ts`; catches report),
     `org-scoped-storage-paths` (every write to an org-scoped photo bucket goes
     through `orgScopedStoragePath()`), `service-role-org-scope` and
     `organization-members-access` (tenant scoping on service-role reads),
     `auth-user-deletion-org-orphaning`, `webhook-dedup-claim-release`,
     `env-schema-coverage` (`lib/env.ts` stays complete in both directions),
     and `ci-gating` — the enforcement layer's own enforcement: the `checks`
     job still runs every step, no step is `continue-on-error`, `lint` keeps
     its `--max-warnings` ratchet, and the two install-free `db-invariants`
     scripts stay dependency-free and self-disarming.
   - `generated-column-writes` — no `.insert()`/`.update()` payload may name a
     `GENERATED ALWAYS` column. The column list is verified against the live
     `information_schema.columns.is_generated`, NOT against
     `supabase/schema_reference.sql`, which renders generated columns as plain
     `DEFAULT`s and is exactly why this class shipped twice.
   - `absence-reconciliation` — every "delete/cancel/deactivate every local row
     missing from the fetched list" site is registered with HOW it survives an
     empty fetch, and no provider fetch returns `[]` from an error branch.
     Empty is the degenerate input of reconcile-by-absence: it makes every row
     absent. On 2026-07-18 one org's entire Hospitable crew roster was
     deactivated at the same microsecond because `hospFetchTeammates` returned
     `[]` on a non-ok response and the deactivation pass had no guard. The two
     valid protections are NOT interchangeable — `fetch-fails-loud` where empty
     is a legitimate steady state (no calendar blocks, no assignments; a guard
     there would make the LAST one unclearable), `empty-set-guard` where empty
     is implausible and the fetch can't be trusted. Carries a self-check that
     the scan still fires.
   - `public-route-rate-limiting` — every prefix in `proxy.ts`'s
     `TOKEN_ROUTES` has a matching branch in `rateLimiterForPathname()`,
     and the two guessable-invite-token `BYPASS_ROUTES` entries
     (`/accept-invite`, `/crew-invite`, which skip `TOKEN_ROUTES` entirely)
     still rate-limit inline via `inviteAcceptRatelimit` — the structural
     backstop for the Standing Audit Checklist's rate-limiting item.
   - `unreferenced-server-actions` — every exported Server Action has a
     reference somewhere in `app/`/`lib/`/`components/`. **A unit test does
     NOT count as a caller**, and that is the whole point: three superseded
     implementations were found dead in one week (`/wo/[token]`,
     `reportTurnoverIssue`, `updateProperty`), each with a full passing test
     suite. A dead action is not merely untidy — it keeps the API surface of
     the live one while missing the safety its replacement had to learn, so
     whoever revives it inherits the old bug. `updateProperty` would have
     deleted a property's door code on a rename. Shrink-only baseline of the
     15 already dead when it was written; never add to it.

3. **`check:ui-classes`** — the raw `btn-*`/`badge-*`/`card` class grep.

   **`check:complexity`** (`scripts/check-complexity-ratchet.mjs`, same
   `checks` job) — per-file ratchet for `sonarjs/cognitive-complexity`, against
   the shrink-only `scripts/complexity-baseline.json`. An unbaselined file may
   have NO violation; a baselined file may not gain one; a baselined function
   may not get WORSE (a count-only check cannot see 45 → 60); and an
   improvement fails too, so the burn-down lands in the baseline diff instead
   of leaving headroom a later regression grows back into. Seed with `--init`,
   lock in a burn-down with `--update` (which refuses to grow the set). Kept
   armed by `unit/guardrails/ci-gating.test.ts`.

4. **DB invariant gate** (`scripts/check-db-invariants.mjs`, CI
   `db-invariants` job) — the live-schema invariants no code-side check can
   see, via `public.db_invariant_report()` against the dedicated E2E
   project: RLS enabled on every public table, no policy-less (deny-all)
   tables outside the script's shrink-only `SERVICE_ROLE_ONLY_TABLES`
   allowlist, a covering index on every FK column, zero `anon` table
   grants (all revoked 2026-07-24 — no client reads tables
   unauthenticated), and every `dedupe_key`/`dedup_key`/
   `source_reference_id`-named column backed by a real UNIQUE or
   partial-unique index. Self-disarms with a warning when the E2E secrets
   are absent, same as the e2e job.

   **Type drift gate** (`scripts/check-type-drift.mjs`, same
   `db-invariants` CI job, run as its own step after
   `check-db-invariants.mjs`) — diffs `types/database.ts` against the live
   schema via `public.db_type_shape_report()`: every Postgres enum's labels
   vs. its TS union (`ENUM_MAP`), every `public` table vs.
   `Database.public.Tables` (`TABLE_ALLOWLIST` for the deliberately
   unmodeled — `platform_admins`, `system_job_runs`,
   `wo_number_counters`), and column presence for every mapped table
   (`COLUMN_ALLOWLIST` for deliberate mismatches — e.g. the deprecated
   `work_orders.assigned_crew_id`). Closes the exact class of bug that cost
   real debugging time when the E2E project's `wo_status` enum silently
   lacked `quote_requested` — see
   `20260725043000_add_quote_requested_to_wo_status.sql`. Both allowlists
   are shrink-only, same ratchet as `SERVICE_ROLE_ONLY_TABLES`. Self-disarms
   the same way as the other two checks.

   **Migration ledger parity gate** (`scripts/check-migration-ledger.mjs`,
   same `db-invariants` CI job, third step) — diffs `supabase/migrations/*.sql`
   against the live `supabase_migrations.schema_migrations` ledger via
   `public.migration_ledger_versions()`, in BOTH directions. A local file with
   no ledger row means `supabase db push` will replay it; a ledger row with no
   local file means the repo cannot reproduce the database. Production had 36
   and 35 of those respectively on 2026-08-03 (audit H10) — two of them
   SECURITY DEFINER functions that existed in production and in no file
   anywhere. **MCP `apply_migration` without committing the matching file, and
   renumbering an already-applied file, are the two causes** — see the
   Migration discipline rule under "Adding new schema". Grandfathered
   divergence is frozen per project in
   `scripts/migration-ledger-baseline.json`, shrink-only: production's entry
   is EMPTY (hard gate), the E2E project's holds 203 pre-existing entries it
   inherited when branched from prod. A new migration is by definition not in
   the frozen set, so parity is mandatory for it on every project.
   `--update` refuses to grow a set; `unit/guardrails/ci-gating.test.ts`
   enforces the empty-prod and ceiling rules with no DB access.

5. **Semgrep rules** (`.semgrep/`, CI `semgrep` job) — real TypeScript AST
   matching, so a rule survives reformatting, renamed intermediates, and
   multi-line call chains that defeat the text-scanning guardrail tests. Two
   families, gated differently; read `.semgrep/README.md` before adding one.
   - `.semgrep/chokepoints.yml` — a capability with exactly ONE legitimate
     owner, named in that rule's `paths.exclude`. At **0 findings**, which is
     what lets it gate at `--error` across the whole tree. Covers: the service
     role key outside `lib/supabase/server.ts`, Telnyx outside
     `lib/sms/telnyx.ts`, a raw `<limiter>.limit(` outside `lib/rate-limit.ts`,
     a role-filtered `organization_members` read outside the auth helpers /
     `getPmMembersByOrgIds`, an outbound `fetch()` to a literal `https://` URL
     with no `AbortSignal`, `void` on a lazy PostgREST builder (the request is
     never sent), `getPublicUrl()` on the three private buckets, and the
     `memberships`/`work_order_notes`/`assigned_crew_id` names that do not
     exist, and — PROMOTED 2026-08-11 — the whole Supabase error-handling
     family: a discarded write result, `data` destructured without `error`,
     and the same in a `Promise.all` fan-in. Promotion is the ratchet's
     purpose, and it requires deleting the rule's `baseline-counts.json` key
     in the same change plus a fire-check (violation + a correct CONTROL,
     confirm the rule catches the first and not the second, revert) — a rule
     at 0 because it is BROKEN looks identical to one at 0 because the tree
     is clean.
   - `.semgrep/ratchet.yml` — a defect class with many legitimate owners and
     many live sites. As of 2026-08-11 it holds the unbounded-`.select()`
     ladder below and nothing else (92 findings); everything that ever
     reached 0 has been promoted out. Gated on
     `--baseline-commit` (only findings NEW vs. the PR base fail) plus
     `.semgrep/baseline-counts.json`, a committed per-rule count that
     `scripts/check-semgrep-ratchet.mjs` allows to move only DOWN. Lock in a
     burn-down with `node scripts/check-semgrep-ratchet.mjs --update`.
   - **Severity inside a ratchet family matters as much as the pattern.** The
     single `fieldstay-supabase-unbounded-select` rule reported 284 findings,
     every one pattern-correct and most of them the case this file explicitly
     permits (one org's page). It is now six mutually exclusive, exhaustive
     tiers ranked by what actually bounds the result set —
     `-table-scan` (nothing but the table, ERROR, 38 → **0, PROMOTED to
     `chokepoints.yml` 2026-08-01**),
     `-cross-tenant` (no org scope AND no parent row, ERROR, 53 → **0,
     PROMOTED to `chokepoints.yml` 2026-08-02**),
     `-single-parent` (one non-org parent id, no org scope, WARNING, 47 → **0,
     PROMOTED to `chokepoints.yml` 2026-08-12**),
     `-global-table` (the table has no `org_id` column, ERROR, 5 → **0,
     PROMOTED to `chokepoints.yml` 2026-08-07**),
     `-in-list` (one org but sized by an `.in()` array, WARNING, 46 → **0,
     PROMOTED to `chokepoints.yml` 2026-08-12**),
     `-org-scoped` (one org, one parent — hygiene only, INFO, 113).
     **`-single-parent` reached 0 on 2026-08-12, and this one was a genuine
     burn-down** — all 16 sites bounded, none reclassified. Two were not
     hygiene. `lib/dexie/sync/turnovers.ts` read a crew member's ENTIRE
     assignment scope unbounded, and `reconcileRemovedTurnovers` bulkDeletes
     every cached turnover absent from that set along with its checklists — so
     past ~1000 lifetime assignments (a cleaner reaches that inside a year) the
     device would erase turnovers that were still assigned, and with no ORDER BY
     it would erase a different arbitrary set each sync rather than settling.
     Paginated via a new `fetchAllPages()` in `lib/dexie/sync/chunked.ts`. The
     OwnerRez booking upsert is written up separately below. The rest took an
     explicit `.limit()`, chosen by what truncation would actually corrupt: a
     total (YTD spend, work-order line items), a legal artifact (the GDPR
     export, account-deletion's owned-org set), or merely a list. Fire-checked
     before promoting, same protocol as the tiers before it: an unbounded
     single-parent read FIRED, a `.limit()`-bounded control did NOT, and an
     org-scoped control landed in `-org-scoped` — confirming both that the rule
     works and that the ladder is still a partition.
     **`-in-list` reached 0 the same day**, immediately after `-single-parent`.
     Each `.limit()` is sized by what truncation would corrupt rather than by a
     uniform number: `.limit(ids.length)` where the read really is one row per
     id (OwnerRez property resolution, catalog picks, the turnover fan-out), and
     a real ceiling where the `.in()` is on a STATUS enum — in which case the
     row count scales with the ORG'S DATA, not with the list, and the tier name
     misleads. Two were that shape: the maintenance board's open work orders
     and `lib/notifications.ts`'s vendor-compliance read, both of which would
     have silently under-reported rather than shown a visibly short list.
     Fire-checked before promoting, same protocol.

     The ladder is now `-org-scoped` alone, and a site-by-site audit of all 65
     on 2026-08-12 found that "hygiene-only" was ALMOST right but not entirely.
     Six were bounded and the rest verified against live per-property ratios
     rather than assumed. The distinction that matters inside this tier is
     whether the table grows with the ORG'S SIZE (plan-capped, so safe) or with
     TIME. Safe: properties, crew_members (1.2/property), vendors (0.6),
     checklist_template_sections (7.3 — the highest, ~365 at 50 properties),
     and every template/config table. Also safe once checked: the `bookings`
     and `turnovers` page reads, which look unbounded but carry date windows.
     NOT safe, and now bounded: `maintenance_schedules` at ~18 per property
     (~900 at the 50-property target, crossing `max_rows` at about 56) and
     `property_assets`, where asset_type_standards' 21 types put a fully
     catalogued 50-property portfolio at ~1050. Neither is a page-render
     nicety — a truncated read drops scheduled maintenance and assets off the
     page silently. Treat a NEW finding in this tier as a prompt to ask which
     of those two kinds of growth applies, not as automatically ignorable.
     Tier 1 WAS the burn-down target and reached 0, so it now gates at
     `--error` across the whole tree rather than only on findings new vs. the
     PR base — a single unbounded table read anywhere fails the build. Its
     `baseline-counts.json` key was deleted in the same change, per the
     promotion rule.
     **`-cross-tenant` then reached 0 on 2026-08-02 without a single site
     being fixed** — its 53 findings were 47 parent-scoped reads, 5 reads of
     org-less platform tables, and 1 correctly org-scoped read the matcher
     could not see. Splitting `-single-parent`/`-global-table` out is what
     made the tier mean its name; the same reads are still counted. Promoting
     it required two checks a count of 0 cannot give you: that the rule still
     FIRES (verified against a deliberately cross-tenant read plus org-scoped,
     dotted-org-scoped and parent-scoped controls — a rule at zero because it
     is broken looks identical to one at zero because the tree is clean), and
     that its `metavariable-regex` negatives — which only recognise a
     string-literal column name — cannot be tripped by a dynamic
     `.eq(someVar, …)`; there are currently zero such call sites.
     **Two invariants make a "0"
     here trustworthy, and both are enforced rather than asserted:** the
     ladder must stay a partition (one site, one tier — enforced by
     `scripts/check-semgrep-ratchet.mjs`, which caught a real 2b/2c overlap
     that had inflated the total by one), and the org matcher must be
     dotted-aware (`.eq('rel.org_id', …)` through an `!inner` join IS org
     scope; the literal `'org_id'` matcher counted a single-tenant read as a
     cross-tenant scan). The global-table list is derived from the live
     schema — no `org_id` column and no FK to a table that has one — never
     hand-curated, and those tables stay COUNTED because `profiles` /
     `processed_webhooks` / `support_kb_chunks` still truncate at 1000.
     **`-global-table` then reached 0 on 2026-08-07, and unlike `-cross-tenant`
     this one was a real burn-down** — its 5 sites were bounded, not
     reclassified: an explicit `.limit()` on the four Server Component pages
     reading `maintenance_catalog_items`, `inventory_catalog` and
     `integration_providers` (×2), and `fetchAllRows()` on the one Inngest
     step reading `platform_inventory_template_items`, matching its sibling
     `inventory_catalog` read in the same function. Same before-promoting
     fire-check as `-cross-tenant`: a deliberately unbounded
     `integration_providers` read was reintroduced in a scratch file,
     confirmed to fail `semgrep --config .semgrep/chokepoints.yml --error`,
     then reverted.
     `lib/inngest/**` gets no tier of its own because
     `unit/guardrails/unbounded-select.test.ts` already gates it at file
     granularity. See `.semgrep/README.md` for the semgrep mechanics
     these tiers depend on (a positive `pattern-inside` must not be wrapped
     in `pattern-either`, though a nested `patterns:` block is safe;
     `.in('org_id', …)` is not org scope).
   - **`paths.exclude` expresses ownership; `pattern-not-inside` expresses
     handling.** They are not interchangeable. What makes `lib/sms/telnyx.ts`
     allowed to call Telnyx is its path — its identity as the SMS_ENABLED +
     nudge-budget chokepoint — not anything about the enclosing expression.
     What makes a `.select()` acceptable is that it sits inside a `.limit()`
     call. Using the wrong one gives either a rule that suppresses the same
     construct everywhere it appears in a similar shape, or a permanently
     blind file.
   - **Never** silence a ratchet with `nosemgrep` or a new `paths.exclude`.
     Fix the site or leave it counted. Prefer narrow-and-precise over
     broad-and-suppressed: the naive table-wide ban on
     `.from('organization_members')` gives 17 noisy hits, the role-filtered
     narrowing gives 3 genuine ones.
   - Deliberately overlapping with several `unit/guardrails/` tests, and NOT
     replacing them — those tests carry cross-file invariants (every
     `MutationTable` has a retry affordance, every `TOKEN_ROUTES` prefix has a
     limiter branch, the CI-gating meta-checks) that are not patterns and have
     no semgrep expression.

**The meta-rule: a new convention ships WITH its guardrail.** If a rule is
worth adding to this file, add its ESLint rule or `unit/guardrails/` test in
the same PR — and the CLAUDE.md prose for mechanically-checkable rules
should stay one line pointing at the check. Prose is for judgment calls;
enforcement is for everything else.

---

## Manual Audit Checklist — Items With No Guardrail Yet

Every item in the Architectural Conventions & Standing Audit Checklist above
is either fully automated (a check above catches every instance), partially
automated (a check narrows the item but a real gap remains), or entirely
manual (no mechanical check exists — usually because the item requires
understanding intent/business logic, not just pattern-matching source text).
This section exists so a self-audit or a fresh audit pass knows exactly
which items still need a human/AI reviewer's judgment instead of assuming CI
already covers them. When one of these becomes mechanically checkable, move
it into Structural Enforcement above and delete it from here — per the
meta-rule, prose is for judgment calls only.

### Data Integrity & Concurrency

- **Dedup — non-Inngest write paths.** `inngest-insert-idempotency` only
  scans `.insert()` calls inside Inngest `step.run(...)` bodies. Whether a
  generic provider webhook route actually checks `processed_webhooks`
  before acting, or an ordinary Server Action write is safe against a
  double-submit/retry, is unchecked.
- **Concurrency / race conditions (TOCTOU).** Deliberately left manual —
  a load-then-decide-then-write sequence being race-safe requires reasoning
  about what else could run concurrently, which isn't a source-text pattern.
- **Foreign keys — `ON DELETE` behavior.** The DB invariant gate checks that
  every FK column has a covering index, but not whether its `ON DELETE`
  clause was a deliberate choice (`CASCADE`/`SET NULL`/`RESTRICT`) versus
  left to Postgres's default — there's no way to distinguish "considered
  and chose default" from "never considered" at the SQL level.
- **Atomic multi-step writes / rollback paths.** Whether a multi-table (or
  table-plus-external-system) write has a real cleanup path for a partial
  failure is architectural, evaluated case by case.

### Security & Isolation

- **IDOR (authorization by object ID).** Whether a specific ID-keyed lookup
  re-verifies ownership (vs. just org membership) requires understanding
  what the ID refers to and where it came from — this is exactly the class
  of finding CodeRabbit's review caught manually on PR #512
  (`trackAssignmentAgainstSuggestions`'s service-role write), which is the
  right tool for this category, not a regex guardrail.
- **Rate limiting — login/signup.** `public-route-rate-limiting` covers
  every token-guessable route reachable through our own Next.js server, but
  login/signup/forgot-password/reset-password call
  `supabase.auth.signInWithPassword()`/`signUp()`/`resetPasswordForEmail()`
  directly from the browser — there's no server-side code path in this repo
  for our own limiter to attach to. The only throttle on those four
  endpoints today is Supabase's own platform-level GoTrue rate limiting,
  which isn't visible or verifiable from this codebase.
- **Sanitization — input validation at the boundary.** The
  `dangerouslySetInnerHTML`/`supabase.raw()` bans are enforced, but whether
  a given Server Action/Route Handler actually validates and normalizes its
  input (format-checks phone/email, enforces length limits, strips control
  characters) at the boundary is unchecked.
- **Audit logging coverage.** Whether every security- or account-relevant
  action (role changes, integration connect/disconnect, billing changes,
  data deletion) actually calls `logAuditEvent(s)()` can't be enumerated
  mechanically — there's no fixed pattern distinguishing "this action is
  audit-worthy" from "this one isn't."

### Code Quality

- **Silent failures — logged with real context.** `sensitive-data-logging`
  checks that existing log calls don't leak banned fields, but not the
  inverse: that a caught error actually gets logged with enough context to
  debug, or that a zero-rows result is distinguished from a query error
  rather than collapsed into the same empty-state UI.
- **Component reuse over hand-rolling.** `check:ui-classes` greps for
  literal `btn-*`/`badge-*`/`card` class strings outside `components/ui/*`,
  but a hand-rolled tab bar or dialog built from raw Tailwind utilities that
  reaches the same visual result slips past it entirely — this is the exact
  gap called out in the Styling Conventions section's `Tabs.tsx` example.
