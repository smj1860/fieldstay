# Codebase Map — Pass 2: The Internal Event / Automation Graph

Pass 1 mapped where data *enters* FieldStay. This pass maps what happens
next: the ~70-event Inngest graph (`lib/inngest/events.ts`) that turns a
boundary event into the automations CLAUDE.md calls "the core promise" —
turnover completes → expense posts, inventory drops → cart builds, WO is
created → vendor is notified.

Format per chain: **origin → event → consumer function(s) → events it
re-emits (if any) → terminal effect** (DB write / email / SMS / Stripe call).
"Origin" is either a boundary route/Server Action (Pass 1) or a cron.

---

## 1. Bookings → Turnovers (the core turnover pipeline)

```
OwnerRez/Hospitable/Hostaway/iCal sync functions (see §6)
  └─ emit turnover/created  ──────────────► turnover-events.ts (turnover-created)
                                             └─ builds checklist_instance, computes
                                                is_same_day_turnover
     also triggers               ──────────► auto-assign-turnover.ts
                                             └─ scores crew, sets suggested_crew_ids
                                                / suggestion_reasoning
                                             └─ if no viable crew found, emits
                                                crew/assignment-gap
                                                  └─ notify-assignment-gap.ts
                                                     → PM email (renderPmAlert)
                                             └─ writes assignment_outcomes
                                                (was_suggestion, suggested_score,
                                                score_breakdown) for the learning
                                                loop below

turnovers/actions.ts (PM assigns crew manually — accepts or overrides the
suggestion, or a plain manual assign with no suggestion involved)
  └─ emits turnover/crew-assigned ────────► crew-assignment.ts
                                             └─ writes turnover_assignments,
                                                notifies crew (push/SMS)
     also writes/updates assignment_outcomes (was_accepted, override_reason,
     suggestion_status: accepted/overridden) via trackAssignmentAgainstSuggestions()

turnovers/[id]/turnover-rating.tsx (PM submits 1–5 star post-completion rating)
  └─ rateTurnoverCompletion() writes assignment_outcomes.pm_rating directly
     (no event — a same-request DB write, not part of the async graph)

cron/crew-score-recompute.ts (nightly, standalone — closes the learning loop)
  └─ reads unscored assignment_outcomes (scored_at IS NULL), computes
     was_late/was_missed from checklist timestamps + pm_rating, applies a
     reliability_score delta per crew member, marks scored_at
  └─ no event in/out — pure scheduled recompute, same shape as
     cron/asset-health.ts in §3

turnovers/actions.ts, app/api/crew/turnovers/[id]/complete
  └─ emits turnover/completed ────────────► turnover-events.ts (turnover-completed)
                                             └─ posts owner_transactions
                                                (source: wo_completion — actually
                                                cleaning_fee/turnover cost),
                                                idempotent on source_reference_id

turnovers/actions.ts
  └─ emits turnover/flagged ──────────────► flagged-turnover-wo.ts
                                             └─ auto-creates a work_order
                                                (wo_source: crew_flag)

app/api/crew/turnovers/[id]/start
  └─ emits turnover/started               (no dedicated consumer function —
                                            logged for analytics/future use)
```

**Standalone crons in this domain (no incoming event, time-driven only):**
`cron/turnover-priority-decay.ts` (09:00 CT) — decays aging turnover
priority scores. No event in, no event out.

---

## 2. Work Orders (creation → dispatch → completion → invoice → payment)

This is the deepest chain in the graph.

