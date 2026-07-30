# FieldStay Pre-Launch Audit — 2026-07-30

**Scope:** Full-repo pre-launch audit covering multi-tenant security, data-layer
correctness, and scalability from the first customer to 150+ tenants.
**Method:** Six specialized auditors run in parallel, one per dimension, each
reading code directly and tracing data flows end to end. Findings below were
verified against source, against the live Supabase project
`vpmznjktllhmmbfnxuvk` (RLS policies, grants, FK constraints, view definitions),
and — for the toolchain dimension — by actually running the repo's own checks.
No files were modified during the audit.

## Verdict: **NOT LAUNCH-READY**

Four defects must be fixed before onboarding tenant #1. Two are confirmed
cross-tenant data exposure. One is already causing GDPR-relevant data retention
in production today. One silently corrupts crew-completed work.

The engineering baseline is genuinely strong — `tsc --noEmit` clean, zero lint
errors, 2,249 unit tests and 90 guardrail assertions passing and truly
CI-gated, mature Sentry wiring, and a structural-enforcement system that works.
The pattern across almost every finding is **drift, not absence**: in nearly
every case the correct implementation already exists somewhere in the repo and
the defect is a second call site that didn't use it.

| Dimension | Verdict | Crit | High | Med | Low |
|---|---|---|---|---|---|
| 1–2. RLS, GRANTs, tenant isolation | Not ready | 2 | 2 | 5 | 7 |
| 3. Dexie offline-sync | Not ready | 3 | 3 | 6 | 4 |
| 4. Scalability to 150+ tenants | Not ready | 3 | 4 | 7 | 3 |
| 5. Rate limiting & entry points | Conditional go | 0 | 1 | 7 | 7 |
| 6. Data-layer correctness | Not ready | 1 | 4 | 7 | 7 |
| 7. Complexity & silent failures | Blocking | 1 | 3 | 5 | 2 |
| **Total** | | **10** | **17** | **37** | **30** |

---

## Launch blockers

### B1 — Any authenticated user can make themselves `owner` of any org
`supabase/migrations/20260617060719_fix_auth_rls_initplan.sql:181-185`
(live policy `organization_members.org_members_insert_self`)

`WITH CHECK (user_id = auth.uid())` constrains **only** `user_id`. `org_id`,
`role`, and `invite_accepted_at` are all client-supplied, all INSERT-grantable
to `authenticated` (verified via `has_column_privilege`), with no BEFORE-INSERT
trigger and no overriding default.

The exploit requires no guessing. A **crew** user reads their own `crew_members`
row (permitted by the `user_id = auth.uid()` branch of `crew_members_select`) to
learn `org_id`, holds no `organization_members` row so `UNIQUE(org_id, user_id)`
does not block them, and POSTs directly to `/rest/v1/organization_members`:

```json
{ "org_id": "…", "user_id": "<self>", "role": "owner", "invite_accepted_at": "now()" }
```

`get_user_org_ids()` and `is_org_member()` both gate on
`invite_accepted_at IS NOT NULL` — which the attacker sets in the same INSERT.
Result: full read/write over the entire tenant, including guest PII in
`bookings` and all financials. Any user holding any org UUID can do this to that
org.

**Fix:** `DROP POLICY org_members_insert_self`. It is dead code — the app's only
membership insert is the service client at `lib/auth/invites.ts:46`, and org
creation goes through the `create_organization_with_owner` RPC
(`app/onboarding/actions.ts:39`).

### B2 — `compliance-documents` storage policies are bucket-wide, not org-scoped
Live `storage.objects` policies `compliance_docs_select` / `_insert` / `_delete`

All three qualify on `bucket_id = 'compliance-documents'` and nothing else. Any
authenticated user of any tenant can list, download, overwrite, and **delete**
every org's vendor COIs, W-9s, contractor licenses, and bonding certificates.
Objects are already written under an `${orgId}/${vendorId}/` prefix
(`app/(dashboard)/vendors/[id]/compliance-section.tsx:62-66`), so the scoping
data exists and is simply unused.

