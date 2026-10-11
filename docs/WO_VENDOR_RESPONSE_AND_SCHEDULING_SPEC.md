# Spec — Work Order Vendor Response & Crew Scheduling

**Status:** approved for build, 2026-10-11
**Source analysis:** `audits/WO_AND_CREW_SCHEDULING_ANALYSIS.md`
**Covers:** build-order items 1-7 from that analysis

Item 2 is specified to implementation detail because it was designed in full.
Items 1 and 3-7 are specified to the detail that has actually been decided; where a
decision is still open it says so rather than inventing one.

---

## Migration status

| Migration | E2E (`syhthijeqlnltufdawyb`) | Production (`vpmznjktllhmmbfnxuvk`) |
|---|---|---|
| `20261011120000_split_work_order_dates` | applied 2026-10-11 | **applied 2026-10-11** |
| `20261011130000_vendor_progress_and_tech_grants` | applied 2026-10-11 | **applied 2026-10-11** |

Both commits introducing these say "NOT YET APPLIED TO PRODUCTION" in their
messages. That was true when written and is no longer; a commit message cannot
be corrected after the fact, so this table is the current record.

Applied through the Supabase MCP, which records the ledger row at the WALL CLOCK
rather than the filename prefix. Both rows were reconciled to their filename
versions immediately after, per CLAUDE.md. Verified afterwards:

- ledger parity 470/470 in **both** directions on production, which is the
  hard gate (`scripts/migration-ledger-baseline.json`'s production entry is
  empty by design)
- the Phase A backfill set `needed_by_date` on 276/276 work orders with zero
  mismatches against `scheduled_date`; `vendor_scheduled_at` and
  `vendor_progress` are NULL on every row, which is correct — no vendor has
  confirmed anything yet, and inventing a value would have made every
  historical work order read as scheduled
- both enums carry their labels in declared order
- `vendor_technicians` and `work_order_access_grants`: RLS enabled, **zero**
  policies, and **zero** `anon`/`authenticated` grants, so there is nothing for
  a stray policy to permit
- every FK column on both new tables has a covering index (DB invariant check 3)
- `generate_typescript_types` against production is **byte-identical** to the
  committed `types/database.generated.ts` generated from E2E, so the two
  projects are in genuine lockstep and the project-skew class that makes
  `check-type-drift.mjs` fail as a types problem is closed

---

## Build order and dependencies

```
Phase A  →  item 1  date split                     (blocks item 2)
Phase B  →  item 2  vendor response + progress     (blocks item 5)
Phase C  →  item 5  progression writable by worker (depends on B)
Phase D  →  item 4  per-crew daily capacity        (blocks item 1's planner)
Phase E  →  item 1  day planner + planned times    (depends on D)
Phase F  →  item 3  cascade alert
Phase G  →  item 6  routed travel time
Phase H  →  item 7  half-day availability, late signal, co-assignee names
```

Item 1 splits in two. The **date split** (A) is a prerequisite for item 2 and ships first.
The **day planner** (E) depends on the capacity model from item 4, so it ships after.

---

# Phase A — Split the work-order date

## The defect

`work_orders.scheduled_date` is read two contradictory ways today:

| Reader | Treats it as | Reference |
|---|---|---|
| Vendor on-time % (`completed_date <= scheduled_date`) | **deadline** | `app/(dashboard)/vendors/page.tsx:99-104` |
| Maintenance calendar (`scheduled_date === iso`) | appointment | `maintenance-calendar.tsx` |
| Crew PWA today/upcoming split | appointment | `app/crew/page.tsx:329-336` |
| `/ops` ordering | appointment | `app/(dashboard)/ops/page.tsx` |
| Vendor dispatch email / SMS window | appointment | `work-order-events-helpers.ts:97-105` |

## Decision

Add two columns, deprecate the old pair in place. **Do not rename** `scheduled_date`:
PostgREST select strings are string literals and `lib/supabase/server.ts` omits the
`<Database>` generic, so `.from()` calls are not type-checked — a rename would convert
~40 compile-time-invisible sites into runtime errors. Deprecate-in-place matches the
existing house precedent (`work_orders.assigned_crew_id`).

### Migration

