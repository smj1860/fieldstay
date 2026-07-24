# FieldStay Operational Audit — 2026-06-25

**Scope:** Seven-agent parallel audit covering Data Isolation & Privacy
Compliance, Offline Cache Sanitization, Inngest Step Failure Handling,
Serverless Timeout Risk, Scalability, Idempotency, and Efficiency (stuck
loops, batching, indexed tables). Read-only — no code was modified during
this audit. Findings only; remediation is intentionally not included in this
report.

## Summary

| Area | Findings |
|---|---|
| 1. Data Isolation & Privacy Compliance | 4 |
| 2. Offline Cache Sanitization | 9 |
| 3. Inngest Step Failure | 15 |
| 4. Serverless Timeout Check | 7 |
| 5. Scalability | 13 |
| 6. Idempotency | 8 |
| 7. Efficiency (loops/batching/indexes) | 13 |

---

## 1. Data Isolation & Privacy Compliance

**Cross-org repoint of `integration_connections` on reconnect** — `app/(dashboard)/settings/integrations/actions.ts:130-134` — *High*
`connectWithApiKey` updates a connection filtered only by `user_id` + `provider_id`, with no `org_id` in the `WHERE` clause. A user belonging to two orgs who reconnects an integration while acting in Org B can silently repoint Org A's existing PMS connection to Org B, since the underlying Vault token functions have no org concept at all.

**Vendor quote-portal GET endpoint never checks token expiry** — `app/api/work-orders/[token]/quote/route.ts:5-36` — *Medium* — **FIXED**
The GET handler returns work order title, description, cost, and property location based purely on token validity, with no expiry check — unlike its own POST handler and the sibling `complete/route.ts` GET handler, both of which do check expiry. An expired quote link discloses this data indefinitely.
**Status: FIXED.** `app/api/work-orders/[token]/quote/route.ts:48-49,86-88` — both
the GET and POST handlers now check `quote_token_expires_at`.

**Vault token RPC grants are unverifiable from version control** — referenced in `supabase/migrations/20260612000004_fix_refresh_token_function_grants.sql:1-5` — *Medium*
The base `store/read/revoke_integration_token` functions are claimed to be service-role-only, but no migration anywhere grants/revokes privileges on them — they predate migration tracking. This is the most sensitive code path in the app (decrypting OAuth tokens), and its access-control state currently rests on an unverifiable comment rather than a checked-in grant.

**Hostaway token-exchange error logs raw provider response body** — `lib/integrations/providers/hostaway.ts:106-109`, consumed in `app/(dashboard)/settings/integrations/actions.ts:153-155` — *Low*
Up to 200 chars of Hostaway's raw HTTP error response is embedded in a thrown error and logged server-side. It's never returned to the client, but if Hostaway ever echoes submitted credentials in error bodies, those would land in server logs.

*(Confirmed clean, not findings: `oauth_states` RLS-with-no-policies is intentional and correctly default-deny; previously-known RLS SELECT-policy gaps on `org_master_*`/`owner_transactions` are already remediated; GDPR export/delete flows are correctly scoped to the requesting user; no `.from('memberships')` references exist in source.)*

---

## 2. Offline Cache Sanitization

**`closeDexieDb()` never deletes the IndexedDB database on logout** — `lib/dexie/schema.ts:231-237`, called from `app/crew/crew-shell.tsx:56-61` — *Critical* — **FIXED**
Logout only closes the Dexie connection; it never calls `Dexie.delete()`. Every cached turnover, property address, checklist note, and message a crew member ever synced remains readable in IndexedDB after sign-out, on a device that may be shared or eventually lost.
**Status: FIXED.** `lib/dexie/schema.ts:312-323` — `closeDexieDb()` now calls
`Dexie.delete(dbName)` after closing the connection.