```
maintenance/actions.ts (manual create), cron/maintenance-schedules.ts,
cron/work-order-ops.ts (aging/repeat-issue detection)
  └─ emit work-order/created ─────────────► work-order-events.ts (work-order-created)
                                             └─ selects vendor if auto-assign,
                                                writes wo_number via
                                                wo_number_counters

maintenance/actions.ts (createWorkOrder / createWorkOrderFromSchedule),
cron/work-order-ops.ts (auto-create-wo step) — only when the WO has a
category (manual category field, or derived from vendor_specialty_hint)
and org.vendor_auto_assign_mode = 'suggest'
  └─ emit work-order/vendor-suggestion.requested ► auto-assign-vendor.ts
                                             └─ scores vendor candidates
                                                (geo proximity, specialty
                                                match, compliance-status
                                                penalty/exclusion,
                                                familiarity), sets
                                                suggested_vendor_ids /
                                                suggestion_reasoning,
                                                writes vendor_assignment_outcomes
                                                (was_suggestion, suggested_score,
                                                score_breakdown) — mirrors the
                                                crew auto-assign-turnover.ts
                                                shape in §1, using the shared
                                                lib/scoring/geo.ts helpers

maintenance/actions.ts (PM accepts/dismisses a vendor suggestion)
  └─ acceptVendorSuggestion emits work-order/vendor.assigned (see below) and
     updates vendor_assignment_outcomes (was_accepted, suggestion_status:
     accepted); dismissVendorSuggestion only updates suggestion_status:
     dismissed, no event
     Any other vendor assignment (bulkAssignVendor) while a suggestion was
     pending records suggestion_status: overridden via
     trackVendorAssignmentAgainstSuggestions()

cron/vendor-score-recompute.ts (nightly, standalone)
  └─ recomputes vendors.avg_rating/rating_count from wo vendor_rating and
     on_time_pct/on_time_sample_size from vendor_assignment_outcomes —
     same shape as cron/crew-score-recompute.ts in §1
  └─ no event in/out

maintenance/actions.ts (vendor dispatch)
  └─ emits work-order/dispatched ─────────► work-order-dispatch.ts
                                             └─ emails vendor a public
                                                completion-token link
                                                (Resend)

maintenance/actions.ts (vendor assigned/reassigned)
  └─ emits work-order/vendor.assigned ────► work-order-vendor-assigned.ts
                                             └─ vendor compliance check,
                                                notifies vendor

maintenance/actions.ts (internal crew assigned, no vendor)
  └─ emits work-order/crew.assigned ──────► work-order-crew-assigned.ts
                                             └─ surfaces WO in crew PWA via
                                                Dexie sync

app/api/crew/work-orders/[id]/complete
  └─ emits work-order/crew.completed ─────► work-order-crew-completed.ts
                                             └─ marks wo_status: completed

maintenance/actions.ts (quote request), also actions.ts line 672
  └─ emits work-order/quote-requested ────► work-order-events.ts
                                             (work-order-quote-requested)
                                             └─ emails vendor a quote-token link

app/api/work-orders/[token]/quote (vendor submits quote, no session)
  └─ emits work-order/quote-submitted ────► work-order-events.ts
                                             (work-order-quote-submitted)
                                             └─ notifies PM

maintenance/actions.ts (PM marks complete)
  └─ emits work-order/completed ──────────► work-order-events.ts (work-order-completed)
                                             └─ posts owner_transactions
                                                (idempotent on
                                                source_reference_id)

app/api/work-orders/[token]/complete (vendor completes via public portal)
  └─ emits work-order/completed-via-portal ► work-order-events.ts
                                             └─ same posting path as above
  └─ ALSO emits work-order/invoice-submitted (line 193) and, once signed
     off, turnover/completed (line 226) — one route firing three chains.

app/actions/work-order-public.ts (vendor invoice submit)
  └─ emits work-order/invoice-submitted ──► work-order-invoice.ts
                                             └─ creates invoice record,
                                                notifies PM

app/actions/work-order-public.ts (PM signs off on invoice)
  └─ emits work-order/signed-off ─────────► work-order-dispatch.ts
                                             (work-order-signed-off)
                                             └─ emails vendor sign-off
                                                confirmation

Stripe webhook (invoice payment captured)
  └─ emits work-order/invoice-paid ───────► work-order-invoice-paid.ts
                                             └─ marks invoice paid, emails
                                                vendor "you've been paid"

cron/work-order-ops.ts (13:00 UTC daily)
  └─ scans for aging/overdue WOs, emits work-order/aging-escalated
     (no dedicated listener found — priority bump handled inline in the
     same cron) and work-order/overdue ─────► work-order-events.ts
                                                (work-order-overdue)
                                                └─ notifies PM
  └─ also emits maintenance/repeat-issue-detected (no dedicated listener —
     recorded for analytics inline)
  └─ can itself emit work-order/created when repeat-issue detection
     decides a new WO is warranted
```

---

## 3. Maintenance Schedules & Asset Health