```sql
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS needed_by_date            date,
  ADD COLUMN IF NOT EXISTS vendor_scheduled_at       timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_scheduled_window   text
    CHECK (vendor_scheduled_window IS NULL OR vendor_scheduled_window IN
      ('morning','afternoon','evening','all_day','exact'));

UPDATE work_orders SET needed_by_date = scheduled_date WHERE scheduled_date IS NOT NULL;
```

Index `needed_by_date` and `vendor_scheduled_at` (both filtered/ordered on).
`scheduled_date` / `scheduled_time` stay, stop being written by new code, and carry a
deprecation comment naming this spec.

### Semantics

- **`needed_by_date`** — the date the PM needs the work done BY. PM writes. Nullable.
  Defaults, at create time, to the property's next booking check-in date
  (`bookings`, earliest `checkin_date` strictly after today for that property); null when
  there is no upcoming booking. The PM can clear or change it. This default is the point:
  for an STR operator the real deadline is almost never a date someone picks, it is the
  next arrival.
- **`vendor_scheduled_at`** — when the vendor is actually coming. The VENDOR writes it on
  accept (Phase B); PM may override. `vendor_scheduled_window` qualifies it, because trades
  commit to "Tuesday afternoon", not 14:15. `'exact'` means the timestamp is literal.

### Reader changes

| File | Change |
|---|---|
| `app/(dashboard)/vendors/page.tsx:99-104` | on-time % reads `needed_by_date`; a WO with no needed-by is excluded from the denominator, same as today's null guard |
| `maintenance-calendar.tsx` | key on `vendor_scheduled_at::date`, `COALESCE` to `scheduled_date` during transition |
| `app/crew/page.tsx:329-336` | today/upcoming on `COALESCE(vendor_scheduled_at::date, needed_by_date)` — crew WOs have no vendor, so needed-by is the right fallback |
| `app/(dashboard)/ops/page.tsx:120` | order by `COALESCE(vendor_scheduled_at, needed_by_date)` |
| `work-order-events-helpers.ts:97-105`, `work-order-vendor-assigned.ts:265` | the dispatch window renders from `vendor_scheduled_at` + window; on dispatch there is no appointment yet, so it renders `needed_by_date` as "needed by" instead |
| `CreateWorkOrderModal.tsx:422` | the `scheduled_date`/`scheduled_time` inputs become one "Needed by" date, prefilled from next check-in, with the source named ("next check-in Fri Oct 17") |

The `COALESCE` fallbacks are transitional and come out once a backfill confirms
`scheduled_date` has no readers left.

### Keep priority

`priority_level` (`low|medium|high|urgent`) stays and is unchanged. It is the emphasis;
the date is the fact. `urgent` already exempts a WO from aging escalation
(`cron/work-order-ops.ts:285`), and that stays true.

### Types / tests

- `types/database.ts` `WorkOrder`: add all three columns with DB nullability, mark
  `scheduled_date`/`scheduled_time` deprecated in a doc comment.
- Apply the migration to BOTH `vpmznjktllhmmbfnxuvk` (prod) and `syhthijeqlnltufdawyb`
  (E2E) in the same sitting, per CLAUDE.md — `check-type-drift.mjs` runs against E2E.
- New unit test: the needed-by default resolves from the next booking, and is null with no
  upcoming booking.

---

# Phase B — Vendor response states

## B1. `wo_status` stays six values. A second axis carries the detail.

**Do not widen `wo_status`.** There are **16 hardcoded open-status filter lists**:

```
app/actions/work-order-public.ts:344        app/api/work-orders/route.ts:234
app/(dashboard)/ops/page.tsx:120            app/(dashboard)/maintenance/actions.ts:597
app/(dashboard)/maintenance/actions.ts:1202 app/(dashboard)/maintenance/actions.ts:1354
maintenance-board.tsx:1170                  app/(dashboard)/maintenance/page.tsx:116
lib/notifications.ts:191                    cron/metrics-snapshot.ts:6
cron/daily-wrapup.ts:435                    cron/work-order-ops.ts:195
cron/work-order-ops.ts:284                  inspection-completed.ts:468
inspection-completed.ts:524                 warm-inspections.ts:570
```

They are literal arrays. A seventh enum value means a work order silently drops out of the
board, `/ops`, the metrics snapshot, PM notifications and the 7-day aging escalation unless
all 16 move in lockstep, with nothing forcing it and no visible symptom.

