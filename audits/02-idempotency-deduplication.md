# Idempotency & Event Deduplication Audit

## Executive Summary

FieldStay's idempotency posture is generally strong for the financial-ledger
critical path (`owner_transactions`) thanks to the `owner_transactions_source_ref_unique`
constraint and consistent `source_reference_id` checks across `turnover-events.ts`,
`work-order-events.ts`, `inventory-events.ts`, and `booking-events.ts`. The Stripe
and OwnerRez webhook handlers both correctly verify signatures/auth and dedup against
a processed-event ledger before doing any work. However, several cron functions and
one inventory flow create database rows (work orders, purchase orders) with **no
existence check and no backing unique constraint**, meaning an Inngest step retry
will silently create duplicates with no error and no safety net. There is also a
fully-duplicated "god function" (`maintenance-check.ts`) left in the codebase that —
while currently unregistered (dead code) — duplicates logic from four registered
crons and has drifted out of sync with them, creating a maintenance hazard.

**Findings by severity:** 2 CRITICAL, 4 HIGH, 5 MEDIUM, 3 LOW.

---

## Findings

### CRITICAL: Auto-created maintenance work orders have no idempotency guard on retry
**Status: FIXED** — `lib/inngest/functions/cron/maintenance-schedules.ts:226-255`
(Pass 2) and `lib/inngest/functions/cron/maintenance-schedules-helpers.ts`'s
`createMaintenanceWorkOrder` (Pass 1) now both check for an existing WO before
insert; migrations `20260610000001_maintenance_po_idempotency.sql` /
`20260707145540_maintenance_po_idempotency.sql` add the backing unique index.
- **Area:** Inngest Steps
- **Location:** `lib/inngest/functions/cron/maintenance-schedules.ts:60-93` (Pass 1, `process-schedule-${schedule.id}`, `auto_create_wo === true` branch)
- **Description:** When a maintenance schedule is due within `ALERT_WINDOW_DAYS` and `auto_create_wo = true`, this step directly does:
  ```ts
  const { data: wo } = await supabase
    .from('work_orders')
    .insert({ ... source: 'maintenance_schedule', source_schedule_id: schedule.id, scheduled_date: schedule.next_due_date, ... })
    .select('id')
    .single()
  ```
  with **no preceding `existingWO` check**. Compare this to the *dead* duplicate of
  this function, `lib/inngest/functions/maintenance-check.ts:68-93`, which does:
  ```ts
  const { data: existingWO } = await supabase
    .from('work_orders')
    .select('id')
    .eq('source_schedule_id', schedule.id)
    .eq('scheduled_date', schedule.next_due_date!)
    .not('status', 'in', '("completed","cancelled")')
    .maybeSingle()

  const { data: wo } = existingWO ? { data: existingWO } : await supabase.from('work_orders').insert({...})
  ```
  The registered cron (`dailyMaintenanceScheduleCheck`, in `cron/maintenance-schedules.ts`)
  is missing this guard entirely. There is also no DB-level unique constraint on
  `(source_schedule_id, scheduled_date)` or similar to act as a backstop (verified —
  `supabase/migrations/20260609000002_idempotency_hardening.sql` only adds a unique
  index for `source = 'crew_flag'`, not `'maintenance_schedule'`).
- **Risk:** If this step is retried by Inngest (the function has `retries: 2`), or if
  the function is ever re-run for the same day (e.g., manual replay, overlapping
  invocation), a **second work order is created** for the same schedule + due date.
  Each duplicate WO also triggers: a duplicate "Work order created" email to the PM
  (line 89-107), and — if the vendor has portal access — a duplicate
  `inngest.send('work-order/created')` (line 110-119), which itself sends a vendor
  portal-link email (`work-order-events.ts: send-vendor-portal-link`). End result:
  duplicate WOs, duplicate PM emails, duplicate vendor emails, and (if/when the
  duplicate WO is completed) a duplicate `wo_completion` expense attempt — though
  that last step IS protected by `owner_transactions_source_ref_unique`.