```
cron/maintenance-schedules.ts (08:00 CT daily)
  └─ walks maintenance_schedules where next_due_date is near,
     emits work-order/created when auto_create_wo is true
     (feeds into §2's work-order-created chain)
  └─ emails PM (renderPmAlert) for schedules needing manual attention

app/(dashboard)/properties/.../checklist/actions.ts
  └─ emits checklist/template-broadcast ──► checklist-broadcast.ts
                                             └─ fans a checklist template out
                                                to target properties

setup/checklist-template/actions.ts
  └─ emits checklist/master-template.apply.requested
                                          ──► apply-master-checklist.ts
                                             └─ seeds org_master_checklist_items
                                                onto selected properties

capital-planning/actions.ts
  └─ emits asset/depreciation-ledger-requested ► depreciation-ledger.ts
                                             └─ writes asset_depreciation_entries
                                                (MACRS), UNIQUE(asset_id, tax_year)
  └─ emits asset/capex-projection-requested ► capex-projection-trigger.ts
                                             └─ triggers capex-projections.ts logic
```

**Standalone crons (no event in/out — pure scheduled sweeps):**
`cron/asset-health.ts` (08:00 CT) recomputes `property_assets.health_score`.
`cron/checklist-signals.ts` (23:00 CT, before asset-health) feeds signals
asset-health consumes. `capex-projections.ts` also runs standalone on
`0 0 1 * *` (monthly) independent of the requested-event path.
`depreciation-ledger.ts` also has a standalone `0 0 1 1 *` (Jan 1) cron leg.

---

## 4. Inventory & Purchase Orders

```
app/api/crew/inventory-count, inventory/actions.ts
  └─ emits inventory/count-submitted ─────► inventory-events.ts
                                             (inventory-count-submitted)
                                             └─ recomputes current_quantity,
                                                may trigger below-par detection
                                                (in-JS filter — no supabase.raw())

inventory/actions.ts (PM approves a PO)
  └─ emits purchase-order/approved ───────► inventory-events.ts
                                             (purchase-order-approved)
                                             └─ posts owner_transactions
                                                (source: inventory_purchase)

inventory/actions.ts (cart build request)
  └─ emits inventory/cart_requested ──────► build-shopping-cart.ts
                                             └─ calls Kroger API, builds cart,
                                                emails/notifies PM
```

`inventory/below-par` is defined in `events.ts` but no producer or
consumer currently references it by name — likely superseded by the
inline below-par check inside `inventory-events.ts`'s count-submitted
handler. Worth confirming if it's dead before a future cleanup pass.

`inventory-order-email-cron.ts` (18:00 CT) is a standalone daily digest —
no event in or out.

---

## 5. Integrations — Connect & Sync Lifecycles

Each PMS provider follows the same shape: **connect → initial sync →
recurring incremental sync**, plus a shared token-refresh and
connection-error path.

```
app/connect/finish, app/api/integrations/[provider]/callback (OAuth done),
app/api/integrations/[provider]/callback/oneclick (marketplace-initiated —
see Pass 1 §2; always routes through the same hold-token → /connect/finish
claim as the standard callback's no-session branch, regardless of any
active session, then converges on the same connected event below)
  └─ emits integration/ownerrez.connected ► ownerrez/initial-sync.ts,
                                             ownerrez-reviews-sync.ts, AND
                                             email-ownerrez-connected.tsx
                                             (three listeners on one event
                                             — the .tsx one only emails
                                             the PM a confirmation)
                                             └─ initial-sync backfills
                                                properties/bookings, emits
                                                turnover/created per booking
                                                (→ §1) and integration/
                                                connection.error on failure
                                                (→ notify-integration-error.ts)
                                             └─ for confirmed guest-stay
                                                bookings, also emits
                                                booking/confirmed (see
                                                revenue-posting note below)

  └─ emits integration/hospitable.connected ► hospitable/initial-sync.ts
                                             AND email-hospitable-connected.tsx
                                             (two consumers on one event —
                                             the .tsx one only emails the
                                             PM a "you're connected"
                                             confirmation)
                                             └─ same shape, emits
                                                turnover/created and (for
                                                confirmed guest-stay
                                                bookings) booking/confirmed

  └─ emits integration/kroger.connected ──► kroger-connected.ts
                                             └─ auto-configures store prefs

  └─ emits integration/hostaway.sync.requested ► hostaway/initial-sync.ts
                                             └─ emits turnover/created

settings/integrations/actions.ts (manual "sync now")
  └─ emits ownerrez/sync.now.requested ───► ownerrez/incremental-sync.ts
                                             (shared handler, see below)

lib/integrations/providers/ownerrez.ts, ownerrez-api.ts (internal callers)
  └─ emit integration/ownerrez.sync.requested ► ownerrez/incremental-sync.ts
       (cron '0/15 * * * *' ALSO triggers this same function — three
       trigger paths converge on one handler: cron, webhook-relay, and
       manual "sync now")
                                             └─ emits turnover/created,
                                                integration/connection.error,
                                                and booking/confirmed for
                                                confirmed guest-stay bookings

app/api/webhooks/[provider]/route.ts (Hospitable webhook)
  └─ calls lib/integrations/providers/hospitable.ts, which emits
     integration/hospitable.sync.requested ► hospitable/incremental-sync.ts
                                             └─ emits turnover/created,
                                                repuguard/batch_generate.requested,
                                                booking/confirmed
     integration/hospitable.property_merged ► hospitable/property-merge.ts
                                             └─ repoints property FKs from
                                                previous_external_id to
                                                new_external_id

booking/confirmed (emitted by both providers above, on both their initial
and incremental syncs, for status: confirmed + stay_type: guest_stay
bookings — NOT for owner_stay bookings or blocks)
  └─ ────────────────────────────────────► booking-events.ts
                                             (handleBookingConfirmed)
                                             └─ posts owner_transactions
                                                (source: booking_revenue,
                                                idempotent on
                                                source_reference_id);
                                                falls back to an
                                                avg_nightly_rate estimate
                                                when the event has no
                                                actual_total_amount (true
                                                for OwnerRez — its booking
                                                payload has no total; Hospitable
                                                supplies one when available)
     Uplisting and generic iCal-sourced bookings do NOT currently emit this
     event — revenue posting is OwnerRez/Hospitable-only today.

hospitable/teammate-sync-cron.ts (09:00 daily, standalone)
  └─ emits integration/hospitable.teammate_sync.requested
                                          ──► hospitable/teammate-sync-handler.ts
                                             └─ reconciles crew_members
                                                (Hospitable has no teammate
                                                webhook — this is the only
                                                path that picks up changes)

cron/integration-token-refresh.ts (every 2h, standalone)
  └─ emits integration/token.proactive.refresh.requested
                                          ──► cron/integration-token-refresh-handler.ts
                                             └─ refreshes OAuth tokens for
                                                all providers

Any provider's sync failure
  └─ emits integration/connection.error ──► notify-integration-error.ts
                                             └─ emails PM, throttled once
                                                per 4h per connection
```