So: `wo_status` remains the coarse lifecycle the platform reasons about, and a new
`vendor_progress` column is the detail axis the vendor writes.

### Migration

```sql
CREATE TYPE vendor_progress AS ENUM (
  'declined',
  'appointment_scheduled',
  'on_the_way',
  'tech_on_site',
  'awaiting_access',
  'hold_pm_approval',
  'parts_ordered',
  'repair_in_progress',
  'return_visit_scheduled',
  'job_completed',
  'cancelled_by_vendor'
);

CREATE TYPE vendor_decline_reason AS ENUM (
  'no_capacity', 'outside_service_area', 'not_my_trade',
  'price_below_minimum', 'cannot_access_property', 'other'
);

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS vendor_progress        vendor_progress,
  ADD COLUMN IF NOT EXISTS vendor_progress_at     timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_progress_note   text,
  ADD COLUMN IF NOT EXISTS vendor_accepted_at     timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_declined_at     timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_decline_reason  vendor_decline_reason,
  ADD COLUMN IF NOT EXISTS vendor_dispatched_at   timestamptz;
```

NULL `vendor_progress` on an assigned WO means dispatched, no response yet.

`vendor_progress_note` is free text bounded to 300 chars at the boundary and is **not** a
substitute for the reason enum — the enum is what feeds vendor scoring and is searchable.

### The mapping (enforced server-side, never trusted from the client)

| `vendor_progress` | sets `wo_status` |
|---|---|
| `declined` | `pending` + clear `vendor_id` |
| `cancelled_by_vendor` | `pending` + clear `vendor_id` |
| `appointment_scheduled` | `assigned` |
| `on_the_way` | `in_progress` |
| `tech_on_site` | `in_progress` |
| `awaiting_access` | `in_progress` |
| `hold_pm_approval` | `in_progress` |
| `parts_ordered` | `in_progress` |
| `repair_in_progress` | `in_progress` |
| `return_visit_scheduled` | `in_progress` |
| `job_completed` | `completed` — via `finalizeWorkOrderCompletion`, never a bare status write |

One helper owns this table (`lib/work-orders/vendor-progress.ts`:
`woStatusForProgress(progress)`), and every write path calls it. A guardrail test asserts
the mapping is total over the enum, so a new progress value cannot be added without
deciding its lifecycle status.

**`job_completed` must route through the existing completion path.** Writing
`status: 'completed'` directly skips the `work-order/completed` event (so no
`owner_transactions` maintenance expense), `completed_date`, the `work_order_updates` row
and the source-schedule advance. `unit/guardrails/work-order-completion-side-effects.test.ts`
already enforces this; the vendor progress path is a new call site for it.

### Quote states are DERIVED, not stored here

`quote_requests` already owns quote state (`pending|submitted|approved|declined|expired`),
its own token, its own line items, and `approve_quote_request()`. "Quote sent" and "quote
accepted" are **displayed** in the progress timeline but are not `vendor_progress` values
and nobody selects them:

- vendor submits a quote → `quote_requests.status = 'submitted'` (existing route)
- PM approves → `'approved'` (existing RPC)

The UI composes the timeline from both sources. Two writable copies of one fact would drift.

## B2. Accept is the date

**Decided:** there is no accept-without-scheduling state. Acceptance and the appointment are
one action, so there is no accepted-but-unscheduled limbo to police with a second nudge.

The accept screen is one form:

```
Can you take this job?
  [ I can be there on ]  (date)   (window: morning / afternoon / evening / all day / exact time)
  [ Accept ]
  [ Can't take this one ]  →  reason (enum) + optional note
```

On accept: write `vendor_accepted_at`, `vendor_scheduled_at`, `vendor_scheduled_window`,
`vendor_progress = 'appointment_scheduled'`, `wo_status = 'assigned'`, and a
`work_order_updates` row. If the appointment lands after `needed_by_date`, accept still
succeeds but the PM is notified — the vendor's honest date beats a refused form, and the PM
is the one who decides whether to re-route.

On decline: `vendor_declined_at`, `vendor_decline_reason`, `vendor_progress = 'declined'`,
`wo_status = 'pending'`, `vendor_id = NULL`, and **fire the vendor re-dispatch**.