- **Recommendation:** Port the `existingWO` check from the dead `maintenance-check.ts`
  into `cron/maintenance-schedules.ts`'s Pass 1 `auto_create_wo` branch, and add a
  partial unique index, e.g.:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS wo_maintenance_schedule_date_unique
    ON public.work_orders(source_schedule_id, scheduled_date)
    WHERE source = 'maintenance_schedule' AND source_schedule_id IS NOT NULL;
  ```
  and handle `23505` as "already exists, skip" in the insert path.

---

### CRITICAL: `create-purchase-order` step can create duplicate POs + line items on retry
- **Area:** Inngest Steps
- **Location:** `lib/inngest/functions/inventory-events.ts:130-162` (`handleInventoryCountSubmitted`, step `create-purchase-order`)
- **Description:** The step performs three sequential writes with no existence
  check and no unique constraint:
  1. `INSERT INTO purchase_orders (...)`  → returns `po.id`
  2. `INSERT INTO purchase_order_items (...)` for every below-par item (uses `po.id`)
  3. `UPDATE purchase_orders SET status = 'sent', sent_at = ...`

  If step 2 or 3 throws (e.g., a transient Supabase error on the items insert), the
  whole `step.run('create-purchase-order', ...)` is retried by Inngest (function has
  `retries: 2`). On retry, step 1 runs again — there is nothing to detect that a PO
  was already created for this `count_id` — producing a **second `purchase_orders`
  row with a duplicate set of `purchase_order_items`**.
- **Risk:** A single inventory count submission can generate two draft/sent purchase
  orders with identical line items. The PM receives the "Restock needed" email
  (step `email-po-to-pm`) potentially referencing only one of the two POs, and if
  both are eventually marked `'ordered'`, `purchase-order/approved` fires twice —
  each posts its own `inventory_purchase` expense. (That downstream expense IS
  deduplicated via `source_reference_id` + `source` per-PO, but the two POs have
  *different* `id`s, so **both expenses post** — i.e., the owner is billed twice for
  the same restock.)
- **Recommendation:** Add a `count_id` column (or `source_reference_id`) to
  `purchase_orders` populated from `inventory_counts.id`, with a unique index:
  ```sql
  ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS source_count_id uuid REFERENCES inventory_counts(id);
  CREATE UNIQUE INDEX IF NOT EXISTS po_source_count_unique
    ON purchase_orders(source_count_id) WHERE source_count_id IS NOT NULL;
  ```
  Then check for an existing PO for `count_id` at the top of the step (mirroring the
  `flagged-turnover-wo.ts` pattern at lines 17-24), and `ON CONFLICT DO NOTHING` /
  early-return if found.

---

### HIGH: Overdue-schedule WO creation ("no open WO" branch) lacks a unique constraint backstop
- **Area:** Inngest Steps / Race Condition
- **Location:** `lib/inngest/functions/cron/maintenance-schedules.ts:231-253` (Pass 2, `escalate-overdue-${schedule.id}`, "no open WO" else-branch)
- **Description:** This branch queries for an `openWO` (non-terminal WO with
  `source_schedule_id = schedule.id`) at the top of the step (lines 183-190), and
  only inserts a new urgent WO if none is found. On a clean retry of the *same* step
  invocation, this self-heals (the previously-inserted WO will now be found by the
  `openWO` query). However:
  - There is still no DB-level unique constraint on `(source_schedule_id, scheduled_date)`
    for `source = 'maintenance_schedule'` (see CRITICAL #1), so if Pass 1's
    `process-schedule-${schedule.id}` *also* runs for the same schedule (it can — Pass 1
    covers "due within 7 days", Pass 2 covers "past due date"; a schedule whose due
    date is "today" can theoretically appear in both result sets across consecutive
    days as `next_due_date` is mutated mid-run), the two passes can independently
    insert separate WOs for the same schedule with no constraint to catch it.
  - The `openWO` query filters `not('status', 'in', '("completed","cancelled")')` —
    if the PM completes/cancels the WO created by Pass 1 in between Pass 1 and Pass 2
    of the *same* cron run, Pass 2 would not see it as "open" and would create a
    second WO for the same schedule/date.
- **Risk:** Duplicate urgent work orders + duplicate "overdue maintenance" emails to
  the PM for the same maintenance schedule.
- **Recommendation:** Same fix as CRITICAL #1 — add the partial unique index on
  `(source_schedule_id, scheduled_date) WHERE source = 'maintenance_schedule'` and
  have both Pass 1 and Pass 2 catch `23505` as "already created, skip notification."

---

### HIGH: Dead duplicate cron function (`maintenance-check.ts`) has drifted from its registered replacements
- **Area:** Inngest Steps
- **Location:** `lib/inngest/functions/maintenance-check.ts` (797 lines, exports `dailyMaintenanceCheck`, **not imported/registered** in `app/api/inngest/route.ts`)
- **Description:** This file is an old "god function" that the route comment at
  `app/api/inngest/route.ts:13` says was "split ... into 4 focused crons"
  (`dailyMaintenanceScheduleCheck`, `dailyWorkOrderOps`, `dailyAssetHealth`,
  `dailyCommsRetention`). It is correctly *not* registered, so it does not currently
  run. However:
  - It is dead code that still compiles and exports a fully-formed
    `inngest.createFunction(...)` — a future refactor or merge could re-register it
    by accident (e.g., adding it back to the `functions: [...]` array), which would
    cause **all four split crons to run their logic a second time** at `0 13 * * *`
    (and `0 14 * * *` for comms retention), doubling every WO creation, escalation,
    email, and asset-health write described elsewhere in this report.
  - It has *better* idempotency in places than its replacements (e.g., the
    `existingWO` check in Pass 1 described in CRITICAL #1) — meaning the split was
    a regression, and anyone referencing this file as "the source of truth" would
    copy forward already-fixed-then-reverted logic.
- **Risk:** Maintenance hazard / latent duplicate-execution risk if re-registered;
  source of confusion for future contributors fixing bugs in the wrong file.
- **Recommendation:** Delete `lib/inngest/functions/maintenance-check.ts` entirely
  (after porting the missing `existingWO` check per CRITICAL #1 into
  `cron/maintenance-schedules.ts`). Do not leave fully-formed `createFunction()`
  exports for retired functions in the codebase.

---

### HIGH: `auto-assign-turnover.ts` autopilot insert relies on an unhandled unique-constraint error
- **Area:** Inngest Steps / Race Condition
- **Location:** `lib/inngest/functions/auto-assign-turnover.ts:174-208` (step `act-on-mode`, `mode === 'autopilot'` branch)
- **Description:**
  ```ts
  if (mode === 'autopilot') {
    await supabase.from('turnover_assignments').insert({
      turnover_id,
      crew_member_id: top.crew_member_id,
    })
    await supabase.from('turnovers').update({ status: 'assigned', ... }).eq('id', turnover_id)
    return { action: 'autopilot_assigned' as const }
  }
  ```
  This is a plain `.insert()`, not an `.upsert(..., { onConflict, ignoreDuplicates: true })`
  like `assignCrew` and `acceptSuggestion` use elsewhere (`turnovers/actions.ts:46-49`,
  `:402-405`). The `turnover_assignments_crew_unique (turnover_id, crew_member_id)`
  constraint (from `20260609000002_idempotency_hardening.sql:22-24`) WILL prevent a
  literal duplicate row, but:
  - On retry, the `.insert()` call **throws a `23505` error that is not caught** —
    Supabase JS returns `{ data: null, error }` rather than throwing, so the code
    continues to the next line (`turnovers.update(...)`) regardless, but the
    function's return value (`{ action: 'autopilot_assigned' }`) is reported as
    success even on the retry path where the insert silently failed. This isn't a
    *duplicate-row* bug (the constraint prevents that), but it means `record-outcomes`
    (next step) and the function's return shape don't distinguish "first successful
    autopilot assignment" from "retry where insert was a no-op due to existing row" —
    not itself dangerous, but indicates the error path isn't being checked anywhere
    in this function (no `if (error) ...` after any `.insert()`/`.update()` call in
    `act-on-mode`).
- **Risk:** Low direct risk (constraint protects the row), but errors from `insert`
  are silently swallowed throughout this step — a genuine insert failure (e.g., RLS
  misconfiguration, FK violation on `crew_member_id`) would be invisible, and the
  turnover would be marked `status: 'assigned'` even though no `turnover_assignments`
  row exists, leaving the turnover in an inconsistent "assigned but no crew" state.
- **Recommendation:** Check `error` after the `turnover_assignments` insert; if
  `error.code === '23505'`, treat as already-assigned (return early without updating
  `turnovers.status`); for any other error, throw so Inngest retries the whole step
  rather than silently proceeding to mark the turnover assigned.

---

### HIGH: `record-outcomes` step performs an unconditional INSERT with try/catch swallowing retries
- **Area:** Inngest Steps
- **Location:** `lib/inngest/functions/auto-assign-turnover.ts:210-224`
- **Description:**
  ```ts
  await step.run('record-outcomes', async () => {
    const supabase = createServiceClient()
    try {
      await supabase.from('assignment_outcomes').insert({
        turnover_id, org_id, crew_member_id: top.crew_member_id,
        suggested_score: top.score, score_breakdown: top.breakdown,
        was_accepted: acted.action === 'autopilot_assigned' ? true : null,
      })
    } catch {
      // Table may not yet exist — never fail the parent function
    }
  })
  ```
  This is a plain `.insert()` with no existence check and the entire call wrapped in
  a `try/catch` that swallows **all** errors, including `23505` unique-violation
  errors if a constraint exists, AND genuine schema/permission errors. No migration
  in this repo defines `CREATE TABLE assignment_outcomes` or any unique constraint on
  it (the only reference found is a `GRANT` statement in
  `20260609000008_grant_missing_tables_vendor_address.sql:38`), so its actual
  constraints could not be verified from the codebase.
- **Risk:** If this step is retried (function has `retries: 2`), and no unique
  constraint exists on `(turnover_id, crew_member_id)` for `assignment_outcomes`,
  a **duplicate outcome row** is inserted per retry — corrupting the data the
  auto-assignment scoring engine learns from (CLAUDE.md: "learning loop"). Because
  the `try/catch` swallows the error either way, this would never surface as a
  visible failure.
- **Recommendation:** (1) Verify/add a unique constraint
  `UNIQUE (turnover_id, crew_member_id)` on `assignment_outcomes` (this also backs
  the `acceptSuggestion` upsert at `turnovers/actions.ts:416-419`, which already
  assumes this constraint exists via `onConflict: 'turnover_id,crew_member_id'`).
  (2) Replace the bare `.insert()` + swallow-all `try/catch` with
  `.upsert(..., { onConflict: 'turnover_id,crew_member_id' })` and only swallow the
  "table does not exist" error code (`42P01`), re-throwing everything else.

---

### MEDIUM: `notify-assigned-crew` / PM-completion emails have no per-recipient dedup guard
- **Area:** Email/Push Dedup
- **Location:** `lib/inngest/functions/turnover-events.ts:67-94` (`notify-assigned-crew`), `:168-189` (`notify-pm-of-completion`), `:125-148` (`send-unassigned-warning`)
- **Description:** All three steps call `resend.emails.send(...)` directly with no
  "already sent" guard (no dedup table, no `notified_at` column check-and-set). For
  `notify-assigned-crew`, the loop sends one email per assigned crew member inside a
  single `step.run`; if the step throws partway through (e.g., the 3rd of 5 crew
  emails fails), Inngest retries the **entire step**, re-sending emails 1-2 (already
  delivered) plus retrying 3-5.
- **Risk:** Crew members and PMs can receive duplicate "you've been assigned" /
  "turnover complete" / "needs crew" emails on any transient Resend failure or
  Inngest retry. Lower severity than financial duplication, but a real user-facing
  annoyance and erodes trust in notifications.
- **Recommendation:** Either (a) split each recipient's email send into its own
  `step.run(`notify-crew-${crew.id}`, ...)` so Inngest memoizes per-recipient
  success/failure independently, or (b) add a lightweight dedup table
  (`notification_log(entity_type, entity_id, notification_key, sent_at)` with a
  unique constraint) and check-before-send for all PM/crew alert emails across
  `turnover-events.ts`, `work-order-events.ts`, and the cron files.

---

### MEDIUM: `handleBookingDetected` — email send and `guest_messages_sent` insert are not atomic
- **Area:** Email/Push Dedup
- **Location:** `lib/inngest/functions/booking-events.ts:199-228` (`send-booking-confirmation`), `:255-283` (`send-checkout-reminder`)
- **Description:** Both steps call `resend.emails.send(...)` and then, in the same
  step body, `INSERT INTO guest_messages_sent (...)`. There is no check at the start
  of either step for "has this booking+trigger already been sent" (e.g., a SELECT
  against `guest_messages_sent` by `(booking_id, trigger)` before sending). If
  `resend.emails.send` succeeds but the subsequent `guest_messages_sent` insert
  throws (network blip, RLS, etc.), Inngest retries the whole step — `resend.emails.send`
  is called again, sending a **second confirmation/reminder email to the guest**,
  before the insert (this time) succeeds.
- **Risk:** Guests receive duplicate booking-confirmation or pre-checkout-reminder
  emails. No financial impact, but a visible quality issue and potential
  confusion/spam complaints.
- **Recommendation:** Before calling `resend.emails.send`, query
  `guest_messages_sent` for an existing row with `(booking_id, trigger)` (or
  `template_id`) and skip sending if found — mirroring the pattern already used in
  `log-message-comm.ts:37-49` ("Idempotency: ... use it as the dedup key"). Add a
  unique index `UNIQUE (booking_id, trigger)` on `guest_messages_sent` (table not
  found in this repo's migrations — verify it exists and add the constraint if not)
  to give a DB-level backstop.

---

### MEDIUM: `triggerShoppingCart` — Kroger cart can have items added twice on step retry
- **Area:** Race Condition / External Side Effect
- **Location:** `lib/inngest/functions/build-shopping-cart.ts:248-305` (step `build-cart`)
- **Description:** The `build-cart` step both searches for products AND, when a
  valid `customerToken` exists, calls `addItemsToKrogerCart(cartItems, customerToken)`
  — an external API call with a real side effect (adding items to the user's live
  Kroger cart) — all inside one `step.run`. If this step throws *after*
  `addItemsToKrogerCart` succeeds (e.g., an exception while computing `totalEst` or
  assembling the `result` object — unlikely given the code shown, but the step as a
  whole is not memo-safe against partial completion), Inngest retries `build-cart`
  from scratch: `searchProducts` runs again and `addItemsToKrogerCart` is called a
  **second time**, potentially doubling quantities in the user's Kroger cart.
- **Risk:** Org's Kroger cart ends up with duplicate line items / doubled quantities,
  directly costing the property manager money if they check out without noticing.
- **Recommendation:** Split `addItemsToKrogerCart` into its own
  `step.run('add-items-to-kroger-cart', ...)` *after* `build-cart` has computed and
  returned `matchedItems`/`cartItems` (pure computation, safe to retry). This way,
  if the cart-add step itself fails partway, Inngest's per-step memoization ensures
  the (pure) `build-cart` step is not re-executed, and you can additionally guard
  the cart-add step by checking `org_milestones.last_cart_build.built_at` /
  a "cart already added for this request" flag before calling the Kroger API again.

---

### MEDIUM: `updatePurchaseOrderStatus` can fire duplicate `purchase-order/approved` events on double-submit
- **Area:** Race Condition
- **Location:** `app/(dashboard)/inventory/actions.ts:496-536`
- **Description:** When a PM sets a PO's status to `'ordered'`, this action
  unconditionally sends `inngest.send({ name: 'purchase-order/approved', ... })`
  (lines 522-532) regardless of whether the PO's *previous* status was already
  `'ordered'`. There's no `if (po.status === 'ordered') return` guard, and the
  `.update(...)` itself has no `WHERE status != 'ordered'` condition (i.e., no
  "transition guard"). A double-click on "Mark as Ordered" (rapid double-submit)
  sends the event twice.
- **Risk:** Mitigated downstream — `handlePurchaseOrderApproved`
  (`inventory-events.ts:9-47`) checks `source_reference_id` + `source` before
  inserting into `owner_transactions`, so this does NOT create a duplicate
  *financial* transaction. However, it does cause two Inngest function executions
  for no benefit, and any *future* side effect added to that handler (e.g., a
  vendor notification) would not be protected.
- **Recommendation:** Add `.eq('status', po.status).neq('status', 'ordered')` style
  guard, or simpler: read `po.status` before the update and `if (po.status === status) return {}` early — skip both the DB write and the `inngest.send` if the status
  is unchanged.

---

### MEDIUM: `updateTurnoverStatus` fires `turnover/completed` without a "already completed" guard
- **Area:** Race Condition
- **Location:** `app/(dashboard)/turnovers/actions.ts:104-178`
- **Description:** Similar to the PO case above: `updateTurnoverStatus` updates
  `turnovers.status = 'completed'` and then unconditionally sends
  `inngest.send({ name: 'turnover/completed', ... })` (lines 132-150) with no check
  for whether the turnover was already `'completed'`. A double-click on "Mark
  Complete" (or a UI re-submit after a slow network response) issues the event
  twice.
- **Risk:** `post-cleaning-fee-expense` (turnover-events.ts:215-264) IS protected by
  a `source_reference_id` + `source = 'cleaning_fee'` existence check, so no
  duplicate cleaning-fee expense is posted. However:
  - `notify-pm-of-completion` (turnover-events.ts:168-189) has **no guard** — the PM
    receives a duplicate "✅ Turnover complete" email.
  - `record-crew-duration` (turnover-events.ts:266-303) re-runs
    `UPDATE assignment_outcomes SET started_at=..., completed_at=..., duration_minutes=...`
    — idempotent in effect (same values written twice), but two full Inngest
    function executions occur for one user action.
- **Recommendation:** In `updateTurnoverStatus`, before updating, fetch the current
  `status`; if already `'completed'`, return success without re-sending the event
  (`if (current.status === 'completed' && status === 'completed') return { success: true }`).

---

### LOW: OwnerRez reviews-sync cursor uses post-fetch timestamp (inconsistent with bookings sync)
- **Area:** Race Condition (data completeness, not duplication)
- **Location:** `lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts:177-192` (`update-reviews-cursor-${userId}`)
- **Description:** `incremental-sync.ts` and `initial-sync.ts` both deliberately
  capture `fetchStartedAt` *before* calling the OwnerRez API and use that as the new
  cursor (commented "MEDIUM-3: ... Using post-fetch time would miss bookings
  modified during the fetch window"). `ownerrez-reviews-sync.ts`, however, sets
  `const newCursor = new Date().toISOString()` **after** `fetchAllReviews` completes
  (post-fetch).
- **Risk:** Reviews submitted/modified during the fetch window (which can be
  multi-second for paginated review sets) could be skipped on the next incremental
  sync, since `cursor` will be later than their `modified_at`. This is a data-gap
  risk, not a duplication risk (the `external_id,external_source` upsert in
  `upsert-reviews-${userId}` would safely re-absorb a re-fetched review with no
  duplicate row).
- **Recommendation:** Capture `fetchStartedAt` before `fetchAllReviews` (mirroring
  the other two OwnerRez sync functions) and use it as `newCursor`.

---

### LOW: `flagged-turnover-wo.ts` push-notification loop has no per-recipient memoization
- **Area:** Email/Push Dedup
- **Location:** `lib/inngest/functions/flagged-turnover-wo.ts:53-81` (`notify-managers`)
- **Description:** Loops over all `admin|owner|manager` org members and sends a push
  notification to each via `sendPushToCrewMember`, all inside one `step.run`. If the
  step throws partway through the loop (e.g., the 2nd manager's push subscription
  query fails), a retry re-sends to the 1st manager (already notified) as well as
  retrying the 2nd onward. `.catch(() => {})` around each `sendPushToCrewMember` call
  prevents one failed push from failing the whole step, which actually *reduces* the
  retry-trigger likelihood, but doesn't eliminate it (the `push_subscriptions` query
  itself isn't wrapped).
- **Risk:** Low — duplicate push notifications to managers about a flagged-turnover
  WO. Not financial, low user annoyance.
- **Recommendation:** Wrap the per-manager body in `step.run(`notify-manager-${mgr.user_id}`, ...)` for per-recipient memoization, consistent with the recommendation
  for `notify-assigned-crew`.

---

### LOW: `dailyAssetHealth` per-org email loop inside a single step
- **Area:** Email/Push Dedup
- **Location:** `lib/inngest/functions/cron/asset-health.ts:138-160` (inside `score-org-assets-${orgId}`)
- **Description:** After scoring all of an org's assets, any "threshold crossing"
  alerts are emailed to the PM in a `for (const c of crossings)` loop, all within the
  same `score-org-assets-${orgId}` step that also performs the `property_assets`
  health-score `UPDATE`s. If the email loop throws partway (e.g., Resend rate-limit
  on the 2nd email), Inngest retries the whole step: the health-score `UPDATE`s
  (idempotent — same computed values) re-run, AND the already-sent crossing email(s)
  are re-sent.
- **Risk:** Duplicate "asset health alert" emails to PMs on retry. Not financial.
- **Recommendation:** Separate the score-computation/`UPDATE` step (pure, safe to
  retry) from a follow-up `step.run('send-asset-health-alerts-${orgId}', ...)` step
  that only sends emails — keeps retry semantics clean for each concern. (Note the
  refactored `maintenance-check.ts` dead-code version made a similar split using
  `updates.push(...)` + a single batched `upsert`, which is a good pattern to carry
  into `cron/asset-health.ts` as well — but only the score/update logic, not the
  email loop.)

---

## Inngest Function Inventory

| Function file | Event | Steps | step.run IDs deterministic? | Idempotency guard present? |
|---|---|---|---|---|
| `ical-sync.ts` (`syncAllIcalFeeds`) | cron `0 * * * *` / `ical/sync.all.requested` | fetch-active-feeds, fan-out-feed-syncs (sendEvent) | Yes | N/A (read + fan-out only) |
| `ical-sync.ts` (`syncIcalFeed`) | `ical/sync.requested` | fetch-feed-url, download-ical, parse-ical, upsert-bookings, cancel-affected-turnovers, generate-turnovers, fire-downstream-events, mark-sync-success | Yes | Yes — `bookings` upsert on `ical_feed_id,ical_uid` (unique index `bookings_ical_uid_unique`); `org_milestones` upsert with `ignoreDuplicates` |
| `booking-events.ts` (`handleBookingConfirmed`) | `booking/confirmed` | post-booking-revenue | Yes | Yes — `source_reference_id` + `source` check before insert |
| `booking-events.ts` (`handleBookingDetected`) | `booking/detected` | fetch-data, create-booking-revenue-transaction, send-booking-confirmation, wait-for-checkout-window (sleepUntil), check-booking-status, send-checkout-reminder | Yes | Partial — revenue txn checked via `source_reference_id`+`source`; **email sends not guarded** (MEDIUM finding) |
| `turnover-events.ts` (`handleTurnoverCreated`) | `turnover/created` | fetch-turnover-data, notify-assigned-crew, wait-for-assignment-deadline (sleepUntil), check-assignment-status, send-unassigned-warning | Yes | No — email sends unguarded (MEDIUM finding) |
| `turnover-events.ts` (`handleTurnoverCompleted`) | `turnover/completed` | notify-pm-of-completion, record-completion-milestones, post-cleaning-fee-expense, record-crew-duration | Yes | Partial — `post-cleaning-fee-expense` checks `source_reference_id`+`source`; milestones use `ignoreDuplicates`; **notify-pm-of-completion unguarded** (MEDIUM finding) |
| `auto-assign-turnover.ts` | `turnover/created` | load-context, score-candidates, notify-assignment-gap (sendEvent), act-on-mode, record-outcomes | Yes | Partial — `act-on-mode` autopilot insert protected only by DB unique constraint, errors unchecked (HIGH); `record-outcomes` unconditional insert wrapped in swallow-all try/catch (HIGH) |
| `flagged-turnover-wo.ts` | `turnover/flagged` | create-draft-wo, notify-managers | Yes | Yes — explicit existence check on `(source_turnover_id, source='crew_flag')` before insert, backed by `wo_crew_flag_source_unique` |
| `work-order-events.ts` (`handleWorkOrderCreated`) | `work-order/created` | send-vendor-portal-link, schedule-overdue-check | Yes | N/A (read/notify only; portal token regenerated each time but harmless) |
| `work-order-events.ts` (`handleWorkOrderCompleted`) | `work-order/completed` | post-wo-expense | Yes | Yes — `upsert(..., { onConflict: 'source_reference_id,source', ignoreDuplicates: true })` |
| `work-order-events.ts` (`handleWorkOrderCompletedViaPortal`) | `work-order/completed-via-portal` | notify-pm-of-completion | Yes | Yes — same upsert/ignoreDuplicates pattern for `owner_transactions` |
| `work-order-events.ts` (`handleWorkOrderOverdue`) | `work-order/overdue` | check-and-alert | Yes | No explicit guard, but checks WO status !== completed/cancelled before alerting (low risk — single event per overdue trigger) |
| `work-order-events.ts` (`handleWorkOrderQuoteRequested`) | `work-order/quote-requested` | send-vendor-quote-request | Yes | No — re-send would re-email vendor (low likelihood, manual trigger) |
| `work-order-events.ts` (`handleWorkOrderQuoteSubmitted`) | `work-order/quote-submitted` | notify-pm-of-quote | Yes | No — re-send would re-email PM (low likelihood) |
| `inventory-events.ts` (`handlePurchaseOrderApproved`) | `purchase-order/approved` | post-inventory-expense | Yes | Yes — `source_reference_id`+`source` check before insert |
| `inventory-events.ts` (`handleInventoryCountSubmitted`) | `inventory/count-submitted` | apply-count-and-check-par, create-purchase-order, record-first-po-milestone, email-po-to-pm | Yes | **No** — `create-purchase-order` has no existence check / unique constraint (CRITICAL finding) |
| `cron/maintenance-schedules.ts` (`dailyMaintenanceScheduleCheck`) | cron `0 13 * * *` | find-due-schedules, process-schedule-${id} (×N), find-overdue-schedules, escalate-overdue-${id} (×N), check-thirty-day-milestone | Yes | **No** for Pass 1 auto-WO insert (CRITICAL); Pass 2 partially self-healing via `openWO` re-query (HIGH) |
| `cron/work-order-ops.ts` (`dailyWorkOrderOps`) | cron `0 13 * * *` | find-aging-work-orders, escalate-aging-wo-${id} (×N), detect-repeat-issues, find-auto-wo-schedules, auto-create-wo-${id} (×N) | Yes | Yes — `auto-create-wo-${id}` has `existingWO` check; `detect-repeat-issues` uses `org_milestones` 30-day dedup |
| `cron/asset-health.ts` (`dailyAssetHealth`) | cron `0 13 * * *` | find-assets-for-scoring, fetch-asset-standards, fetch-asset-repair-history, score-org-assets-${orgId} (×N), find-expiring-compliance-docs, compliance-alert-${id}-t${threshold} (×N) | Yes | Mostly — `compliance-alert-*` records `org_milestones` dedup row BEFORE sending email (good); `score-org-assets-${orgId}` mixes idempotent `UPDATE`s with non-idempotent email loop (LOW finding) |
| `cron/comms-retention.ts` (`dailyCommsRetention`) | cron `0 14 * * *` | find-comms-retention-orgs, comms-log-retention-${orgId} (×N) | Yes | Yes — soft-delete/hard-purge are naturally idempotent (re-running matches fewer/no rows) |
| `cron/audit-retention.ts` (`auditRetentionCron`) | cron `0 3 1 * *` | purge-expired-audit-events (RPC) | Yes | Yes — DB-side purge by date range, naturally idempotent |
| `maintenance-check.ts` (`dailyMaintenanceCheck`) — **DEAD CODE, not registered** | cron `0 13 * * *` | (full duplicate of all of the above 3 crons combined) | Yes | Mixed — Pass 1 HAS the `existingWO` check missing from the live `cron/maintenance-schedules.ts` (HIGH finding re: drift) |
| `ownerrez/initial-sync.ts` | `integration/ownerrez.connected` | fetch-properties, patch-property-fields, fetch-bookings, update-last-synced | Yes | Yes — `properties`/`bookings` upserts on `external_id,external_source`; cursor uses pre-fetch timestamp |
| `ownerrez/incremental-sync.ts` | cron `0/15 * * * *` / `integration/ownerrez.sync.requested` | sync-user-${userId} (×N), rate-limit-backoff-${userId} (sleep, top-level) | Yes | Yes — `bookings` upsert on `external_id,external_source`; cursor uses pre-fetch timestamp |
| `ownerrez/ownerrez-reviews-sync.ts` | cron `0 */6 * * *` / `integration/ownerrez.connected` | fetch-reviews-${userId}, fetch-reviews-retry-${userId}, upsert-reviews-${userId}, update-reviews-cursor-${userId} | Yes | Yes (no dup rows — `reviews` upsert on `external_id,external_source`); cursor uses **post-fetch** timestamp (LOW finding) |
| `build-shopping-cart.ts` (`buildShoppingCart`) | `inventory/cart_requested` | load-inventory-data, refresh-customer-token, normalize-item-names, search-kroger-products-${batchIdx} (×N), build-cart, persist-result | Yes | Partial — `persist-result` upserts `org_milestones` correctly; **`build-cart`'s external Kroger cart-add has no retry isolation** (MEDIUM finding) |
| `geocoding-backfill.ts` | `geocoding/backfill-requested` (manual/internal only) | geocode-properties, geocode-vendors | Yes | Yes — only updates rows `WHERE lat IS NULL`, naturally idempotent |
| `checklist-broadcast.ts` (`broadcastChecklistTemplateJob`) | `checklist/template-broadcast` | load-source-template, broadcast-to-${targetId} (×N) | Yes | Yes — `checklist_templates` upsert on `property_id,org_id`; sections/items are full delete+reinsert per target (idempotent end-state, though not atomic — acceptable for this use case) |
| `log-message-comm.ts` (`logMessageCommunication`) | `message/sent` | fetch-message, resolve-crew-member, write-comms-log | Yes | Yes — explicit existence check on `(org_id, crew_member_id, source='system', communicated_at)` before insert |
| `capex-projections.ts` (`generateCapexProjections`) | cron `0 0 1 * *` | fetch-orgs, project-org-${orgId} (×N) | Yes | Yes — `org_milestones` upsert on `org_id,milestone` (full overwrite each run) |
| `depreciation-ledger.ts` (`generateDepreciationLedger`) | `asset/depreciation-ledger-requested` / cron `0 0 1 1 *` | load-assets, fetch-prior-cumulative, upsert-entries-${orgId} (×N) | Yes | Yes — `asset_depreciation_entries` upsert on `asset_id,tax_year` (UNIQUE constraint per CLAUDE.md); `org_milestones` upsert |

---

## Appendix: relevant migration excerpts (idempotency ledger / unique constraints)

### `supabase/migrations/20260609000002_idempotency_hardening.sql`
```sql
-- CRIT-1: Stripe at-least-once deduplication table
CREATE TABLE IF NOT EXISTS public.stripe_processed_events (
  stripe_event_id TEXT        PRIMARY KEY,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CRIT-2/6: owner_transactions idempotency backstop
ALTER TABLE public.owner_transactions
  ADD CONSTRAINT owner_transactions_source_ref_unique
  UNIQUE (source_reference_id, source);

-- CRIT-4: turnover_assignments uniqueness backstop
ALTER TABLE public.turnover_assignments
  ADD CONSTRAINT turnover_assignments_crew_unique
  UNIQUE (turnover_id, crew_member_id);

-- CRIT-8: One crew-flag WO per flagged turnover (prevents Inngest retry duplicates)
CREATE UNIQUE INDEX IF NOT EXISTS wo_crew_flag_source_unique
  ON public.work_orders(source_turnover_id)
  WHERE source = 'crew_flag' AND source_turnover_id IS NOT NULL;

-- HVI-2: bookings iCal uid uniqueness (enables safe bulk upsert)
CREATE UNIQUE INDEX IF NOT EXISTS bookings_ical_uid_unique
  ON public.bookings(ical_feed_id, ical_uid)
  WHERE ical_uid IS NOT NULL;
```
**Gap:** No equivalent unique index exists for `work_orders` where
`source = 'maintenance_schedule'` (e.g., on `(source_schedule_id, scheduled_date)`),
which is the missing backstop for CRITICAL #1 and HIGH #3 above. No unique
constraint exists for `purchase_orders` tying a PO back to its originating
`inventory_count`, which is the missing backstop for CRITICAL #2.

### `supabase/migrations/20260609000007_ownerrez_webhook_dedup.sql`
```sql
CREATE TABLE IF NOT EXISTS ownerrez_processed_webhooks (
  webhook_id   TEXT        PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ownerrez_webhooks_processed_at
  ON ownerrez_processed_webhooks (processed_at);

ALTER TABLE ownerrez_processed_webhooks ENABLE ROW LEVEL SECURITY;
-- No user-facing policies: service-role only
```
**Verified usage:** `app/api/webhooks/[provider]/route.ts:121-150` correctly inserts
into this table keyed on `payload.id` BEFORE delegating to
`providerAdapter.handleWebhookEvent(...)`, treats `23505` as "duplicate, discard,"
and performs a 72-hour TTL cleanup on each request — matches the migration's intent.

### Stripe webhook (`app/api/webhooks/stripe/route.ts:16-39`)
```ts
event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!)
// ... (signature verified BEFORE any DB access)

const { error: dedupErr } = await supabase
  .from('stripe_processed_events')
  .insert({ stripe_event_id: event.id })
if (dedupErr) {
  if (dedupErr.code === '23505') {
    return NextResponse.json({ received: true })   // already processed — short-circuit
  }
  console.error('[Stripe] dedup insert failed (non-fatal):', dedupErr.message)
}
```
**Verified:** Signature verification happens first (lines 17-26, returns 400 on
failure before any processing); the `stripe_processed_events` dedup insert happens
immediately after and before the `switch (event.type)` block — correctly ordered.
The only soft spot is that a dedup-insert failure for a reason *other than* `23505`
is logged but does not block processing (intentional — "non-fatal" — to avoid
dropping legitimate events if the ledger table itself has a transient issue, but
means a sustained ledger outage would disable dedup entirely without alerting).