**These three policies exist only in the live DB — no migration defines them.**
`grep compliance_docs_insert supabase/` returns nothing. They are untracked
dashboard drift, invisible to code review and to the `db-invariants` CI job,
which inspects the `public` schema only.

**Fix:** add a migration replacing all three with
`(storage.foldername(name))[1]::uuid IN (SELECT get_user_org_ids())` for SELECT
and `is_org_member(…, ARRAY['admin','manager'])` for INSERT/DELETE — mirroring
`20260726120000_guidebook_property_photos_storage_policies.sql`, which is the
correct pattern already in the repo. Extend `public.db_invariant_report()` to
cover `storage` policies.

### B3 — Account deletion orphans the entire org, including guest PII
`app/api/account/delete/route.ts:136-141`

```ts
// Delete the auth user (cascades to org data via DB foreign keys)
const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
```

The comment is factually wrong. There is **no FK from `organizations` to
`auth.users`** — the only FKs on `organizations` point at `room_templates`.
Deleting the auth user cascades `organization_members.user_id` and `profiles.id`
and nothing else. The `organizations` row and every org-scoped table survive:
`properties`, `bookings` (incl. `guest_name`/`guest_email`),
`owner_transactions`, `work_orders`, `guidebook_guest_sms_optins`,
`communication_logs`. The org becomes unreachable by RLS and is therefore never
purged, never audited, never seen again.

**This has already happened in production.** Live query against orgs with zero
`organization_members`:

| orphan orgs | orphan properties | orphan bookings | orphan bookings with guest PII |
|---|---|---|---|
| 2 | 10 | 20 | **20** |

Twenty real guest name/email records are retained indefinitely with no owner and
no deletion mechanism, on the endpoint whose entire purpose is erasure. RLS
invisibility is not erasure — this is a GDPR Art. 17 failure.

**Fix:** in the owner branch, explicitly delete the `organizations` row before
`deleteUser`; the existing `ON DELETE CASCADE` from every org-scoped table then
does the real work. Backfill-delete the two existing orphans. Add a
`db-invariants` assertion that no `organizations` row has zero members.

The same route has three more discarded-error defects on the same destructive
path (see H4).

### B4 — Crew offline work is silently destroyed after ~75 seconds without signal
`lib/dexie/syncService.ts:7,104-117` + `app/crew/crew-shell.tsx:206-212`

`crew-shell` runs `processOutbox()` on a 30s `setInterval` with **no
`navigator.onLine` gate**, and `SyncEngine` has no connectivity check either.
Offline, every attempt throws, `retryCount` climbs the backoff schedule
(5s→10s→20s→40s), hits `MAX_RETRIES = 5` after roughly 75 seconds, and the
mutation is marked `failed: true` — permanently excluded from the drain, since
`processOutbox` filters `!m.failed` (line 78).

This is precisely the scenario the PWA exists for. Two companion defects make it
worse:

- **Queued photos are destroyed after ~2.5 minutes offline**
  (`lib/dexie/photo-sync.ts:14,37,68-71`). Same root cause, no backoff at all,
  no failure UI, and `retry_count` is never reset anywhere. The checklist item
  was already marked complete (`use-turnover-actions.ts:235`), so the PM sees a
  photo-required item with no photo and no error.
- **Every photo upload NULLs `completed_at`** on its checklist item
  (`lib/dexie/syncService.ts:159-162`). `photo-sync` enqueues only
  `photo_storage_path`, but `uploadChecklistInstanceItem` writes
  `completed_at: payload.completed_at ?? null` unconditionally — an explicit
  NULL on an item that is still `is_completed = true`, corrupting the duration
  data that `assignment_outcomes` and crew scoring depend on.