### Decline must re-route, not just record

`dispatchWorkOrderToVendor` advances status behind a forward-only filter
`.in('status', ['pending','quote_requested'])` (`app/actions/work-order-public.ts:344`), so
returning the WO to `pending` is what makes it re-dispatchable at all.

A decline emits `work_order/vendor_declined`, whose handler:
1. records the decline against the vendor (feeds `cron/vendor-score-recompute.ts`),
2. invokes the existing scorer in `lib/inngest/functions/auto-assign-vendor.ts`, which
   already ranks by proximity, familiarity, workload, reliability and compliance, and
   excludes hard-blocked vendors,
3. writes `suggested_vendor_ids` / `suggestion_reasoning` / `suggestion_status = 'pending'`,
4. notifies the PM: who declined, why, and who is suggested next.

It must NOT auto-dispatch to the next vendor. `vendor_auto_assign_mode` is CHECK-constrained
to `('suggest','disabled')` and `auto-assign-vendor.ts` never writes `assigned_vendor_id` —
that asymmetry is a documented gap, not a decision to be quietly reversed here.
A declined WO gets a suggestion and a human.

Register `work-order/vendor_declined` in `FieldStayEvents` (`lib/inngest/events.ts`) BEFORE
the closing brace, and the function in the single `serve()` call in
`app/api/inngest/route.ts`.

### Dispatch silence is a separate timer

The 7-day aging escalation keys on `updated_at` (`cron/work-order-ops.ts:286`), so any note,
photo or line item resets it — a dispatched work order can sit unanswered for a week, and
documenting progress pushes the clock out further.

Add a distinct check in the same cron, on `vendor_dispatched_at`:

- `vendor_dispatched_at` set, `vendor_progress IS NULL`, older than **24h** → notify the PM,
  dedupe-keyed so it fires once per dispatch.
- Older than **72h** → escalate priority and suggest the next vendor (same handler as a
  decline, without recording a decline against the vendor).

Keyed on the dispatch timestamp and the absence of a vendor-written state, so nothing the
PM does resets it. 24h/72h are the opening values and belong in named constants.

## B3. Progress dropdown (vendor portal)

The vendor portal gets a progress control above the completion form. Rules:

- Forward-only by default. Going backwards requires an explicit confirm and writes a
  `work_order_updates` row saying so.
- Each change writes `vendor_progress`, `vendor_progress_at`, the derived `wo_status`, and a
  `work_order_updates` row. One route, one transaction.
- `awaiting_access` and `hold_pm_approval` **notify the PM immediately** (via
  `createPmNotification`, dedupe-keyed). These are the two states where the vendor is
  blocked and only the PM can unblock them; a dropdown value nobody is told about is the
  same silence this phase exists to remove.
- `hold_pm_approval` carries the amount the vendor needs approved, compared against
  `nte_amount`. The PM's approval raises `nte_amount` and clears the hold.
- `job_completed` is not selectable from the dropdown; it is the outcome of submitting the
  completion form, so there is one completion path rather than two.

Offline: the progress write goes through the existing vendor outbox
(`lib/dexie/vendorWoSyncService.ts` on `lib/dexie/outboxEngine.ts`), so it queues like the
completion does. Per CLAUDE.md the optimistic local write and the outbox row commit in ONE
Dexie transaction, `failed` is `0 | 1`, and the new mutation kind needs a retry affordance
or `unit/guardrails/dashboard-dead-letter-coverage.test.ts`'s vendor equivalent fails.

## B4. Per-work-order technician grants

**Decided: per work order, not per technician.** Access dies with the job. A credential that
outlives the work is hard to claw back later.

### Migration

```sql
CREATE TABLE IF NOT EXISTS work_order_access_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id   uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  vendor_id       uuid NOT NULL REFERENCES vendors(id)       ON DELETE CASCADE,
  technician_id   uuid REFERENCES vendor_technicians(id)     ON DELETE SET NULL,
  token           text NOT NULL UNIQUE,
  label           text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_access_grants ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS vendor_technicians (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id     uuid NOT NULL REFERENCES vendors(id)        ON DELETE CASCADE,
  org_id        uuid NOT NULL REFERENCES organizations(id)  ON DELETE CASCADE,
  phone_e164    text,
  label         text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE vendor_technicians ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS vendor_technicians_vendor_phone_key
  ON vendor_technicians (vendor_id, phone_e164) WHERE phone_e164 IS NOT NULL;
```

