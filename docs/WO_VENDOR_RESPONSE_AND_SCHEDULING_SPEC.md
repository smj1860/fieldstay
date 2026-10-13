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
| `20261012140000_crew_max_turnovers_per_day` | applied 2026-10-12 | **applied 2026-10-12** |
| `20261012180000_turnover_assignment_day_plan` | applied 2026-10-12 | **applied 2026-10-12** |
| `20261012190000_set_turnover_assignment_plans` | applied 2026-10-12 | **applied 2026-10-12** |

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

## Help docs ship with the phase

Every phase from G onward carries its own `docs/support/**` update in the same PR as the
code, not a separate pass afterwards. `.github/workflows/seed-support-kb.yml` re-embeds
those files into `support_kb_chunks` on merge to `main`, so the docs commit is also what
updates Finn. A phase merged without them leaves the assistant confidently answering
about the previous behaviour, which is worse than it saying it does not know.

Phases A-D were documented in one catch-up pass (PR #784). E and F were documented
together after the fact, which is the gap this convention closes. What each one needs:

- a section or doc under `docs/support/` for anything a PM, crew member, vendor or owner
  can see
- a `19-faq.md` entry per question the change invites, and a `18-glossary.md` term for any
  new noun the UI uses
- the in-app FAQ (`lib/faq-content.ts`) for PM-facing behaviour, and the crew app's own
  FAQ (`app/crew/crew-shell.tsx`) in **both languages** for anything crew see

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

# Phase C — item 5: progression writable by whoever is working — BUILT

Phase B gave the vendor side. This closes the crew side and removes the PM-only path.

**A correction to this section as originally written.** It said "the first checklist tick on
a work order moves it to `in_progress`", and then treated "WOs with no checklist" as the
leftover case. That has it backwards: `checklist_instances.turnover_id` is NOT NULL with an
FK to `turnovers`, so **a work order never has a checklist**. There is no first tick on a
work order to infer anything from. The two halves below are therefore different mechanisms,
not a rule plus its exception.

### C1 — a turnover starts itself on the first tick

"Start Turnover" already existed on the hub, but it was the only way in and it is skippable.
A crew member who opens the checklist and starts ticking leaves the turnover at `assigned`
for the whole clean: the PM's board shows nothing happening while the work is visibly under
way, and `turnovers.started_at` — read by the duration half of the crew scoring loop — is
never written at all.

Inferred rather than added as a second button, because the tick IS the evidence. Asking
someone to announce they have started while they are demonstrably doing the work is the
double entry this product exists to remove.

FOUR paths can complete a checklist item (the toggle, asset capture, photo capture, and a
note saved against an already-ticked item), so the inference lives in ONE funnel
(`writeChecklistItem` in `use-turnover-actions.ts`) rather than at four call sites. A fifth
path, or one of the four reverted to the raw helper, would put the hole straight back with
nothing failing — the tick still works and only the status is wrong. Enforced by
`unit/guardrails/crew-implicit-turnover-start.test.ts`.

It fires only from `assigned`, only on a completion (un-ticking is not a start), never on a
cancelled turnover, and its failure is deliberately NOT surfaced: the tick itself succeeded,
and an error toast about a start the crew member never asked for reads as "your tick
failed".

### C2 — a work order gets an explicit Start

No checklist means no inference, so `app/crew/work-orders/[id]/page.tsx` gains "Start Work"
alongside "Mark Work Complete", routed through a new
`POST /api/crew/work-orders/[id]/start`. Completing without starting stays allowed: plenty
of these are five-minute jobs.

The route mirrors the completion route's hard-won shapes rather than inventing its own: a
400 on a malformed uuid (not the 503 the outbox would retry forever), 503 on a failed read
so a transient blip retries, a terminal 409 on a cancelled work order, a 200 no-op on
anything already past `assigned`, and a compare-and-set `UPDATE ... .eq('status', …)` as the
real guard against two concurrent starts. No `started_at` is written because `work_orders`
has no such column; the `work_order_updates` row is the timestamp, which is the table that
already records every other transition.

`uploadCrewWorkOrderChange` had to learn the new status. It previously accepted `completed`
and threw on anything else, and a thrown plain Error is TERMINAL to
`classifyUploadFailure` — so queueing an `in_progress` mutation without teaching the handler
would have dead-lettered the crew member's start rather than sending it. Covered by
`unit/dexie/crew-work-order-start-outbox.test.ts`, which also pins the endpoint: a start
POSTed to `/complete` would close the job and fire the owner_transactions maintenance
expense.

### C3 — the open question, decided: NO single-WO status dropdown

The question was whether a single-WO status control belongs on the detail panel. It does
not, and the reason is the point of this phase.

With C1 and C2 in, status is DERIVED from whoever is doing the work: crew tick or tap, and
on the vendor side `vendor_progress` mapped through `woStatusForProgress()`. A PM-facing
dropdown on the detail panel would re-open the PM-types-the-truth path this phase exists to
close, and it would COMPETE with those writes: a PM setting `in_progress` on a work order
whose `vendor_progress` says `parts_ordered` produces a contradiction the two-axis design
was built to avoid.

The maintenance board's bulk "Set status…" stays as the override. It is the right shape for
the exception case (fixing a mistake, cancelling several at once) precisely because it is
deliberate and plural, rather than sitting on every detail panel inviting routine use.

---

# Phase D — item 4: per-crew daily capacity — BUILT

Two parts, and the first was a product decision this spec made explicitly, because
`auto-assign-turnover.ts` correctly refused to invent it: `capacity_score` is a 0-1 SCORING
WEIGHT, not a limit, and a cleaner doing several turnovers in a day is the normal case
rather than over-booking.

### D1 — `crew_members.max_turnovers_per_day`

Integer, nullable, `CHECK (... IS NULL OR > 0)`. NULL means no limit and is what every
existing row carries: a default number would have changed autopilot's behaviour for every
org the day it shipped, refusing assignments it makes today. Settable per crew member in
Manage Crew, next to the auto-assign toggle, blank for "Any".

A HARD exclusion, applied before scoring, the same way `crew_availability` already is. A
weight can be outvoted by proximity and familiarity, and nobody reviews an autopilot pick.

**Deviation from this section as written, deliberate:** the exclusion applies in SUGGEST
mode too, not only autopilot. `crew_availability` — the exclusion this one is modelled on —
has always applied to both, and a suggestion that breaks the PM's own stated limit is noise
they have to notice and override. An org that empties its pool this way now gets a third
gap reason, `all_at_capacity`, whose copy names the limit and where to change it; it is the
only one of the three gaps the PM created themselves.

**`max_minutes_per_day` was NOT added.** A minutes budget needs a per-turnover duration
estimate to spend against it (`crew_speed_baselines` x `properties.bedrooms`), which arrives
with the day planner in Phase E. A column nothing enforces reads as a capability the product
has and does not.

### D2 — workload is per-day, with the fortnight kept as smoothing

`computeDayWorkloadMap()` (`lib/scoring/pools.ts`) buckets the same rows
`computeWorkloadMap()` already counts into `date -> crew -> count`. Both callers were
ALREADY fetching `turnovers.checkout_datetime` through an `!inner` embed and discarding it,
so the per-day count cost no new query: only the TypeScript row type widened.

The date comes from slicing the ISO string, never from `new Date()`. `checkout_datetime` is
stored UTC, so parsing and reading local parts would bucket a late-evening checkout into
different days depending on where the function ran, and it would stop agreeing with the
`.split('T')[0]` that the `crew_availability` lookup uses — which is the comparison the cap
has to line up with.

`dayWorkload` is a NEW breakdown key rather than a repurposing of `workload`, because
`ScoredCrewCandidate.breakdown` is persisted to `assignment_outcomes.score_breakdown` and
stored history must stay readable — the same reason `pre_flight_friction` keeps
`localEvents: 0`.

**The weights split 70/30, day-first, out of the existing workload share.** Every other term
is untouched and both sets still total 1.00, so this re-tunes one axis rather than re-tuning
the model: same-day `0.10 -> 0.07 + 0.03`, standard `0.20 -> 0.14 + 0.06`. The fortnight
share is not zero, because a day count alone would happily stack someone's whole week onto
consecutive days as long as no single one was crowded.

`crewSuggestionReasoning()`'s "light schedule" now reads the DAY figure. Next to a crew
member who already has three jobs that Tuesday, it read as wrong to the PM looking at the
board, however quiet their fortnight was.

---

# Phase E — item 1: the day planner — BUILT

Writes `planned_start_at` / `planned_end_at` on `turnover_assignments`, plus
`plan_published_at`.

### The three open questions, decided

**Cron or on demand? Both, plus a third trigger the question did not list.**
`cron-day-planner` runs 07:30 UTC, half an hour after `cron-pre-flight-friction`
— a real dependency, since that cron's first step recomputes
`crew_speed_baselines`, which is where these duration estimates come from.
On top of that, **any assignment change re-plans that org's day**: a plan
computed at 2am is wrong the moment a PM reassigns someone at 9am. All four PM
paths and the autopilot path fire `org/day_plan.requested`.

**Dates changing answered itself from existing code.** `refreshExistingPairDates`
already distinguishes `pending_assignment`/`assigned` (dates written directly)
from `in_progress` (staged, with the banner) from completed/cancelled (never
touched). The plan is derived data: it recomputes when real dates move and is
left alone when a change is merely staged, exactly as `checkout_datetime` is.
No new acknowledgement dance.

**Advisory or authoritative: PUBLISH-FIRST, with the seam for both.** A start
time is an obligation. Computed and shown with no human in between, it makes a
crew member "behind" against a number nobody committed to, and crew reliability
is a real score here. `plan_published_at` NULL means crew see nothing and the
card keeps its old behaviour.

The seam for a future auto-publish mode is the timestamp itself: publishing is
a separate act rather than something baked into the computation, so making it
automatic is the planner stamping that column, not a redesign. Deliberately NOT
an org-level mode enum today, because a second mode nothing implements would
read as a capability the product has and does not.

`was_late` is untouched: it stays `completed_at > checkin_datetime`, measured
against the guest actually arriving. A planned start must not quietly become a
second, softer definition of late.

### The planner

`lib/planning/day-plan.ts`, pure over its inputs. Each job starts at the LATER
of two constraints and both bind: when the property becomes free, and when the
crew member can physically get there from the previous job. Ordering is
earliest-free-first, NOT a travelling-salesman solve — a route saving eleven
minutes is worthless if it puts a cleaner at a door before the guest has gone,
and a PM cannot sanity-check an order they did not expect.

`infeasible` is the most valuable output: a job that cannot finish before the
next guest arrives, flagged rather than silently clamped, so a day that will
not work is visible BEFORE it happens. A standalone turnover has no incoming
guest and is never flagged.

### Writes, and the hole the first draft opened

`set_turnover_assignment_plans` writes a whole org's day in ONE statement
(`UPDATE ... FROM jsonb_to_recordset`). An UPDATE, never an upsert: an upsert
keyed on id would RESURRECT an assignment deleted between the planner's read
and its write.

**The first draft of that RPC reintroduced the vulnerability class
`20260801280000_authz_gate_security_definer_rpcs.sql` had already closed.**
SECURITY DEFINER with a caller-supplied `p_org_id` means the argument is the
only tenant boundary, and `REVOKE ... FROM PUBLIC` does NOT remove Supabase's
default `authenticated` grant. Fixed with both defences: the `is_org_member`
gate, and EXECUTE revoked from `authenticated` by name.

### What crew see

The plan rides to the device on the existing turnovers pull via an embedded
assignment row — no `crew_member_id` filter, because that table's SELECT policy
already returns only the caller's own. `publishedPlan()` drops an unpublished
plan at SYNC time, so it never reaches Dexie and no later UI change can start
showing one by accident.

The card leads with "Start 10:40" and demotes checkout to "Free from 10:00".
Checkout alone reads as "be there at 10" when it means "you cannot start before
10"; with three jobs in a day, two of those readings were wrong.

### Not built

Travel is still the haversine estimate at a flat 48km/h, awaiting Phase G.
Per-crew publishing (this publishes a whole date). The planner does not consider
`max_turnovers_per_day` when sequencing — that cap governs what gets ASSIGNED,
in Phase D, and by the time the planner runs the assignments already exist.

---

# Phase F — item 3: cascade alert — BUILT

`lib/scoring/crew-day-context.ts` was written, paginated and N+1-safe with no caller by
design. It is promoted, and **re-shaped per org rather than per turnover**:
`loadOrgDayCrewJobs()` runs the same three reads (assignments, checklist instances,
checklist items) for a whole org-day. Calling the old per-turnover
`getCrewDayContext()` once per turnover, 48 times a day, is precisely the N+1
`unit/guardrails/n-plus-one-loops.test.ts` exists to catch.

That function is **deleted**, not kept beside the new one. Its only remaining callers
were its own 11 tests, which is the "dead implementation with a full passing test suite"
shape CLAUDE.md's `unreferenced-server-actions` rationale describes: it keeps the API
surface of the live path while missing whatever the live path had to learn, so whoever
revives it inherits the old version. Its tests were rewritten against
`loadOrgDayCrewJobs` rather than dropped, so the coverage moved with the behaviour.

`cron-cascade-alert` runs every 30 minutes, finds orgs with an in-flight assigned
turnover today, and fans out one `org/cascade_check.requested` per org.

### The ranking

Multiple turnovers can be running late at once, so they are ordered. **One derived
number, not a weighted composite** (`lib/scoring/cascade.ts`, pure, 16 tests):
projected minutes this job runs into the NEXT one's start, remaining work plus drive
time plus the arrival buffer.

The composite was the obvious design and was rejected on the live data. Of 59
properties, 17 have coordinates and 10 have square footage, against 59 with bedrooms.
A score over "how late, how far along, how far to drive, how big" would look
authoritative while being computed largely from nulls, and hand-set weights here would
stay unvalidated indefinitely — CLAUDE.md is explicit that the friction scorer's weights
are never auto-tuned. Projected overrun absorbs what IS measurable into a quantity with
units a person can act on, and it doubles as the rank, which is why the notification
carries the minutes rather than an opaque "#2 of 3" badge.

Missing coordinates contribute ZERO drive time and set `travelUnknown`, which the
notification says out loud ("Drive time unknown."). A fabricated drive time would move
the ranking on data we do not have — the same honest-absence convention as an unmapped
ZIP scoring `'none'` in the seasonal profile.

A null `completionRatio` (no checklist instance yet) is read as no work done. That is
deliberately pessimistic: under-reporting a cascade is the failure that matters, since
the whole point is to surface the problem before it lands.

### One notification per turnover per day

`dedupe_key` is `cascade:<turnover_id>:<date>`, enforced by the unique index on
`notifications.dedupe_key`, not by a flag the cron keeps. The first run that sees a job
slip notifies; the other 47 that day do not. Being told once, early, is the value; a job
that is 30 minutes late at noon and four hours late at 4pm does not need nine reminders
in between.

The whole org's rows go out through `createPmNotifications` in one statement, in rank
order — its per-row `ignoreDuplicates` is what keeps one already-notified turnover from
aborting the batch, which a plain multi-row insert would.

### It still decides nothing

No severity ladder, no threshold that moves anybody, no auto-reassignment. Every row
goes out at one severity (amber) on purpose: picking amber for one and red for another
is the judgment this is not making. The ranking is presentation; the dispatcher decides
whether to reassign, warn the guest, or let it ride.

Start times come from the published plan where Phase E produced one, and fall back to
`checkout_datetime` otherwise. An unpublished planned time is a draft nobody agreed to,
so the alert measures against what the crew member is actually looking at.

---

# Phase G — item 6: routed travel time — BUILT

The straight-line-over-30mph estimate was written out FOUR times, not the three the
original note counted: `app/crew/page.tsx`, `app/(dashboard)/ops/ops-snapshot.tsx`,
`lib/planning/day-plan.ts` and `lib/scoring/cascade.ts`, each with its own speed constant
(two in mph, two in km/h) and its own idea of what a missing coordinate meant.

### One implementation, three layers

- `lib/travel/estimate.ts` — PURE and client-safe. Types, the one speed constant, the
  straight-line fallback, the directional cache key, and `chainTravel()`. Imports nothing
  but `haversineKm`, so the crew PWA calls it without pulling a server module into the
  bundle.
- `lib/travel/mapbox.ts` — server-only. The **Directions Matrix** API, not Directions:
  Directions answers one leg per request, so a six-stop day is five requests and a
  twelve-crew org is sixty, per night. Matrix answers every pair among up to 25
  coordinates in ONE request, so a crew member's whole day costs one call. Chunked with a
  ONE-STOP OVERLAP past 25 coordinates, because consecutive legs span chunk boundaries and
  a naive split loses one leg per 25 stops.
- `lib/travel/resolve.ts` — server-only. Cache first, Matrix second, straight line last.

`fetchWithRetry` with `MAPBOX_MATRIX_TIMEOUT_MS`, not `safeFetch`: the spec's bullet named
`safeFetch`, but that helper exists for URLs that are partly TENANT-supplied, where a
redirect or a DNS answer can move the target. This URL's host is a literal, which is the
same reason `lib/geocoding.ts` uses `fetchWithRetry` for the geocoder. The requirement
behind the bullet — a timeout budget, per `unit/guardrails/external-fetch-timeout.test.ts`
— is met either way.

### Exactly one caller spends a routing request

The overnight day planner. Everything else READS the cache:
`lookupTravelMinutes()` never fetches, which is what keeps the cascade check (48 runs a
day) and the page-render travel summaries from turning into API spend. The cascade cron
also ranks TWICE — a free pass with no travel to establish whether anything is late at
all, and the real pass only if something is, so a quiet run costs no query either.

`travel_time_cache` is **org-scoped**, with a SELECT policy for members and no write path
at all (service role only, same shape as `notifications`). A global pair table would need
either a policy letting every tenant read every other tenant's coordinate pairs or no
policy at all, and the policy-less case is a shrink-only allowlist nothing new may join.
Keyed on a directional TEXT key built from coordinates rounded to 4dp (~11m), so the read
is one `.in('cache_key', keys)` for a whole org-night rather than a query per leg, and a
re-geocode that nudges the seventh decimal does not orphan every cached leg. TTL 90 days:
the planner re-fetches a stale row, the read path still USES one, because a six-month-old
drive time beats a straight line and the read path cannot refresh it anyway.

### An unavailable estimate never reads as zero

Every figure is labelled. `chainTravel()` reports `measured`/`unmeasured` counts and a
source of `routed | estimated | mixed | unknown`, and both UI surfaces render **"at
least"** for a partially-measured day. Before this, ONE unmappable property zeroed the
whole chain, so a day it could mostly measure displayed "Travel time unavailable" — which
told a PM less than the four legs already in hand.

### The proximity origin was the real bug in item 6

`crew-candidates.ts` measured proximity from the crew member's HOME, with 15% of the
standard weight on it. For anyone already out working that is the wrong origin: a crew
member whose 10am is next door to the 2pm being scored was treated as driving from their
kitchen. `computePriorStopOrigins()` (`lib/scoring/pools.ts`) resolves each candidate's
last stop earlier that same day, and home is now the fallback for a first job only, which
is the one case where home IS the origin.

`originByCrew` is a REQUIRED field on `CrewScoringInput`, for the same reason
`dayWorkloadMap` is: an optional one lets a caller omit it, and then the board's
suggestion and the Friction Forecaster's Smart Fix recommend different people for the same
turnover, each looking correct alone. Both callers get it from the 14-day workload read
they already issue, now embedding `properties(lat, lng)` — same rows, same round trip.

### What the bullets asked for and did NOT get, and why

- **Both home legs**: in the Ops snapshot, where `crew_members.home_lat/home_lng` ride
  along on an embed the page already requests. NOT in the crew PWA, which holds no row for
  the crew member's own home — that needs a new synced Dexie table plus its
  `CREW_SYNCED_TABLES` / coverage-guardrail entries, which is its own change. The crew app
  FAQ says the commute is not counted rather than leaving the number unexplained.
- **Home leg in the PLANNER**: deliberately not, and this is a correction rather than a
  gap. The commute does not constrain the first job's start, because a crew member can
  leave home as early as they like. Adding it would push the first start past the time the
  property is actually free, for no reason a PM could defend. The home legs are DRIVE TIME,
  which is a different question and belongs in the summary.
- **Work orders interleaved**: in both travel summaries. NOT in the planner's slotting,
  which stays turnovers-only: a crew work order carries `needed_by_date`, a DATE with no
  time, and no duration estimate exists for one, so there is nothing to sequence it by.
  The summaries append them, and the code says so rather than implying an order.

---

# Phase H — item 7 — BUILT

## Half-day availability

`crew_availability.unavailable_parts text[]` (20261013170000), with a CHECK that gives each
state exactly ONE spelling:

```
is_available false, parts NULL    the whole day is off
is_available true,  parts NULL    available all day (every pre-existing row)
is_available true,  parts {…}     available except those windows
```

An empty array and all three windows are both rejected: the first is NULL in disguise, the
second is the whole-day form written the long way. `lib/scheduling/part-of-day.ts` is the one
place that resolves the three, and the windows (noon, 5pm) are resolved in
FRICTION_TIMEZONE — "morning" is a local idea, and a UTC hour would put half the portfolio's
afternoon jobs in the evening bucket and move the boundary twice a year.

**The dangerous reader was the one that did not change.** `.eq('is_available', false)` still
compiles and still returns rows; it now means "whole-day absences only", so a crew member who
booked the morning off reads as fully available. The scan found **four** such readers beyond
the one the spec anticipated:

| Reader | What it does now |
|---|---|
| `auto-assign-turnover.ts` | resolves against the turnover's CHECKOUT time (the planned start does not exist yet at assignment time) |
| `turnovers/actions.ts` (the PM warning) | takes full timestamps instead of dates, so a morning absence warns for a 10am checkout and not a 3pm one |
| `turnover-board.tsx` | the assign-menu dot reads against that turnover's own checkout time and says which window clashes |
| `crew-manage-client.tsx` | uses the shared `hasTimeOff()` predicate, so a half day is no longer "no restrictions set" |
| `create-work-order-helpers.ts` | **unchanged, deliberately**: a work order has a date and no time, so there is no instant to resolve against, and warning on a half day would fire for an afternoon job because the morning was booked off |

`unit/guardrails/availability-window-aware.test.ts` holds the line. It reads the `.select()`
string that follows each `.from('crew_availability')` rather than scanning the file, and that
distinction is not academic: **its first version passed its own fire check** because an
interface declaring `unavailable_parts` and an unused import of the resolver both satisfied a
file-wide match. The rewritten version fires on a dropped column and rejects a bare import as
"resolving".

## The crew "running late" signal

`turnovers.crew_running_late_at` + `crew_running_late_by_crew_member_id`. One tap, queued
through the existing outbox, drained to `/api/crew/turnovers/[id]/running-late`.

It rides the EXISTING `turnovers` MutationTable rather than adding a new one, so it inherits
the dead-letter banner entry and retry affordance the crew guardrails require instead of
needing its own.

**The timestamp is the CLIENT's, and that is the point.** A tap made in a basement may not
drain for hours; stamping it server-side on arrival would tell a PM the flag was raised at
noon when it was raised at ten. The route clamps it instead — not in the future, not older
than 24h — which is the boundary validation CLAUDE.md asks for without throwing away the one
fact only the device knows.

Idempotent in the WHERE clause (`.is('crew_running_late_at', null)`), not just the read above
it, so two concurrent drains produce one notification. The notification is deduped per
turnover rather than per day: a second tap on the same job carries nothing the first did not.

Not gated on the turnover having started, deliberately. The most useful moment to raise it is
usually before anything has been ticked.

## Co-assignee names

`get_turnover_coassignees(uuid[])`, SECURITY DEFINER, gate derived from `auth.uid()` INSIDE
the function. The argument only narrows.

An RPC rather than a widened policy, because `turnover_assignments_select` gives a crew member
their own rows only — so the Phase E embed cannot see a co-assignee, and `crew_members` is
scoped to self as well, meaning a widened policy would hand over other people's planned times
and still not resolve a name.

**Fire-checked against production inside a rolled-back transaction**, which is the check my
Phase E RPC did not get: a stranger's uuid returns 0 rows for the same argument that returns 3
for the genuinely assigned crew member. A zero that is always zero proves nothing, so both
halves were measured.

Cached onto the turnover row as `co_assignee_names` rather than as a new synced table, which
keeps `CREW_SYNCED_TABLES` and the sync-coverage guardrail out of it. Lookup failure is
silent and non-fatal: a card that does not name a co-worker is a smaller loss than a sync
that stops.

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