**Fix:** gate on `navigator.onLine` and don't count an offline attempt as a
retry; add backoff + a `failed` surface to photo sync; make
`is_completed`/`completed_at` conditional on `'is_completed' in payload`.

---

## Critical / High by dimension

### RLS, GRANTs, and tenant isolation

Beyond B1 and B2:

- **H1 — Nine tables have RLS policies but no `authenticated` GRANT**, so every
  RLS-client read fails silently (Postgres checks the grant before RLS ever
  evaluates). Verified via `has_table_privilege`: `notifications`,
  `notification_digest_state`, `hospitable_launch_promo`, `crew_feedback`,
  `stay_extension_requests`, `guidebook_offer_redemptions`,
  `vendor_assignment_outcomes`, `checklist_item_signals`,
  `guidebook_guest_sms_optins`. Three are live features that are consequently
  **dark in production** — most notably the entire notification bell
  (`lib/notifications.ts:29-35` reads `notifications` and destructures only
  `{ data }`, discarding the error), a feature that supersedes seven PM email
  categories. This exact class has now shipped twice; add a CI invariant that
  any table with an `authenticated`-facing policy holds the matching GRANT.
- **H2 — `work-order-photos` and `turnover-photos` have no storage policies at
  all** but are written from the browser, so every client upload is denied.
  `CreateWorkOrderModal.tsx:104-110` counts failures into a non-blocking toast;
  `lib/turnovers/flag-photo-upload.ts:8` doesn't check the error at all, so crew
  flag photos vanish with zero signal.
- **M — Unpublished guidebook content is serialized to the client**
  (`app/g/[slug]/page.tsx:76-138`): WiFi password, check-in instructions, and
  house rules are passed to a `'use client'` component and readable in the RSC
  flight payload; only the UI early-returns "Coming Soon".
- **M — `notifications` UPDATE is not column-restricted**, so any org member
  (including `viewer`) can rewrite `title`/`href`/`severity` — an in-tenant
  phishing primitive on the PM's own alert feed.

**Verified sound:** all 93 tables have RLS enabled; zero `anon` grants; no
UPDATE/ALL policy missing `WITH CHECK` outside deliberate deny-alls; every
org-scoped table uses `get_user_org_ids()`/`is_org_member()`; crew read-scoping
via `get_crew_turnover_ids()` is consistent; all six service-role Server
Components call `requireOrgMember()` and scope every query by `org_id`.

### Scalability to 150+ tenants

**Systemic root cause:** `supabase/config.toml:18` sets `max_rows = 1000`. Every
unbounded `.select()` returns at most 1000 rows **with no error and no
truncation signal** — silently wrong results, not failures. ~80 unbounded
selects exist in `lib/inngest/functions/**`; the platform-wide ones break at a
predictable tenant count.

- **C — `ical-sync.ts:56-68`**: hourly booking sync, unbounded `ical_feeds`.
  Breaks at roughly **17 tenants**. At 150 tenants ~8,000 of ~9,000 feeds never
  sync, cascading into turnover generation, guest messaging, and revenue
  posting.
- **C — `cron/asset-health.ts:44-53,66-74,125-133`**: ~45,000 assets at scale,
  1,000 scored. Health scores freeze for ~98% of assets; `daily-wrapup` and
  `capital-planning` then read stale values. The step output would also exceed
  Inngest's size limit.
- **C — `cron/metrics-snapshot.ts:36-69`**: three whole-table scans every 30
  minutes (`inventory_items` alone ≈ 500,000 rows at scale). The Sentry gauges
  you would trust during an incident read a flat, meaningless number.
- **H — `cron/work-order-ops.ts:74-268` and `cron/maintenance-schedules.ts:93-311`**:
  platform-wide serial `for … await step.run(...)` loops, ~2–3 steps per row →
  **~2,000+ steps in a single invocation** at 150 tenants, past Inngest's
  ceiling, with O(N²) memoized-state payload growth. Currently masked by the
  very truncation above. Both must become per-org dispatchers, mirroring
  `daily-wrapup.ts:41-51`.