Both are **service-role only** — no `authenticated` SELECT policy at all. These hold a third
party's employees' mobile numbers; the PM needs attribution ("completed by Mike"), not the
vendor's staff list. Add both to `SERVICE_ROLE_ONLY_TABLES` in
`scripts/check-db-invariants.mjs` so the policy-less state reads as deliberate rather than a
missed table. Every FK column gets a covering index (check 4 of the DB invariant gate).

`expires_at` is capped at the parent WO's `completion_token_expires_at` — a technician token
can never outlive the vendor's own access.

### Flow (v1: copy-link only, technician self-enrolls)

1. Vendor taps **Send to technician** in the portal. On a WO with roster entries, a pick list
   appears; otherwise straight to step 2.
2. A grant is minted and a **copyable link** is shown. The vendor pastes it into his own
   text, WhatsApp or group chat. **FieldStay sends no SMS in v1.**
3. The technician opens `/work-orders/t/[token]` and sees one screen before the job:
   - **Your name** (required) → becomes `grants.label` and the attribution on every write
   - **Mobile (optional)** → "so Mike's Plumbing can text you future jobs directly"
4. A `vendor_technicians` row is created from that self-enrollment, keyed on
   `(vendor_id, phone_e164)` through `normalizePhoneToE164()` (`lib/sms/telnyx.ts:108`).
   Reject what that returns null for rather than storing a raw string — the phone IS the
   identity, so `(334) 555-1212`, `334-555-1212` and `+13345551212` must collapse to one row
   or the vendor gets three Mikes.
5. From job two onward the vendor picks a name from the roster, and we may text that number
   because its owner gave it to us.

The vendor never types a phone number. That removes typo handling, the confirm-the-number
step and the two-stage roster status entirely, and it makes the consent first-party rather
than the employer volunteering an employee's mobile.

### Why no SMS in v1 (and the gap it sidesteps)

`sendSMS` (`lib/sms/telnyx.ts:223`) checks demo-org suppression, `SMS_ENABLED`, env config
and the nudge budget. It checks **no opt-out list at all**. Inbound STOP is handled
(`app/api/webhooks/telnyx/route.ts:188-199`) but writes only to
`guidebook_guest_sms_optins`; the guest crons then re-check `is_active` before each send
(`guidebook-sms-morning-cron.ts:78,147`), so the guest path is protected. A **vendor or crew
member** who replies STOP matches zero rows — `.eq('phone_e164', …)` matching nothing is not
an error — so nothing is recorded and we keep texting, while every message ends with "Reply
STOP to opt out."

That is a live gap in `buildVendorWorkOrderSMS` and `buildCrewInviteSMS` today, not one this
feature creates. Copy-link v1 does not widen it. **Tracked separately** (Phase B5) and it is
a hard prerequisite for ever texting a technician.

### Security rules

- **No access details in any message body.** `work_orders.lockbox_code`, `access_notes` and
  `parking_notes` render only behind the link, after name capture — which also produces an
  audit row naming who saw the code and when. A link pasted into the wrong thread must not
  itself leak a door code.
- Cap grants per work order (`MAX_GRANTS_PER_WO = 5`).
- Vendor can revoke an individual grant without affecting the others or his own token.
- Every write from a grant stamps the grant id, so photos, line items and progress changes
  carry real attribution. This replaces the free-text `completed_by_name` typed at the end
  (`app/api/work-orders/[token]/complete/route.ts:161`).
- `last_used_at` answers "did he open it", per person. That also retires the dead
  `public_viewed_at` column, which nothing has ever written.
- Phone numbers are PII: no roster field enters a log line or `logAuditEvent` metadata
  (`unit/guardrails/sensitive-data-logging.test.ts` already bans the guest-phone equivalent).
- **No proxy change needed.** `/work-orders/` is already in `TOKEN_ROUTES`
  (`proxy.ts:175`) and `rateLimiterForPathname` already returns `workOrderRatelimit` for
  that prefix (`proxy.ts:397`); both are `startsWith`, so `/work-orders/t/[token]` is
  covered. `unit/guardrails/public-route-rate-limiting.test.ts` should stay green —
  confirm, do not assume.