`ical-sync.ts` runs both as an hourly cron (`0 * * * *`) and as a
listener on `ical/sync.all.requested` (fired manually from
`bookings/actions.ts` and `turnovers/actions.ts`) — same handler, two
trigger paths, matching the OwnerRez incremental-sync pattern above. It
fans out per-feed to `ical/sync.requested`, and on detecting a new
booking emits `booking/detected` → `booking-events.ts` → emits
`turnover/created` (→ §1).

`geocoding-backfill.ts` is a one-time manual-trigger utility
(`geocoding/backfill-requested`) — not part of any recurring chain.

---

## 6. Billing / Stripe

**Correction (verified in a follow-up pass):** the original version of
this section missed `lib/inngest/functions/*.tsx` files — the initial
Glob only matched `*.ts`. Four `.tsx` functions exist:
`email-hospitable-connected.tsx`, `email-ownerrez-connected.tsx`,
`email-trial-lifecycle.tsx`, `onboarding-drip.tsx`. Two of the three
"unmatched" billing/onboarding events below were actually wired the
whole time.

```
Stripe webhook (subscription.created/updated)
  └─ updates organizations.plan/plan_status/max_properties INLINE,
     synchronously, in the same webhook handler (not event-driven)
  └─ ALSO emits billing/subscription-updated — genuinely orphaned, see
     "Confirmed Dead / Orphaned" below. The org-state write already
     happened above; this send reaches no listener.

Stripe webhook (subscription.created while trialing)
  └─ emits billing/trial-lifecycle-start ─► email-trial-lifecycle.tsx
                                             (WIRED — corrects the
                                             original unmatched flag)
                                             └─ emails the org admin the
                                                trial welcome sequence

Stripe webhook (org's first successful payment)
  └─ emits billing/first-payment-confirmed ► email-subscriber-checkin.ts
                                             └─ fires a founder check-in
                                                email sequence

app/onboarding/actions.ts
  └─ emits user/onboarding.drip.started ──► onboarding-drip.tsx
                                             (WIRED — corrects the
                                             original unmatched flag;
                                             registered in
                                             app/api/inngest/route.ts)
                                             └─ sends the onboarding
                                                email drip sequence
```

---

## 7. Self-Funding Guidebook (sponsor + guest SMS lifecycle)