- **H — `build-shopping-cart.ts:76-91`**: a 50-property org's restock cart
  silently omits below-par items past row 1,000 — this one bites your *best*
  customer first.
- **M — `cron/stale-feed-alert.ts:67-76`**: `getPmMembers()` per org, and that
  helper does one `auth.admin.getUserById()` GoTrue round-trip *per member* →
  ~300 sequential external calls inside one step at 150 orgs.
- **M — no request timeouts** on Mapbox (`lib/geocoding.ts:23`, on the
  user-facing property-save path), Tomorrow.io, Telnyx, or Kroger.
- **M — missing composite indexes** for the hot cron filters:
  `work_orders(status, updated_at)`, `turnovers(priority, …)`,
  `turnovers(status, checkout_datetime)` global, `notifications(created_at)`.

**Guardrail gap:** `unit/guardrails/n-plus-one-loops.test.ts` exempts any loop
whose body is a `step.run(...)` boundary — which is exactly what makes the
step-explosion findings invisible to CI. All 20 EXCEPTIONS entries were judged
individually and are genuinely safe; the weakness is the structural exemption,
not the allowlist. Two cheap new guardrails would have caught six of the above:
one banning unbounded `.select()` in `lib/inngest/**`, one banning a
`step.run`-bearing loop over a query with no `org_id`/`.limit()` bound.

### Data-layer correctness

Beyond B3:

- **H — `acceptOrgInvite` discards the membership-insert error and returns
  success anyway** (`lib/auth/invites.ts:45-68`). The caller's rollback
  (`app/accept-invite/[token]/actions.ts:90-94`) therefore never fires. Net
  result: a real auth account, an invite marked accepted, and **no membership
  row** — permanently locked out of the org they were just invited to, with a
  successful audit entry for an acceptance that didn't happen. This is the
  primary team-onboarding path.
- **H — Invite acceptance is load-then-decide-then-write** with an unconditional
  update (`lib/auth/invites.ts:12-18,54-57`); the duplicate is caught only
  incidentally by a UNIQUE constraint whose error is then swallowed by the
  above.
- **H — `vendor_compliance_status` reports uninsured vendors as `compliant`**
  (`20260720170645_…sql:43-61`). The `no_documents` guard counts **all** docs
  unfiltered, while every subsequent branch filters `is_active = true`, and
  `expiry_date` is nullable. A vendor whose only COI is expired-and-deactivated,
  or whose doc has a NULL expiry, falls through to `ELSE 'compliant'`. This view
  is the enforcement boundary for WO assignment. Zero vendors affected today —
  it fires the first time a PM deactivates a document, a normal UI action.
- **H — `isVendorHardBlocked` fails open** (`lib/vendors/compliance.ts:16-23`):
  the error is discarded, so any RLS denial or transient failure returns "not
  blocked." A safety gate must fail closed.
- **M — `owner_transactions.property_id` is `ON DELETE CASCADE`**: deleting a
  property silently erases its entire owner-facing P&L ledger. The tell is the
  inconsistency — `work_order_invoices.property_id` is RESTRICT for the same
  relationship.
- **M — Eight tables carry `org_id` with no FK to `organizations`**, so even
  fixing B3 won't clean them up.
- **M — Kroger cart double-spend** (`build-shopping-cart.ts:349-370`): the
  idempotency flag is keyed on Inngest's `runId`, stable across step retries but
  **not across events**, and the claim is written *after* the irreversible
  external call. A PM double-clicking "Build Cart" adds items to the real cart
  twice. The function declares neither `concurrency` nor `idempotency` — the one
  function that spends real money is the one missing the config that 20+ others
  have.
- **M — `updateTurnoverStatus`** (`app/(dashboard)/turnovers/actions.ts:300-353`)
  uses exactly the race the crew route explicitly rejects and documents
  (`app/api/crew/turnovers/[id]/complete/route.ts:62-83`).