**Photo blob store is a single shared, non-namespaced IndexedDB database across all users** — `lib/dexie/photo-queue.ts:7-9` — *High* — **FIXED**
Unlike the main Dexie DB (namespaced per `userId`), the raw photo-blob store always opens the same fixed database name regardless of who's logged in. A second crew member logging into the same device before the first user's queued photos finish syncing can read or upload the first user's queued blobs.
**Status: FIXED.** `lib/dexie/photo-queue.ts:7-15` — the store is now namespaced
per-userId (`fieldstay-photo-queue-${userId}`).

**No retry cap on the mutation outbox — failed mutations and their payloads accumulate indefinitely** — `lib/dexie/syncService.ts:21-46, 145-176` — *High* — **FIXED**
`processOutbox()` increments a retry count that's never checked against any ceiling, and breaks on first failure. A single permanently-failing mutation keeps its full payload (notes, descriptions, counts) resident in IndexedDB forever and stalls every mutation queued after it.
**Status: FIXED.** `lib/dexie/syncService.ts:41-67` implements `MAX_RETRIES = 5`
— a mutation exceeding the cap is marked `failed` (dead-lettered) instead of
blocking the queue forever; the drain now `continue`s past permanently-failing
mutations retried 3+ times rather than breaking on every failure.

**`getDexieDb()` singleton can race across a user switch within one tab session** — `lib/dexie/schema.ts:219-229` — *Medium*
The previous Dexie instance is closed but not invalidated everywhere it's referenced — an in-flight `useLiveQuery` or background sync call captured before a user switch can continue operating against the closed connection or race the new instance during handoff.

**No encryption-at-rest or storage lifecycle anywhere in the Dexie layer** — general, `lib/dexie/*` — *Medium*
None of the Dexie files apply client-side encryption, TTL, or quota caps. Combined with the logout and photo-store findings above, property photos, checklist timestamps, and message content sit as plaintext in IndexedDB for as long as the browser profile exists on the device.

**`properties` Dexie table is read with no per-assignment scoping at the read site** — `app/crew/page.tsx:165` — *Low*
The dashboard reads the entire local `properties` table rather than deriving it from the crew member's own turnover assignments. Currently safe because the only writer of this table already scopes by assignment, but the read path itself enforces no boundary.

**Photo sync silently drops unrecognized upload targets without cleaning up the orphaned blob** — `lib/dexie/photo-sync.ts:40-44` — *Low*
If a queued photo fails an allowlist check, the queue row is deleted but the underlying blob in the photo store is never removed, leaving it orphaned in IndexedDB with no way for the crew member to know the upload never happened.

**`turnover.notes` is cached client-side with no redaction** — `lib/dexie/schema.ts:16`, rendered at `app/crew/turnovers/[id]/page.tsx:268-272` — *Low*
PM-authored free-text notes (which can contain guest names, access codes, or owner remarks) are pulled verbatim into the crew device's local cache with no sanitization layer.

**Checklist sync pulls `crew_notes` from all crew on an assignment, not just the requesting crew member** — `lib/dexie/context.tsx:158-176` — *Low*
The checklist item query has no filter on which crew member authored the note. For multi-person turnovers, every assigned crew member's device would cache every other crew member's free-text notes for that checklist.

---

## 3. Inngest Step Failure Handling

**OwnerRez initial sync swallows all sync failures as a successful run** — `lib/inngest/functions/ownerrez/initial-sync.ts` (~lines 59-500) — *Critical*
Any error from any of the sync steps is caught at the function-body level and the function returns normally, so Inngest records the run as successful and never retries — even though the org's sync completely failed.

**Compliance-alert dedup write happens before the email send, permanently dropping alerts on a failed send** — `lib/inngest/functions/cron/asset-health.ts` (~lines 334-396) — *Critical*
The dedup milestone is recorded before `resend.emails.send()` is called, with a comment claiming this prevents double-sends on retry. The actual effect is the opposite: if the send throws, Inngest retries the step, but the retry's own dedup check now finds the milestone already recorded and skips sending — the alert is lost.