```
Stripe webhook (sponsor checkout completes)
  └─ emits guidebook/sponsor.checkout.completed ► guidebook-sponsor-activated.ts
                                             └─ activates sponsor slot

Stripe webhook (sponsor subscription cancelled / payment failed)
  └─ emits guidebook/sponsor.subscription.cancelled
     emits guidebook/sponsor.payment.failed ► guidebook-sponsor-deactivated.ts
                                             (single function listens to both)

Stripe webhook (recovered payment)
  └─ emits guidebook/sponsor.payment.recovered ► guidebook-sponsor-payment-recovered.ts

guidebook-daily-monitor.ts (13:00 UTC / 8am CT, standalone cron)
  └─ emits guidebook/billing.credit.evaluate ► guidebook-billing-credit-handler.ts
  └─ emits guidebook/grace.period.expired ─► guidebook-grace-expired-handler.ts
                                             └─ deactivates guidebook after
                                                trial/grace window lapses

app/actions/guidebook.ts (guest SMS opt-in page)
  └─ emits guidebook/guest.opted.in ──────► guidebook-guest-opted-in.ts
                                             └─ writes guidebook_guest_sms_optins,
                                                sends confirmation SMS
                                                (gated on SMS_ENABLED)

guidebook-stay-extension-cron.ts (11am ET daily, standalone)
  └─ finds gap-night opportunities, emits guidebook/stay.extension.request
                                          ──► guidebook-stay-extension-handler.ts
                                             └─ notifies guest via
                                                ownerrez_url / email / sms
                                                depending on contactMethod
```

**Standalone crons, no event in/out:** `guidebook-sms-morning-cron.ts`
(noon UTC), `guidebook-sms-evening-cron.ts` (22:00 UTC), and
`guidebook-pre-arrival-email-cron.ts` (14:00 UTC) each independently
query bookings/configs and send guest SMS/email directly — they don't
participate in the event graph at all.

---

## 8. Support, Messaging, Vendor Compliance — small independent chains

```
app/api/support/chat/route.ts (bot escalates to human)
  └─ emits support/conversation.escalated ► support-conversation-escalated.ts
                                             └─ emails support inbox

messages/actions.ts (in-app crew↔PM message sent)
  └─ emits message/sent ───────────────────► log-message-comm.ts
                                             └─ writes communication_logs

reviews/actions.ts (PM requests AI review responses)
  └─ emits repuguard/batch_generate.requested ► repuguard-batch-generate.ts
                                             └─ generates review_responses
                                                (also triggered by
                                                hospitable/incremental-sync.ts
                                                after a review sync)
```

**Resolved (was previously flagged unmatched):** `vendor-compliance/expiry-warning`
is now wired end-to-end. `cron/vendor-compliance-expiry-check.ts` (6am CT
daily) scans `vendor_compliance_documents` for active docs whose
`expiry_date` falls within the next 30 days and haven't been warned yet
(`first_warned_at IS NULL`), flips that gate atomically per document, and
emits this event once per newly-entering document.
`notify-vendor-compliance-expiring.ts` consumes it and sends two emails:
an informational `renderPmAlert` to the PM, and a polite renewal nudge
(`lib/resend/emails/vendor-compliance-nudge.tsx`) to the vendor. This
finally realizes what the `first_warned_at` column comment always said it
was for ("trigger the Inngest ... escalation reminder") — before this,
the column was written nowhere and the reminder never existed.

`repuguard/activated` — left alone for now. No producer or consumer;
`organizations.repuguard_status` is still set directly by the Stripe
webhook with no automation firing on activation.

---

## 9. Cross-Cutting: the Dead-Letter Handler

`on-failure.ts` listens to Inngest's own built-in `inngest/function.failed`
system event (not a `FieldStayEvents` entry) — it fires whenever **any**
function above exhausts its retries. It always logs; for a small
allow-list of revenue-critical function IDs (`ownerrez-initial-sync`,
`ownerrez-incremental-sync`, `work-order-created`) it also emails
`stephen@fieldstay.app` via `renderPmAlert`.

**Correction:** an earlier version of this doc flagged this call site's
`renderPmAlert({ heading, body, details, ctaLabel, ctaUrl })` as not
matching CLAUDE.md's documented signature (`{ ctaLabel, ctaUrl, details }`
only). Verified against the actual source
(`lib/resend/emails/pm-alert.tsx`): `heading` and `body` are required
props on the real `PmAlertProps` interface, and every call site across
the event graph (this one, `cron/maintenance-schedules.ts`, etc.) passes
them. CLAUDE.md's own reference is the stale one here, not this code —
no fix needed at this call site.