- **M — Three ad-hoc reimplementations of "who is the PM"** bypass
  `getPmMembers()`, the documented single source of truth. All three use
  `.limit(1)` with **no ORDER BY**, so the human presented to a vendor as the
  dispatcher is nondeterministic; a fourth omits the `invite_accepted_at` filter
  — the drift class CLAUDE.md flags as having shipped three times already.
- **M — `stripe-connect` webhook never releases its dedup claim** on a handler
  throw (`app/api/webhooks/stripe-connect/route.ts:40-116`), so Stripe's retry
  hits the `23505` branch and the event is permanently discarded. The main
  Stripe route fixed this and its comment says it mirrors the provider route —
  this third route was missed in that sweep.

**Verified sound:** the WO number counter is a textbook atomic
`INSERT … ON CONFLICT DO UPDATE … RETURNING`; the main Stripe webhook's
dedup-claim-with-release is better than most production code; the crew
completion route's conditional UPDATE is exactly right; `createPmNotification`
handles `23505`/`23503` deliberately; the `owner_transactions`
`(source_reference_id, source)` unique index is real and every posting path
upserts against it; iCal ingest upserts on `(ical_feed_id, ical_uid)`.

### Rate limiting and entry points — *conditional go*

The best-defended surface in the codebase. All four webhook providers verify
signatures with timing-safe comparison before parsing, tokens are 122-bit UUIDs
or 256-bit hex, and `unit/guardrails/public-route-rate-limiting.test.ts`
mechanically enumerates `app/api/**` and fails CI on an unlimited
unauthenticated route. All 41 route handlers were inventoried; every
unauthenticated one has a limiter.

- **H — `/api/guidebook/*` is unreachable by the unauthenticated users it exists
  for.** `proxy.ts:88-231` lists `/g/` in `TOKEN_ROUTES` but not
  `/api/guidebook`, and it is in neither `BYPASS_ROUTES` nor `PUBLIC_ROUTES`, so
  a session-less POST gets a **307 to `/login`**. Sponsor checkout
  (`media-kit-client.tsx:37`) and guest offer redemption
  (`guest-guidebook-view.tsx:801`) are both dead. The inline limiters added in
  the 2026-07-27 audit were attached to routes the middleware never lets a guest
  reach; the guardrail passes because it checks limiter *presence*, not
  reachability.
- **M — Work-order sign-off TOCTOU** (`app/actions/work-order-public.ts:283,296-304`):
  reads `public_signed_off_at`, then updates on `.eq('id', …)` alone. Two
  concurrent submits both write — duplicate photos, duplicate audit events,
  duplicate notifications. The sibling quote route does it correctly with the
  precondition in the UPDATE and a 409 on zero rows.
- **M — Fail-open vs fail-closed is inconsistent across 12 hand-rolled limiter
  call sites** (four distinct behaviors, three undocumented), and the
  `upstashConfigured` short-circuit exists only in `proxy.ts` — every inline
  limiter eats the documented ~4.3s Upstash retry storm in any environment
  without the KV addon.
- **M — iCal SSRF guard is bypassable** (`lib/inngest/functions/ical-sync.ts:13-34`):
  `assertSafeIcalUrl()` string-matches the hostname, then `fetch()` follows
  redirects by default; no DNS resolution, no IPv6, no alternate IPv4 encodings.
  The response body is parsed and persisted, so it is readable, not blind.
- **M — `vendors.stripe_connect_token` never expires and is never rotated** —
  the only token surface in the codebase that is unbounded; every other one has
  an expiry or a revocation column.
- **M — Crew invite tokens with a null `invite_sent_at` never expire**
  (`app/crew-invite/[token]/actions.ts:85-88`) — and CLAUDE.md notes ~a third of
  live crew rows have that field NULL.

### Complexity and silent failures