**iCal feed download failure converted into a "successful" function result** — `lib/inngest/functions/ical-sync.ts` (~lines 140-163) — *High*
A transient fetch failure marks status as error and returns `{ success: false }` instead of re-throwing, consuming the run with no retry even though `retries: 2` is configured.

**`ownerrez-reviews-sync` has no `retries` configured and swallows non-specific fetch errors per connection** — `lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts` (lines 8-12, 48-129) — *High*
This is the only sync function that omits `retries` entirely. Any error other than rate-limit or token-revocation is logged and the loop just continues to the next connection — that connection's reviews are silently skipped with no retry.

**Nested `step.sendEvent` inside `step.run` in work-order dispatch** — `lib/inngest/functions/work-order-events.ts` (lines 23-97, nested event at line 76) — *High*
This is the exact anti-pattern the codebase's own `ownerrez/incremental-sync.ts` comments warn against elsewhere. A retry of this step (e.g., a later DB update failing) regenerates a fresh token and can re-send the dispatch event, potentially double-dispatching or invalidating an already-delivered vendor link.

**No `onFailure`/dead-letter handling configured anywhere** — `lib/inngest/client.ts`, `app/api/inngest/route.ts` — *High*
After a function exhausts its retries, there is no notification or audit trail — the failure exists only in Inngest's own dashboard. Combined with the swallowed-failure findings above, a meaningful share of integration-sync failures could go completely unnoticed.

**Raw `inngest.send()` used inside `step.run` instead of `step.sendEvent`, three times in one function** — `lib/inngest/functions/cron/work-order-ops.ts` lines 107, 174, 276 — *Medium*
Because the send isn't part of step memoization, a retry of the containing step (triggered by a later failure in the same step) can re-send the event, potentially double-escalating a work order or double-firing an auto-create event.

**Upsert loop runs entirely outside any `step.run`** — `lib/inngest/functions/cron/checklist-signals.ts` (lines 112-120) — *Medium*
The chunked write loop that persists signal scores isn't memoized as a step. A mid-loop failure forces Inngest to retry the entire function from scratch, including the earlier read step's work, rather than resuming from the failed chunk.

**No `NonRetriableError` usage anywhere in the codebase** — systemic — *Medium*
Permanent/business-logic failures (vendor has no email, token revoked, entity not found) are universally handled via silent early-return rather than a distinguishable non-retriable error, so Inngest's own failure tracking can't tell "succeeded" apart from "gave up because the situation is unfixable."

**`repuguardBatchGenerate` treats transient and permanent per-review failures identically** — `lib/inngest/functions/repuguard-batch-generate.ts` (`retries: 1`, lines 47-97) — *Medium*
A rate-limit or timeout calling the LLM for one review is marked "skipped" in the same code path as a genuinely permanent failure, with no step-level retry for the transient case.

**`flaggedTurnoverToWO` has no `retries` key configured** — `lib/inngest/functions/flagged-turnover-wo.ts` (lines 4-8) — *Low*
This and `ownerrez-reviews-sync` are the only two functions in the codebase that omit an explicit retry count, leaving behavior to Inngest's default.

**Inconsistent retry counts with no apparent risk-based policy** — systemic, e.g. `cron/audit-retention.ts`, `cron/comms-retention.ts`, `cron/checklist-signals.ts` (`retries: 1`) vs. `booking-events.ts` (`retries: 3`) — *Low*
Functions doing more DB work across more rows get fewer retries than simpler single-record functions, suggesting retry budgets weren't chosen deliberately per function risk.

**`geocodingBackfill` loops over an unbounded record set inside a single low-retry step** — `lib/inngest/functions/geocoding-backfill.ts` — *Low*
A late failure deep into a large batch forces redoing all prior successful geocodes on retry, and the function only gets one retry at the function level.