---

## Standalone Crons With No Event Participation

These run on a schedule and never appear as either a producer or consumer
elsewhere in the graph — pure background sweeps:

```
cron/comms-retention.ts            14:00 UTC daily — purges old communication_logs
cron/audit-retention.ts            03:00 UTC, 1st of month — purges old audit_events
cron/stale-feed-alert.ts           15:00 UTC daily — flags dead iCal feeds
cron/turnover-priority-decay.ts    14:00 UTC daily — decays turnover priority scores
cron/checklist-signals.ts          23:00 UTC daily — feeds asset-health's next run
cron/asset-health.ts               13:00 UTC daily — recomputes health_score
cron/vendor-connect-onboarding.ts  07:00 UTC daily — vendor Connect onboarding nudges
capex-projections.ts               monthly (0 0 1 * *) standalone leg
depreciation-ledger.ts             annual (0 0 1 1 *) standalone leg
guidebook-sms-morning-cron.ts      noon UTC daily
guidebook-sms-evening-cron.ts      22:00 UTC daily
guidebook-pre-arrival-email-cron.ts 14:00 UTC daily
cron/guest-pii-retention.ts        14:15 UTC daily — 15 min after comms-retention, purges guest PII
cron/metrics-snapshot.ts           every 30 min — snapshots platform metrics
cron/vendor-compliance-grace-check.ts 11:15 UTC daily — 15 min after vendor-compliance-expiry-check, escalates grace/hard-block state
cron/notification-digest.ts        12:00 UTC daily — writes notification_digest_state snapshots (added 2026-07-15/16)
cron/daily-wrapup.ts               23:00 UTC daily — PM 6pm-local wrap-up digest email, reads notification_digest_state
```

---

## Summary

| Domain | Chain depth | Notable pattern |
|---|---|---|
| Turnovers | 3 hops (sync → created → assign/complete) | Fan-in from 4 PMS providers + iCal all converge on `turnover/created` |
| Work Orders | Up to 5 hops (created → dispatch → invoice → paid) | One route (`work-orders/[token]/complete`) fires 3 separate event chains at once |
| Integrations | 2-3 hops per provider | 3 independent trigger paths (cron + webhook + manual) converge on one incremental-sync handler for OwnerRez |
| Guidebook | 2 hops | Stripe is the origin for 5 of its 7 events |
| Billing | 1 hop | All 3 billing events fully wired — `billing/subscription-updated` is the one exception, see below |
| Standalone crons | 0 hops | 17 crons never touch the event graph — pure scheduled sweeps |

### Resolved: the 7 originally-unmatched events

A follow-up pass (grepping `.tsx` function files too, which the first
pass's Glob excluded, plus a full-text search for each event's data
across the repo) resolved all 7:

**Wired all along — Pass 2's original doc was wrong:**
- `billing/trial-lifecycle-start` → `lib/inngest/functions/email-trial-lifecycle.tsx`
- `user/onboarding.drip.started` → `lib/inngest/functions/onboarding-drip.tsx` (registered in `app/api/inngest/route.ts`)

**Confirmed dead — defined in `events.ts`, never sent, never consumed anywhere in `.ts`/`.tsx`:**
- `maintenance/daily-check` — no trace outside its own type definition.
- `repuguard/activated` — `organizations.repuguard_status` is written directly by the Stripe webhook (`app/api/webhooks/stripe/route.ts`); nothing ever emits or listens for this event.
- `inventory/below-par` — the automation this name implies is real, it just doesn't go through this event: `inventory-events.ts`'s `inventory/count-submitted` handler computes below-par items in-memory and creates the draft PO directly in the same step. This event type was superseded, not wired to anything.
- `vendor-compliance/expiry-warning` — compliance expiry is surfaced instead via a pull-based in-app notification bell (`lib/notifications.ts` queries the `vendor_compliance_status` view on page load for `hard_blocked`/`expiring_soon`/`grace_period` rows). No proactive email/SMS push exists for this — a PM only sees it if they open the dashboard.

**Sent but genuinely orphaned — real gap, not a false positive:**
- `billing/subscription-updated` — `app/api/webhooks/stripe/route.ts` sends this on every `customer.subscription.created/updated`, but no function anywhere subscribes to it. Not a functional break: `organizations.plan`/`plan_status`/`max_properties` are updated synchronously in the same webhook handler, before the send. But the event itself reaches no listener — it looks like a hook for a planned "notify PM their plan changed" email that was never built.