### Known limitation

`vendors.org_id` means one vendor row per PM org. The same plumbing company serving two
FieldStay PMs is two vendor records, so the roster does not carry across and the vendor
self-enrolls his techs once per PM. Accepted for now. Keying the roster on `vendor_id`
leaves room for a global vendor identity later.

## B5. `sms_suppressions` (prerequisite for any technician SMS)

Not required by v1, required before step 5 of the flow above ever sends.

```sql
CREATE TABLE IF NOT EXISTS sms_suppressions (
  phone_e164   text PRIMARY KEY,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL,          -- 'stop_keyword' | 'manual' | 'carrier'
  note         text
);
ALTER TABLE sms_suppressions ENABLE ROW LEVEL SECURITY;
```

Global, not per-org — same scoping as `guidebook_guest_sms_optins.phone_e164` and for the
same STOP-compliance reason. Checked **inside `sendSMS`**, at the same chokepoint as
`SMS_ENABLED`, so it cannot be forgotten at a call site: that is the reasoning already
written into that function's own comment about why the gate lives there and not in its 12
callers. The STOP webhook writes here in addition to the guest table. Service-role only.

---

# Phase C — item 5: progression writable by whoever is working

Phase B gives the vendor side. This closes the crew side and removes the PM-only path.

- Crew PWA: the first checklist tick on a work order moves it to `in_progress`. The signal
  already flows — `checklist_instance_items.completed_at` updates live.
- The crew work-order screen (`app/crew/work-orders/[id]/page.tsx:135-149`) gains "Start"
  alongside "Complete" for WOs with no checklist.
- The maintenance board's bulk "Set status…" dropdown stays (PM override), but `in_progress`
  stops being the only way in.
- Open question, not yet decided: whether a single-WO status control belongs on the detail
  panel, or whether derived status plus the bulk override is enough. Decide when C is built.

---

# Phase D — item 4: per-crew daily capacity

Two parts, and the first is a product decision this spec is making explicitly, because
`auto-assign-turnover.ts:44-56` correctly refuses to invent it:

1. **`crew_members.max_turnovers_per_day`** (integer, nullable; null = no limit) and
   optionally `max_minutes_per_day`. Enforced as a HARD exclusion in autopilot, the same way
   `crew_availability` already is — not a score penalty, because no human reviews an
   autopilot pick. Default null so nothing changes for existing orgs until a PM sets one.
2. **Workload becomes per-day, not per-fortnight.** `computeWorkloadMap`
   (`lib/scoring/pools.ts:10-22`) counts assignments across 14 days and
   `crew-candidates.ts:124` flattens it to `1 - count/max`, so three jobs stacked on one
   Tuesday scores identically to three spread out. The scorer needs the count for the
   turnover's OWN date, with the 14-day figure kept as a secondary smoothing term.

Both change `ScoredCrewCandidate.breakdown`, which is persisted to
`assignment_outcomes.score_breakdown`. Add the new key rather than repurposing `workload`,
for the same reason `friction` keeps `localEvents: 0` — stored history must stay readable.

---

# Phase E — item 1: the day planner

Needs D. Writes `planned_start_at` / `planned_end_at` on `turnover_assignments`.

Inputs, all of which already exist and are already computed daily:

- duration: `crew_speed_baselines.avg_minutes_per_bedroom` × `properties.bedrooms`, org
  median fallback (`cron/pre-flight-friction.ts:244-272`)
- hard window: `turnovers.checkout_datetime` → `checkin_datetime`
- travel: Phase G, or the current haversine estimate until then
- capacity: Phase D

Open questions, to settle before building E:

- Does the planner run as a cron (overnight, like friction) or on demand when a PM opens the
  day? Probably both: a nightly plan plus a re-plan button.
- Is the plan advisory or authoritative — i.e. does a crew member see a start time that a PM
  has not confirmed?
- What happens to a plan when a booking's dates change? `turnovers` already has the
  `dates_changed_at` / `pending_checkin_datetime` acknowledgement dance; the plan has to
  participate in it.