**Notification functions silently no-op when a PM's email can't be resolved** — `lib/inngest/functions/work-order-events.ts` lines 219-222, 282, 405 — *Low*
When `getPmEmail()` returns null, these functions return successfully with no notification sent and nothing surfaced anywhere — an org with a misconfigured PM membership would silently never get WO completion/overdue/quote alerts.

**Checklist broadcast's delete-then-insert sequence per property isn't transactional** — `lib/inngest/functions/checklist-broadcast.ts` (~lines 49-82) — *Low*
If the step is retried mid-sequence (delete succeeded, inserts partially completed), there's no explicit guard against a briefly half-written checklist state being visible to a reader.

---

## 4. Serverless Timeout Check

**`applyMasterChecklistToProperties` runs ~9 sequential DB round trips per property, synchronously, for up to 50 properties** — `app/(dashboard)/setup/checklist-template/actions.ts:40-65`, `lib/checklists/apply-master-template.ts:20-132` — *High*
At the high end of target scale this is roughly 400-450 sequential awaited Supabase calls inside one request, with no Inngest offload and no `maxDuration` override — unlike its sibling features (checklist broadcast, maintenance template broadcast), which correctly delegate the same kind of portfolio-wide fan-out to Inngest.

**`assignCrewIndividually` performs one full sequential assignment flow per distinct crew member in a bulk submission** — `app/(dashboard)/turnovers/actions.ts:150-170` — *Medium*
A PM bulk-assigning many turnovers across 15-20 distinct crew members triggers that many sequential passes of ~5 awaited calls plus an Inngest send each, with no parallelization across crew members.

**RFQ/quote-request fan-out loops do sequential insert + Inngest send per vendor** — `app/(dashboard)/maintenance/actions.ts:103-133, 603-635` — *Low-Medium*
Vendor-selection lists are realistically bounded, so this is unlikely to itself cause a timeout, but it's the same sequential-await-in-a-loop shape at a smaller multiplier.

**`assignment_outcomes` upsert loops on suggestion accept/dismiss** — `app/(dashboard)/turnovers/actions.ts:581-586, 632-637` — *Low*
Loops over suggested crew (realistically 1-3 items) doing per-crew upserts instead of one batched call — bounded and fast today, flagged only as the same pattern at a smaller scale.

**`scan-data-plate` route's 30s `maxDuration` is tighter than the 60s given to a comparable LLM-backed route** — `app/api/assets/scan-data-plate/route.ts:59-102` vs. `app/api/repuguard/generate/route.ts` — *Low*
The vision-based call (often slower than text-only calls, especially with larger images) has a shorter timeout budget than a comparable text-only LLM call elsewhere in the app.

**`account/delete` loops sequentially over memberships and integration connections, each calling Stripe/Vault** — `app/api/account/delete/route.ts:41-101` — *Low*
Realistically bounded (a user belongs to 1-2 orgs with a handful of connections), but this is unparallelized external-API-call-in-a-loop code with no explicit `maxDuration` override.

**`geocoding-backfill`'s per-item loop is correctly an Inngest function, not a route handler, but processes an unbounded set inside one step** — `lib/inngest/functions/geocoding-backfill.ts:42-56, 75-89` — *Low*
Not subject to Vercel's serverless timeout, but a very large backfill batch retries from scratch on failure since it isn't chunked into separate steps.

*(Confirmed clean: no routes anywhere opt into Edge runtime; both webhook handlers verify signatures and offload heavy work to Inngest before responding; CapEx CSV/GDPR export/CPA PDF export routes are all reasonably bounded by pre-computation, parallelized reads, or row caps.)*

---

## 5. Scalability

**Owner P&L page: full-history fetch with in-JS aggregation, no pagination** — `app/(dashboard)/owners/page.tsx:44-48`, `owners-manager.tsx:392-394` — *High*
Every `owner_transactions` row ever inserted for the org is fetched with no date range or limit, and totals are computed via `.reduce()` in the browser rather than a Postgres aggregate — this grows strictly with org history.