Toolchain, actually run: `tsc --noEmit` **pass, zero errors**; `eslint` **0
errors, 320 warnings**; `check:ui-classes` **pass**; `vitest run unit/` **pass,
2,249 tests**; `unit/guardrails/` **pass, 90 tests**. The CI `checks` job runs
all of these with no `continue-on-error`, so the guardrail suites genuinely
gate, exactly as CLAUDE.md claims.

Complexity itself is **not launch-blocking**. sonarjs total drifted 236 → 240,
invisible to CI because the rules are `warn` and lint exits 0; freeze it with
`--max-warnings 240` on the lint script. Max cognitive complexity is 41, median
20. Six of the worst offenders sit on security/money paths and are the right
extraction targets: Stripe webhook (35), owner portal data load (33), WO public
sign-off (30), provider webhook (30), account delete (27).

- **C — Dead rollback code in Stripe Connect onboarding**
  (`app/api/vendor-connect/[token]/onboard/route.ts:139`). A PostgREST builder
  is a lazy thenable — verified against
  `postgrest-js@2.110.0/src/PostgrestBuilder.ts:267`, the HTTP request is issued
  only inside `then()`. `void <builder>` never calls `then()`, so **the rollback
  is never sent**, and the `'pending'` mutex set at line 72 is never cleared —
  producing exactly the stuck state the comment promises to prevent. One-line
  fix (`await`); it is the only instance of this anti-pattern in the repo.
- **H — Three discarded errors on the account-deletion path.** At
  `route.ts:49` a failed member count yields `null` → `0 > 0` false → the
  "other members exist" guard **fails open** and deletes an owner's account
  anyway. At `:63` a failed org lookup skips both Stripe cancel blocks and
  deletes the user with a **live subscription**. At `:119` a failed
  `integration_connections` lookup revokes nothing, leaving live third-party
  tokens in Vault.
- **H (systemic) — 518 call sites destructure `data` without `error`.** An RLS
  or GRANT regression renders a clean "no vendors yet" empty state with no
  `console.error`, so nothing reaches Sentry either. H1 above is this pattern
  causing a real, invisible, already-live outage. A shared `unwrap()` helper
  retrofitted to the ~30 dashboard entry points is the highest-leverage fix in
  this dimension.
- **H — No boot-time env validation.** 52 non-null assertions on
  `process.env.*`; `lib/stripe/client.ts:32-51` builds `PLANS` at module load,
  so a missing price ID becomes `undefined` and surfaces as an opaque Stripe
  error at checkout rather than a config failure at deploy.
- **M — Circuit breaker fails open silently**
  (`lib/inngest/functions/ownerrez/incremental-sync.ts:443,535`): during a Redis
  outage the breaker never increments, so it never opens and the app keeps
  hammering a failing API — inconsistent with the `claimNudgeBudgetSlot`
  fail-closed policy CLAUDE.md documents for exactly this reasoning.
- **M — `lib/ical/parser.ts:70`**: `catch { continue }` drops malformed calendar
  events with no log or tally, so a platform changing its iCal format silently
  drops revenue-bearing bookings.
- **M — `db-invariants` CI job has no `pnpm install` step** and does not
  self-disarm the way `e2e` does.

Catch-block hygiene is otherwise good: only 35 of 383 catch blocks lack
logging/throw/return, ~30 of those legitimately. 387 `reportError()` sites
against 383 catch blocks is near-total coverage on *caught* errors — the gap is
entirely in *un-caught* discarded query errors.

### Dexie offline-sync — beyond B4

- **H — The outbox reorders mutations against the same record after 3 failures**
  (`lib/dexie/syncService.ts:118-126`). The `if (newRetryCount >= 3) continue`
  directly contradicts the method's own contract, documented two lines above.
  Concrete failure: a flaky `startTurnover` is skipped, `completeTurnover` jumps
  ahead, `/start` then no-ops because the status is already `completed` and
  returns 200 — yielding a completed turnover with `started_at` NULL, no
  `turnover/started` event, and no error anywhere.