Crew PWA consequence: the card's time changes from `checkout_datetime` (the guest's
departure, which reads like an arrival instruction — `app/crew/page.tsx:126-128`) to the
planned start, with checkout shown as the window it sits in.

---

# Phase F — item 3: cascade alert

`lib/scoring/crew-day-context.ts` is written, paginated, N+1-safe, and has no caller by
design. Promote it:

- a 30-minute cron over orgs with turnovers today
- fire when an in-flight turnover is past its own `checkin_datetime` with an incomplete
  checklist AND the crew member has later turnovers today
- the notification names the downstream jobs, so the PM can decide whether to reassign or
  warn a guest

Keep the module's own constraint: it decides nothing. No severity, no auto-reassignment.
The judgment stays with the dispatcher. Per CLAUDE.md the cron fans out one event per org.

---

# Phase G — item 6: routed travel time

Today: straight-line haversine ÷ a hardcoded `AVG_DRIVE_SPEED_MPH = 30`, duplicated in
`app/crew/page.tsx:19` and `app/(dashboard)/ops/ops-snapshot.tsx:20`, excluding the home→first
and last→home legs, excluding work orders from the chain, and silently zero when any
property lacks coordinates.

- One shared implementation. Mapbox Directions (Mapbox is already the geocoder) via
  `safeFetch` with a timeout budget in `lib/http/timeout.ts`, per
  `unit/guardrails/external-fetch-timeout.test.ts`.
- Cache per (origin, destination) pair — these are the same property pairs every week.
- Include both home legs and interleave work orders into the chain.
- Keep a labelled fallback when routing is unavailable. An unavailable estimate must read as
  unavailable, not as zero.
- Feed it into Phase E's planner and into the standard-weight proximity term, which today
  measures from HOME rather than from the previous stop — a 15% weight on the wrong origin
  (`lib/scoring/geo.ts`, `crew-candidates.ts:57`).

---

# Phase H — item 7

- **Half-day availability.** `crew_availability` is a whole-day boolean. Add a part-of-day
  dimension (morning / afternoon / evening) rather than free times. Autopilot's hard
  exclusion becomes window-aware, which needs Phase E's planned times to be meaningful.
- **Crew "running late" signal.** One tap on the turnover screen, offline-capable through the
  existing outbox, notifying the PM. Pairs with Phase F from the other direction: F infers
  lateness, H lets the person say it.
- **Co-assignee names on crew cards.** `turnover_assignments` already carries every assigned
  crew member; the card renders none of them. One shared status per turnover is correct and
  documented (`app/crew/crew-shell.tsx:753`) — the card should say who shares it.

---

## Cross-cutting obligations (every phase)

Per CLAUDE.md, each phase ships with:

1. `types/database.ts` updated in the SAME commit as its migration.
2. The migration applied to prod AND the E2E project `syhthijeqlnltufdawyb` in the same
   sitting; `scripts/check-type-drift.mjs` runs against E2E.
3. RLS enabled with real policies on every new table, plus the `authenticated` GRANT where
   org members read it (the grant is checked before RLS and does not replace it).
4. Every new Inngest event registered in `FieldStayEvents` before the closing brace, and the
   function added to the single `serve()` call.
5. No em dash in any customer-facing copy, including the vendor portal, the technician
   screen, PM notifications and email subjects.
6. CSS variables for colour, `components/ui/*` primitives rather than hand-rolled equivalents.
7. New conventions ship WITH their guardrail. This spec adds three:
   - `woStatusForProgress()` is total over the `vendor_progress` enum
   - `vendor_technicians` / `work_order_access_grants` have no `authenticated` SELECT policy
   - a `vendor_progress = 'job_completed'` write goes through `finalizeWorkOrderCompletion`
8. Service-role calls carry a `ServiceRoleContext`; token-gated routes use
   `{ publicSurface: … }` and validate in-file.
9. `lib/env.ts` `ENV_SPEC` updated for any new env var (e.g. a Mapbox Directions key in G).

## Deferred, deliberately

- Real vendor accounts with sub-users. The portal works for trades because it needs no
  signup. Revisit when a vendor asks for logins, not before.
- Auto-dispatch of a declined WO to the next vendor. Vendors stay suggest-only until the
  planned vendor-Autopilot work lands.
- Vendor identity spanning orgs.