**Maintenance board: unbounded `work_orders` fetch with nested joins, no status/date filter** — `app/(dashboard)/maintenance/page.tsx:20-41` — *High*
Every work order regardless of status, including years of completed/cancelled history, is fetched with a nested line-items join and no limit — the largest unfiltered fetch found in the dashboard.

**Dexie crew PWA messages synced with no date bound or limit** — `lib/dexie/context.tsx:184-192` — *High*
Every message where the user is sender or recipient is fetched and bulk-written to IndexedDB on every mount/reconnect with no limit — this grows with account tenure, not org size, directly cutting against the "recent/active only" local-first design intent used elsewhere.

**CapEx projections cron loops sequentially over every org platform-wide within one function run** — `lib/inngest/functions/capex-projections.ts:47-56` — *High*
Inngest steps execute serially within a single run; at hundreds/thousands of orgs this monthly invocation's wall-clock time grows linearly with total platform org count, not any individual org's data size.

**Vacancy-gap maintenance suggestions: N+1 booking queries inside a platform-wide property loop** — `lib/inngest/functions/cron/maintenance-schedules.ts:368-422` — *Medium*
Every active property across the entire platform is fetched (no org filter), then one bookings query runs per property and one more per detected gap — a classic N+1 where N is the total active property count platform-wide.

**Inventory page: duplicate fetch of the same table, one with `select('*')`, no limit** — `app/(dashboard)/inventory/page.tsx:28-33, 57-63` — *Medium*
The same table is queried twice per page load, neither with a limit, for what could be thousands of rows across 10-50 properties.

**Depreciation ledger and comms-retention crons: same sequential per-org pattern** — `lib/inngest/functions/depreciation-ledger.ts:38-47,77-85`, `cron/comms-retention.ts:21-59` — *Medium*
Both load data for all orgs in one query then loop a step per org sequentially — annual/daily cadence makes these lower urgency than the CapEx cron, but the same scaling ceiling applies.

**Missing composite index: `work_orders (org_id, status)`** — schema vs. `maintenance/page.tsx:40-41`, `ops/page.tsx:46-47`, `cron/work-order-ops.ts:32-37` — *Medium*
Only single-column indexes exist on `org_id` and `status` separately, despite every hot-path query filtering on both together.

**Missing composite index: `owner_transactions (org_id, transaction_date)`** — schema vs. `owners/page.tsx:44-48` — *Medium*
The owners page filters by org and sorts by transaction date together, but no index covers both columns as a pair.

**Comms-log and audit-log pages cap row count but have no real pagination** — `comms-log/page.tsx:17-30`, `settings/audit/page.tsx:13-18` — *Low*
Hard caps (500/200 rows) prevent a performance cliff, but once an org exceeds the cap, older history becomes permanently unreachable in the UI with no way to page back.

**Missing composite index: `turnovers (org_id, status, checkout_datetime)`** — schema vs. `turnovers/page.tsx:39-43`, `ops/page.tsx:31-35` — *Low*
Lower severity than the work_orders case because these queries are already date-windowed, capping the worst case regardless of index shape.

**Missing composite index: `bookings (org_id, checkin/checkout date)`** — schema vs. multiple dashboard pages and the maintenance-schedules cron — *Medium*
Every booking-window query filters org plus a date range together, but only single-column indexes exist.

**Missing composite index: `audit_events (org_id, created_at)`** — schema vs. `settings/audit/page.tsx:14-18` — *Low*
Bounded today by a 200-row limit, but the same composite-index gap as the other high-volume tables.

---

## 6. Idempotency

**Route Handler for crew issue reports doesn't catch the unique-constraint violation its sibling Server Action does** — `app/api/crew/issue-reports/route.ts:43-68` vs. `app/crew/turnovers/actions.ts:47-64` — *Medium*
Both insert into `work_orders` backstopped by the same unique constraint, but the Server Action explicitly treats a constraint violation as a success no-op while the Route Handler relies only on an app-level time-window check and falls into a generic 500 on a genuine constraint hit — which the Dexie outbox will then retry indefinitely against an endpoint that keeps failing the same way.