- **H — Most crew writes have no dead-letter UI at all.** Retry surfaces exist
  for only three mutation types; checklist item ticks (the highest-volume crew
  write), inventory quantities, availability, WO reports, and turnover
  start/complete all dead-letter silently.
- **H — The inventory count page is not offline-capable** despite the in-app FAQ
  promising it (`app/crew/inventory/[propertyId]/page.tsx:18,44-56`): counts live
  in React state and post with a live `fetch`, writing nothing to Dexie.
- **M — No pending-mutation shadowing**: every pull is an unconditional
  `bulkPut`, so a queued-but-unpushed local write is reverted in the UI by any
  delta pull, safety poll, or reconnect resync.
- **M — Multi-tab double-drain**: `isProcessing` is per-tab module state over a
  shared IndexedDB; use `navigator.locks`.
- **M — The `crew-sync-coverage` guardrail's premise holds only under v2.**
  `NEXT_PUBLIC_CREW_SYNC_V2` defaults off (`lib/dexie/context.tsx:30`), and the
  v1 path has **no safety poll at all** — `resync()` runs only on mount and
  `online`. Flip the flag before launch or document the discrepancy.
- **M — Crew login wipes an unrelated vendor's queued offline work**:
  `cleanupStaleDexieDbs` (`lib/dexie/schema.ts:403-433`) deletes any
  `fieldstay-*` IndexedDB not containing the current user id, which includes
  `fieldstay-vendor-wo-{token}` outboxes on a shared device.

The Dexie architecture itself is well-designed — cursor invariants, scope
reconciliation, generation tokens, chunked `.in()`, per-entity debouncing are all
sound and match the docs. What is broken is the durability of the offline write
path, which is the product's core promise.

---

## Recommended sequencing

**Before tenant #1 (blockers):** B1, B2, B3 + the three companion
account-delete error checks, B4 and its two companion defects, plus the dead
`void` rollback (`vendor-connect/onboard:139`) and the `/api/guidebook` routing
fix — the last two are one-line changes.

**Same release:** H1 GRANTs (the notification bell is currently dark), H2
storage policies, the invite-acceptance pair (H1/H2 of data correctness — the
primary onboarding path), the compliance-view `is_active` filter and
`isVendorHardBlocked` fail-closed, the WO sign-off TOCTOU, the Kroger
double-spend config, and the Mapbox timeout.

**Before ~20 tenants:** the three unbounded-`.select()` criticals — `ical-sync`
breaks at roughly 17 tenants, which is inside the first cohort.

**Before ~50 tenants:** the two cron step-explosion refactors, the
`build-shopping-cart` pagination, the `getPmMembers` N+1.

**Post-launch hardening:** SSRF guard, token expiry/rotation, the shared
limiter helper, the `unwrap()` retrofit, `--max-warnings` freeze, the six
starred complexity extractions, and FK `ON DELETE` corrections.

## Suggested new guardrails

Per the repo's own meta-rule that a convention ships with its guardrail, five of
these findings are mechanically checkable and would have been caught:

1. Any table with an `authenticated`-facing RLS policy must hold the matching
   Postgres GRANT (`db-invariants`) — this class has now shipped twice.
2. No `organizations` row may have zero `organization_members` (`db-invariants`).
3. `storage` bucket policies must be covered by `public.db_invariant_report()`
   and defined in migrations, not the dashboard.
4. No unbounded `.select()` in `lib/inngest/**` without `.limit()`, `.range()`,
   `.single()`, `.maybeSingle()`, a count head, or a named exception.
5. A `for…of` loop containing `step.run`/`step.sendEvent` may not iterate a
   query result lacking an `org_id`/`.eq(`/`.limit(` bound.

Also worth adding: no direct `organization_members` query outside `lib/auth*`
and `lib/inngest/helpers.ts`, and every webhook route that inserts a dedup row
must delete it in a catch.