**Shared `[provider]` webhook route's replay-dedup logic is hardcoded to OwnerRez only** — `app/api/webhooks/[provider]/route.ts` — *Medium*
Any other provider routed through this same catch-all gets no ledger-based replay protection from this layer. Currently latent because Hostaway's webhook validation unconditionally fails and Kroger has no webhooks, but the gap becomes live the moment another provider's webhook support is wired up.

**`work_orders` insert error from maintenance-schedule cron is destructured but never checked** — `lib/inngest/functions/cron/maintenance-schedules.ts:135-154, 316-335` — *Low*
A DB-level unique constraint prevents an actual duplicate WO, but because the insert's error field is never inspected, a genuine constraint hit on a race silently skips the downstream PM email/vendor event with no error logged — a real failure looks identical to "nothing was due."

**Inconsistent existing-WO matching logic between two cron code paths creating WOs from the same source table** — `cron/maintenance-schedules.ts:127-133, 308-314` vs. equivalent logic in `cron/work-order-ops.ts` — *Low*
The DB unique constraint is the real backstop, but the two code paths' "does a WO already exist" checks use different scoping, which could cause confusing insert-rejected-by-Postgres behavior rather than a clean shared check.

**`addCrewToTurnover` uses check-then-insert with no explicit duplicate-violation handling** — `app/(dashboard)/turnovers/actions.ts:369-388` — *Low*
A DB unique constraint prevents an actual duplicate assignment row, but a concurrent double-click would surface as an unhandled 500 rather than the graceful no-op pattern used elsewhere in the same file.

**Booking-cancellation reversal posting has no explicit duplicate-violation handling** — `app/(dashboard)/bookings/actions.ts` (`cancelBooking`) — *Low*
Backstopped by the general `owner_transactions` unique constraint, but without an explicit catch a race surfaces as an unhandled DB error rather than a clean idempotent no-op.

**`communication_logs` dedup key has no DB-level backstop at all** — `lib/inngest/functions/log-message-comm.ts:38-67` — *Low*
The check-then-insert dedup is pure application-level with no supporting unique index — unlike every other finding in this report, there's no constraint catching a race if the app-level check fails. Impact is low since this is an append-only log never used for billing decisions.

**Hostaway webhook dedup is a latent gap, same root cause as the shared-route finding above** — `lib/integrations/providers/hostaway.ts:1-30` — *Low*
Hostaway's own sync functions are well-guarded, but webhook validation currently always fails, so there's no dedup ledger in place for the day webhook support is actually implemented.

*(Confirmed well-guarded: all four `owner_transactions` posting paths — cleaning fees, WO completion, inventory purchases, booking revenue — consistently use either an upsert with `onConflict`/`ignoreDuplicates` or an explicit pre-check, backstopped by a DB unique constraint; the Stripe webhook handler verifies signature before an insert-then-catch dedup check; OwnerRez webhook + all three OwnerRez sync functions, iCal sync, and the turnover generator are all double-layered with both in-memory checks and explicit constraint-violation handling — the turnover generator in particular is the most defensively written code path found in the audit. No Uplisting sync code exists yet, so the `uplisting_booking` source value currently has no live duplicate-creation risk.)*

---

## 7. Efficiency — Stuck Loops, Batching, Indexed Tables

### Stuck/Infinite Loop Risk

**Mutation outbox drain has no max-retry cap, and blocks the entire queue on first failure** — `lib/dexie/syncService.ts:21-46` — *Critical* — **FIXED**
A retry count is tracked but never checked against any threshold, and the drain loop stops at the first failure so nothing after it in the queue is processed either. Every subsequent `enqueueMutation()` call re-triggers a drain that hits the same permanently-failing mutation first every time.
**Status: FIXED.** `lib/dexie/syncService.ts:41-67` implements `MAX_RETRIES = 5`
with dead-lettering past the cap, and the drain now skips (rather than blocks on)
mutations already retried 3+ times.

**OwnerRez pagination loop has no max-page cap** — `lib/integrations/providers/ownerrez-api.ts:190-208` — *High*
The loop trusts the upstream "next page token" to eventually become falsy with no iteration counter, on a 15-minute cron cadence — a cycling or buggy token would loop indefinitely inside a single Inngest step.

**Hostaway listing/reservation pagination loops have no max-page cap** — `lib/integrations/providers/hostaway.ts:142-159, 179-202` — *High*
Both are bounded only by the API returning a less-than-full page; an off-by-one in the provider's own offset handling would loop with no escape hatch.

### Batching Opportunities

**Vacancy-gap maintenance query runs as an N+1 on every Bookings page render, not just in the daily cron** — `app/(dashboard)/bookings/page.tsx:27-50` — *High*
The same per-property, per-gap query pattern found in the cron version also runs synchronously on every dashboard page load, making it more severe than its cron counterpart since it's on a user-facing request path.

**Work-order aging-escalation and auto-WO-creation loops issue one Inngest step, one DB write, and one email per row** — `lib/inngest/functions/cron/work-order-ops.ts:89-136, 214-310` — *Medium*
PM email lookups are correctly pre-batched ahead of the loop, but the per-row writes and sends inside it are not, so a run with many overdue WOs does proportionally many sequential round trips.

**Maintenance-schedule cron repeats the same one-row-at-a-time pattern across three passes** — `lib/inngest/functions/cron/maintenance-schedules.ts:94-232, 238-358, 434-463` — *Medium*
Same shape as the work-order-ops finding: email lookups are batched ahead of time, but each schedule/property still gets its own individual WO insert/update and individual email send inside the loop.

**Geocoding backfill never deduplicates by zip code** — `lib/inngest/functions/geocoding-backfill.ts:42-56, 75-89` — *Medium*
Properties/vendors sharing the same zip are each geocoded independently with a 200ms sleep between every single call, rather than resolving each unique zip once.

**`notify-assignment-gap` sends one email per manager rather than one batched send** — `lib/inngest/functions/notify-assignment-gap.ts:33-76` — *Low*
Each manager gets an individual Inngest step and email send for identical content; the underlying query also has no limit on how many managers it could return.

### Indexed Table Usage

**`turnovers` has no composite index matching its actual hot-path query shape** — schema vs. `turnovers/page.tsx:27-43`, `ops/page.tsx:23-35` — *High*
Three separate single-column indexes exist (org_id, status, checkout_datetime) but every dashboard query filters and sorts on all three together — Postgres can use at most one index per scan here.

**`work_orders` has no composite index covering `org_id` + `status`** — schema vs. `cron/work-order-ops.ts:32-37`, `ops/page.tsx:43-49`, `comms-log/page.tsx:53-59` — *High*
Same gap as turnovers, on the table CLAUDE.md itself identifies as one of the highest-volume tables in the schema; one query site filters by status across all orgs with no org_id filter at all.

**`bookings` has no composite index covering `org_id` + date range** — schema vs. multiple dashboard pages and the maintenance-schedules cron — *Medium*
Every booking-window query filters both together, but indexes only exist on each column separately.

**`communication_logs` sort column doesn't match its existing composite index** — schema vs. `comms-log/page.tsx:18-30` — *Medium*
The one composite index that exists was built for the retention cron's `created_at` filter; the comms-log page itself sorts on a different timestamp column entirely, so neither index lines up with the page's actual query.

**`audit_events` lacks a composite index, though currently low-impact** — schema vs. `settings/audit/page.tsx:14-18` — *Low*
Same single-column-only pattern as the other tables above, but bounded today by a 200-row cap and a server-side retention function rather than an app-level filtered query.
