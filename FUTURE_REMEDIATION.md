# Future Remediation

Known gaps identified during self-audits that have **not** been fixed yet —
either lower priority than what was in progress at the time, or needing a
bit more design than a one-line change. Each entry has enough context to
pick back up without re-deriving the finding from scratch.

---

## 1. `DexieProvider`'s `useEffect` closure is doing too much (structural)

**File:** `lib/dexie/context.tsx`

Eight async helpers (`syncAssignedTurnovers`, `pullChecklistsForTurnovers`,
`pullTurnoversOnly`, `refreshChecklistSubscription`, `syncWorkOrders`,
`syncMessages`, `syncCrewAvailability`, `run`) are all declared inside one
`useEffect(() => {...}, [userId])`, now ~350 lines. No single function
exceeds nesting depth 4 or an obvious complexity ceiling, but a couple of
the `.on('postgres_changes', ..., () => {...})` callbacks inside
`refreshChecklistSubscription` sit at exactly 4 levels of function nesting
(`DexieProvider → useEffect → refreshChecklistSubscription → .on callback`).

**Suggested fix:** lift these to module-level functions taking
`(supabase, userId)` as params — improves readability and makes them
unit-testable without mounting the provider.

---

## 2. ~~`SyncEngine.uploadOne()` growing via flat if-chains~~ — RESOLVED

**File:** `lib/dexie/syncService.ts`

This has been done: `uploadOne()` now dispatches through
`const UPLOAD_HANDLERS: Record<string, UploadHandler> = {...}` (line 356)
instead of a flat if-chain. No further action needed.

---

## 3. Hospitable: `reservation_messages` is collected but has no UI

**Files:** `lib/inngest/functions/hospitable/incremental-sync.ts` (message branch),
`supabase/migrations/20260708194732_reservation_messages.sql`

The webhook → Inngest → fetch → upsert pipeline for guest/host conversation
messages is real, correctly deduped, and (per the corrected scope status —
`message:read` is live) should actually work end to end. But nothing in
`app/` ever reads from `reservation_messages` — no page, component, or API
route. A PM has no way to see a synced message anywhere in the product.

**Suggested fix:** a minimal "Recent Guest Messages" card on the booking or
turnover detail page — the data is already flowing, this is a UI-only gap.

---

## 4. Hospitable: crew sync visibility and doc accuracy gaps

**Files:** `docs/support/25-connecting-hospitable.md`,
`app/(dashboard)/crew-manage/crew-manage-client.tsx`,
`lib/integrations/providers/hospitable.ts`

Several smaller gaps found during the Hospitable readiness assessment, not
yet acted on:

- The doc's Hospitable-role → FieldStay-crew-role mapping table claims
  Manager/Owner/Check-in-Check-out map to "Manager"/"Owner"/"Crew" — none of
  those values exist in the `crew_role` enum (`cleaning | landscaping |
  maintenance | general`, confirmed live). Every one of those roles actually
  falls through to `general` in `mapHospitableTeammateRole()`. The doc
  describes impossible behavior.
- The same doc says "crew/teammate changes in Hospitable do not sync
  automatically after the initial connection... disconnect and reconnect to
  re-run" — this is stale; `hospTeammateSyncCron` (daily, registered, and
  confirmed correctly deactivating removed teammates) already handles this.
- No badge/label anywhere distinguishes a Hospitable-imported crew member
  from a manually-added one, and there's no teammate-specific resync button
  (only the full "resync everything" button, which re-runs properties +
  bookings + teammates together).
- `crew_members` currently carries two redundant unique indexes covering
  the same columns (`crew_members_external_unique` and
  `crew_members_org_external_unique`, both `(org_id, external_id,
  external_source)`) — harmless today, but leftover cruft from two
  developers independently fixing the same ON CONFLICT bug without knowing
  about each other's fix. Worth dropping one in a future migration.
- Zero automated test coverage on anything I/O-bearing (sync orchestration,
  webhook handling, token refresh) — only the pure property/reservation
  mapping functions are unit-tested.

---

## 5. ~~OwnerRez: webhook delivery payload shape never verified against a real event~~ — RESOLVED 2026-07-16, scoping added 2026-07-21

**File:** `lib/integrations/providers/ownerrez.ts` (`handleWebhookEvent`),
`app/api/webhooks/[provider]/route.ts`, `lib/inngest/functions/ownerrez/incremental-sync.ts`

Original finding: `handleWebhookEvent`'s switch only recognized a generic
`entity_insert`/`entity_update`/`entity_delete` envelope, with no comment
citing a confirmed real payload sample — risk was that every real webhook
silently hit the `default: unknown action` branch and did nothing.

**Resolved 2026-07-16** (`4903f40`, `ed56396`): re-verified against
OwnerRez's own published webhooks documentation (not a captured live
payload — worth knowing if this ever needs re-confirming against an actual
delivery). `entity_insert` was never a real action value; the real ones are
`entity_create`/`entity_update`/`entity_delete` (the doc contradicts itself
on the create name across two sections of the same page, so the code
accepts both rather than picking one). Confirmed `entity_type` list:
`api_application/booking/guest/inquiry/property/quote/thread_message` —
`review` is not a valid OwnerRez webhook entity_type at all, reviews only
ever sync via the 6-hour polling cron.

**Scoping added 2026-07-21:** `handleWebhookEvent` now resolves which
FieldStay connection a webhook belongs to (via the route's already-extracted
`externalUserId` against `integration_connections`) and includes
`user_id`/`org_id` on the `integration/ownerrez.sync.requested` event it
fires. `ownerrez-incremental-sync.ts` uses that to scope `fetch-connections`
to just the one connection instead of re-syncing every active OwnerRez
tenant platform-wide on every webhook delivery — previously a webhook did
the exact same full-platform sweep as a cron tick, which meant more
connected tenants → more webhook traffic → more full-sweep runs, compounding
pressure on OwnerRez's shared-IP 300-req/5-min rate-limit budget (see
`ownerrez-api.ts`'s proactive 270/300 Redis counter). The manual "sync now"
button (`ownerrez/sync.now.requested`) was already carrying `org_id`/
`user_id` and now gets the same scoping. Falls back to the old full-sweep
behavior whenever the connection can't be resolved (no regression risk).
The cron itself moved from every 15 minutes to hourly as a result — it's
now purely the reliability backstop for whatever a scoped webhook run
misses, not the primary sync path, so a wider window is an acceptable
tradeoff.

**Resolved 2026-07-21 (fail-fast):** the per-connection loop in
`ownerrez-incremental-sync.ts` no longer sleeps through a rate limit. A
`RateLimitError` on any connection now sets `rateLimitedAt` and `break`s the
loop immediately — no `step.sleep`, since the 300-req/5min budget is shared
across every tenant, so every connection after the rate-limited one would
have hit the same exhausted budget anyway. The tick ends, the function
returns `rate_limited_at: <user_id>` for observability, and the unprocessed
connections (their `sync_cursor` never advanced) pick up on the next
scheduled hourly tick in a fresh window instead of the run's duration
growing unbounded from stacked sleeps.

---

## 6. OwnerRez: unconfirmed property detail field names

**File:** `lib/integrations/types.ts:143-145`, consumed by
`buildOwnerRezDetailPatch()` in `lib/integrations/providers/ownerrez.ts`

`smoking_allowed`, `pets_allowed`, `events_allowed`, and `min_renter_age`
on `OwnerRezProperty` are marked with an explicit TODO: "verify these field
names with Paul or via propertysearch filter... presence on the detail
endpoint is unconfirmed." If the field names are wrong, the sync silently
never populates those property columns (guarded by null/undefined checks —
not a crash, just permanently-empty data).

> **Update:** the consumer gap is now fixed — `lib/guidebook/sync.ts`'s
> `syncGuidebookConfigsFromProperty()` now turns these three booleans into
> readable lines (`buildRulesSummaryLines()`, unit-tested in
> `unit/properties/guidebook-rules-summary.test.ts`) and folds them into the
> guidebook's `house_rules` field on first fill, alongside `house_manual`.
> Confirmed live: all 3 currently-synced OwnerRez properties have `null` for
> all three fields today, which is consistent with either (a) the field
> names being wrong, or (b) these test listings genuinely having no rules
> configured in OwnerRez — this doc's original open question. The mapping
> is now real and ready the moment the field names are confirmed correct
> (or already are, and the test properties just have no rules set).

**Suggested fix:** confirm the real field names against a live OwnerRez
property detail response, same verification pattern already used
throughout Hospitable's adapter.

---

## 7. ✅ RESOLVED (2026-07-22) — OwnerRez: orphaned marketplace-install artifacts are never cleaned up

**Resolution:** `cleanupExpiredPendingIntegrationArtifacts()` (lib/integrations/vault.ts)
now runs probabilistically (~5% of requests) from both the oneclick callback and
`/connect/finish`, covering the new `pending_oauth_authorizations` table AND the
legacy `pending_integration_links` table (including the stale 2026-07-07 OwnerRez
row noted below). Shipped alongside the deferred-token-exchange fix
(`supabase/migrations/20260722120000_defer_marketplace_code_exchange.sql`).
Original finding kept for context:

**Files:** `lib/integrations/vault.ts` (`cleanup_expired_pending_integration_links`
DB function), `supabase/migrations/20260707152648_marketplace_pending_integration_links.sql`

`cleanup_expired_pending_integration_links()` exists as a SQL function but
is never called anywhere in the app — unlike `cleanup_webhook_dedup()`,
which genuinely is invoked probabilistically from the webhook route.
Expired, never-claimed `pending_integration_links` rows (and the Vault
secrets they reference) just accumulate indefinitely. Confirmed live: one
such row for OwnerRez, expired 2026-07-07, still present today with no
mechanism that would ever remove it.

This is a minor secret-hygiene / table-bloat issue, not customer-facing —
distinct from the `connect/finish/route.ts` `org_id` guard bug (fixed
2026-07-09), which was the actual cause of a customer-facing stuck
connection and has been resolved.

**Suggested fix:** call `cleanup_expired_pending_integration_links()`
probabilistically from `app/connect/finish/route.ts`, mirroring the
existing `cleanup_webhook_dedup()` pattern.

---

## 8. ~~`repuguard/activated` event is defined but never wired to anything~~ — RESOLVED 2026-07-30, deleted

**Resolution:** deleted the unused event type from `lib/inngest/events.ts`
rather than wiring it up. RepuGuard is bundled into every plan tier —
`docs/support/16-pricing-and-plans.md`'s "What Every Plan Includes" lists
"RepuGuard AI review response drafting" alongside turnovers, work orders,
etc. with no separate charge or opt-in. There is no live path anywhere in
the app that creates a standalone `feature: 'repuguard'` Stripe
subscription for this event to have paired with — the webhook handlers in
`app/api/webhooks/stripe/handlers/repuguard-subscription.ts` that listen
for `subscription.metadata?.feature === 'repuguard'` have no producer
either. `repuguard_status` instead gets auto-activated directly (no Stripe
subscription, no event) on first PMS connect —
`lib/inngest/functions/ownerrez/initial-sync.ts`'s `auto-activate-repuguard`
step flips inactive/cancelled orgs to `'active'` on OwnerRez connect. So
there was never going to be a meaningful "activation" moment for this event
to represent.

**Note for a future pass, not done here:** since `repuguard/activated` was
scoped to the standalone-subscription path and that path has no live
producer, the `repuguard-subscription.ts` webhook handlers themselves (and
the `feature: 'repuguard'` branches in `app/api/webhooks/stripe/route.ts`
that call them) may also be dead code from before bundling — worth its own
audit pass to confirm before removing, since deleting a webhook branch has
more blast radius than deleting an unused event type.

Original item kept below for context:

### ~~`repuguard/activated` event is defined but never wired to anything~~

**File:** `lib/inngest/events.ts`

Found while mapping the Inngest event graph (`docs/architecture/CODEBASE_MAP_PASS2_EVENT_GRAPH.md`).
`organizations.repuguard_status` is set directly by
`app/api/webhooks/stripe/route.ts` on the RepuGuard-specific subscription
branch — a plain DB update, no event fired. This event type has zero
producers and zero consumers anywhere in the codebase. Left as-is
(deliberately, at the repo owner's request) rather than deleted, because
it's plausible something was meant to fire on activation — a welcome
email, an auto-generated first batch of review responses — that was
never built, as opposed to the two events removed alongside it
(`inventory/below-par`, `maintenance/daily-check`) which were confirmed
superseded by other mechanisms.

**Suggested fix:** decide once and for all — either delete the unused
event type (if activation genuinely needs no follow-on automation), or
wire it up the same way `guidebook/sponsor.checkout.completed` triggers
`guidebookSponsorActivated` (fire it from the same Stripe webhook branch
that already sets `repuguard_status`, add a consumer that does whatever
onboarding step RepuGuard activation should kick off).

---

## 9. ~~`billing/subscription-updated` is sent but has zero consumers~~ — RESOLVED 2026-07-30

**File:** `app/api/webhooks/stripe/route.ts` (send site), `lib/inngest/events.ts`

Also found during the event-graph pass. Fired on every
`customer.subscription.created`/`.updated` webhook, but no Inngest
function anywhere subscribes to it. Not a functional break —
`organizations.plan`/`plan_status`/`max_properties` are updated
synchronously in the same webhook handler, before the send — but the
event itself reaches no listener. Looks like a stub for a "notify PM
their plan changed" email that was scoped but never implemented,
unlike `billing/trial-lifecycle-start` and `user/onboarding.drip.started`
(initially miscategorized as unmatched by the same pass, later confirmed
fully wired via `email-trial-lifecycle.tsx`/`onboarding-drip.tsx` once
the `.tsx` function files were included in the search).

**Suggested fix:** either build the missing PM-facing "plan changed"
notification consumer (mirroring `notifyIntegrationError`'s shape), or
remove the dead `inngest.send()` call and the event type if no
notification was ever actually wanted here.

**Resolution:** built the consumer. Before doing so, checked whether a
plan change already surfaces anything else (the working assumption going
in) — it doesn't: the Stripe Checkout `success_url` sets
`?checkout=success` on `/settings`, but nothing in the app reads that
query param (no toast, no confirmation banner), and the only billing
emails that exist are for trial-start and trial→active first-payment —
neither fires again for a plan-tier change on an already-active org. So
this event was the only hook ever positioned for it, and it was genuinely
dead, not redundant.

Implementation:
- `handleCoreSubscriptionUpdate` (`core-billing.ts`) now selects the org's
  `plan` *before* the update overwrites it, and includes a
  `previous_plan: string | null` field on the `billing/subscription-updated`
  event — non-null only on a genuine tier change on an existing
  subscription. Deliberately always `null` on `customer.subscription.created`
  (initial signup), even if the org's pre-signup default plan happens to
  differ from the tier they signed up for — that's not a "plan changed"
  event from the PM's perspective, and the trial-lifecycle-start email
  already covers signup.
- New `notifyPlanChanged` function
  (`lib/inngest/functions/notify-plan-changed.ts`, registered in
  `app/api/inngest/route.ts`) consumes the event, no-ops when
  `previous_plan` is null or equals the new `plan` (nothing to report), and
  otherwise creates a PM-facing in-app notification via
  `createPmNotification()` (`type: 'billing_plan_changed'`, e.g. "Your plan
  changed to Growth" / "Previously Starter") — this mirrors
  `notifyIntegrationError`'s shape as suggested, using the in-app
  notifications bell rather than a new email template, consistent with
  CLAUDE.md's note that the bell "superseded 7 PM email categories."
  Dedupe key is day-scoped (`plan-changed-{org}-{from}-{to}-{date}`,
  matching `notify-integration-error.ts`'s convention) so a same-day retry
  doesn't double-insert but a later repeat of the same transition
  (upgrade → downgrade → upgrade again) still notifies.
- New tests: `unit/webhooks/core-billing-subscription-update.test.ts`
  (the `previous_plan` enrichment logic) and
  `unit/inngest/notify-plan-changed.test.ts` (the consumer). Full
  verification pass green.

---

## 10. ~~Dashboard layout and `requireOrgMember()` are two independent implementations of the same lookup~~ — RESOLVED, already fixed prior to this note

**Resolution:** already fixed by commit `97a5553` ("Memoize
requireOrgMember() per request and fix dashboard layout waterfall"),
merged before this remediation pass caught up to it — this item was simply
never marked resolved in this file. `app/(dashboard)/layout.tsx` now calls
`requireOrgMember()` directly instead of inlining its own
`organization_members` query, and `OrgMembership` in `lib/auth.ts` was
extended to carry `repuguard_status` and `onboarding_steps_completed` — the
exact fields the layout needed that the original `OrgMembership` type
didn't carry. That's the first of the two suggested fixes below (extend
`OrgMembership`/`requireOrgMember()`), not the second (a separate shared
helper). Verified current `layout.tsx` has no independent
`organization_members`/`organizations` query left — `requireOrgMember()` is
the sole lookup, and it's `cache()`-memoized per request so the page
rendered inside the layout shares the same query rather than re-running it.

Original item kept below for context:

### ~~Dashboard layout and `requireOrgMember()` are two independent implementations of the same lookup~~

**Files:** `app/(dashboard)/layout.tsx`, `lib/auth.ts`

Found while mapping UI surfaces (`docs/architecture/CODEBASE_MAP_PASS4_UI_SURFACES.md`).
`app/(dashboard)/layout.tsx` does not call `requireOrgMember()` — it
inlines its own `organization_members`/`organizations` query, extended
with fields (`repuguard_status`, `onboarding_steps_completed`) that the
shared `OrgMembership` type in `lib/auth.ts` doesn't carry, plus its own
onboarding/billing-gate redirect logic that doesn't match
`requireOrgMember()`'s behavior. Not a bug today, but a maintenance seam:
a future change to the org-membership query (e.g. a new column another
feature needs inside `requireOrgMember()`) has no reason to also touch
the layout's copy, and the two can silently drift apart.

**Suggested fix:** extend `OrgMembership`/`requireOrgMember()` to
optionally carry the extra fields the layout needs (or add a second
shared helper it can call for the same base query), so there's one
canonical implementation of "look up the current user's org membership"
instead of two.

---

## 11. Login/signup/password-reset have no FieldStay-side rate limiting

**Files:** `app/(auth)/login/login-form.tsx`, `app/(auth)/signup/signup-form.tsx`,
`app/(auth)/forgot-password/forgot-password-form.tsx`,
`app/(auth)/reset-password/reset-password-form.tsx`

Found during an incoming-endpoints rate-limiting/fan-out audit. All four of
these call `supabase.auth.*` (`signInWithPassword`, `signUp`,
`resetPasswordForEmail`, `updateUser`) directly from the client — there is
no FieldStay route handler or Server Action in between, so nothing in
`lib/rate-limit.ts` can apply to them even in principle. Whatever
throttling exists today is entirely Supabase Auth's own internal behavior,
invisible to and unmanaged by this repo. This corrects an earlier assumption
in this project's history that rate limiting had been "added" to these
routes — that isn't true of the current code.

**Status: decided 2026-07-30 — mixed.** Supabase Auth's built-in limiting is
sufficient for signup/password-reset; login is the one gap worth a
follow-up. Concrete limits (from Supabase's documented defaults, matching
`[auth.rate_limit]`/`[auth.email]` in `supabase/config.toml`):

| Endpoint | Limit |
|---|---|
| Sign up (`/auth/v1/signup`) | 60s cooldown before a repeat request for the same email |
| Password reset (`/auth/v1/recover`) | 60s cooldown before a repeat request for the same email |
| Login / token refresh (`/auth/v1/token`) | 1,800 requests/hour per IP, token-bucket bursts up to 30 |
| Default built-in email provider | 2 emails/hour **project-wide** (signup confirmations + password resets combined) |
| Custom SMTP | Limits depend on the external provider instead — Supabase recommends this to lift the default's testing-grade limits |

**Two separate findings here, not one:**

1. **Signup/password-reset: the 60s per-email cooldown is adequate as-is.**
   It rate-limits the thing that matters (repeat delivery to one target
   address); no FieldStay-side duplication needed.

2. **Login is the real gap, and it's operational risk, not just theory:**
   the limit is 1,800 req/hour **per IP**, with bursts up to 30 — that's
   IP-scoped only, not per-account. A single IP can throw 30 password
   guesses at one specific target account instantly, then continue at
   ~30/minute indefinitely, all within Supabase's own limit. That's
   materially weaker than a per-account lockout/backoff for a targeted
   credential-stuffing attempt against one user. **Suggested fix (not yet
   implemented — scoping only):** add a per-account (email-keyed, not just
   IP-keyed) attempt counter in `lib/rate-limit.ts` ahead of
   `supabase.auth.signInWithPassword()` in `login-form.tsx`, failing open
   the same way the existing abuse-rate limiters do per CLAUDE.md's SMS
   section (never lock a real user out on a Redis outage).

3. ~~Unrelated to security, but more urgent: verify production custom SMTP
   is actually configured.~~ **Confirmed by repo owner 2026-07-30: a non-
   issue.** Production Supabase Auth is configured to send through Resend's
   SMTP relay, not Supabase's default built-in mailer — the 2-emails/hour
   project-wide cap only applies to that default mailer and doesn't apply
   here. (Still can't be independently verified from this repo —
   `supabase/config.toml`'s `[auth.email.smtp]` block is commented out and
   production SMTP is dashboard-only state with no record in code — this
   line reflects the repo owner's confirmation, not a repo-side check.)

---

## 12. ~~`crew/feedback` sends its notification email outside Inngest, un-awaited~~ — RESOLVED 2026-07-30

**File:** `app/api/crew/feedback/route.ts`

Found during the same audit. `notifyPlatformStaff()` is fired with `void
... .catch()` (fire-and-forget) rather than `await`ed or queued through
Inngest — every other email-sending code path in this codebase either
awaits inline or fans out to Inngest for durability/retries. If the
serverless function instance is torn down before the promise settles, the
notification is silently lost with no retry.

**Suggested fix:** fire an Inngest event instead (e.g.
`crew/feedback.submitted`) and send the notification email from a handler,
matching the pattern used everywhere else in this codebase.

**Resolution:** implemented as suggested. Added `crew/feedback.submitted`
to `lib/inngest/events.ts`, moved the `notifyPlatformStaff()` email logic
into a new `notifyCrewFeedback` function
(`lib/inngest/functions/notify-crew-feedback.ts`, registered in
`app/api/inngest/route.ts`), and `app/api/crew/feedback/route.ts` now
`await`s `inngest.send()` (confirming Inngest accepted the job) instead of
firing the email itself with `void ... .catch()`. A send failure is still
logged without failing the crew member's 200 response, since the
`crew_feedback` row is already durably written by that point — only the
*mechanism* for the notification changed, not the accepted-loss tier for
notification delivery. Test coverage moved with it:
`unit/route-handlers/crew-feedback.test.ts` now asserts the route enqueues
the event (and that a send failure doesn't affect the response), and the
email-sending behavior itself is covered by the new
`unit/inngest/notify-crew-feedback.test.ts`.

---

## 13. ~~Migration filename timestamps vs. recorded applied versions have drifted~~ — RESOLVED 2026-07-30

**Resolution:** took a third path neither (a) nor (b) below anticipated:
updated the **remote ledger** to match the local filenames, rather than
renaming ~250 local files (which would have broken the exact-filename
references throughout CLAUDE.md, docs/, code comments, and guardrail tests).
In production (`vpmznjktllhmmbfnxuvk`), rewrote the 67 discrepant
`supabase_migrations.schema_migrations` rows so `version` equals the local
filename's timestamp prefix and `name` equals its description (this also
normalized 9 rows whose `name` had a second timestamp embedded in it). Done
as a two-phase update (temp-prefixed versions, then stripped) inside one
transaction so the primary key never saw a transient collision. Verified by
digest: `md5` over the sorted `version_name` set now matches `md5` over the
sorted local filename set exactly (276 = 276).

One local file was the odd one out: `20260617000003_add_missing_fk_indexes.sql`,
an applied-under-another-timestamp draft (it already carried a 2026-07-08
"NOT RECORDED IN LIVE MIGRATION HISTORY" header) that the 2026-07-28
`_unshipped/` sweep missed — moved to `supabase/migrations/_unshipped/` with
the standard SUPERSEDED header.

**Deliberately out of scope:** the E2E project's (`syhthijeqlnltufdawyb`)
ledger, which contains genuine duplicate applies and E2E-only entries from
its independently-migrated era. Nothing reads it — the `db-invariants` and
type-drift CI gates verify E2E via RPCs against the live schema, not the
ledger — so reconciling it would be churn without benefit. Schema parity is
what matters there, and those gates enforce it.

**Go-forward convention:** when applying a migration via the MCP
`apply_migration` tool, it stamps the row with its own execution-time
version regardless of the `name` passed — so after each apply, fix the new
row to match the local filename:
```sql
UPDATE supabase_migrations.schema_migrations
SET version = '<local file timestamp>', name = '<local file description>'
WHERE version = (SELECT max(version) FROM supabase_migrations.schema_migrations);
```
(or keep passing the full filename as `name` and batch-fix later — either
way, don't let the drift re-accumulate silently.)

Original item kept below for context:

### ~~Migration filename timestamps vs. recorded applied versions have drifted~~

**Files:** `supabase/migrations/*.sql` (local) vs. Supabase's migration
history table for project `vpmznjktllhmmbfnxuvk` (remote)

Found while checking the restock-email ticket's migration-drift prerequisite.
`ls supabase/migrations/*.sql` lists 270 local files; `list_migrations`
against the live project returns only 213 recorded versions — on the
surface, ~57 local-only entries with no matching remote version.

**Root cause, confirmed, not just suspected:** this environment has no
Supabase CLI, so every migration in this repo's history has been applied via
the `apply_migration` MCP tool (direct SQL execution) rather than
`supabase db push`. `apply_migration` stamps the applied row with its own
execution-time version, not the timestamp in the local `.sql` filename. For
the overwhelming majority of the ~57 discrepant entries, the *name* has an
exact match in the remote list under a *different, later* timestamp — e.g.
locally `20260712140000_work_orders_reported_by_crew.sql` recorded remotely
as `20260712233741_work_orders_reported_by_crew`; `20260713000000_asset_scan_status.sql`
recorded as `20260713022506_asset_scan_status`. This is mechanical and
systemic, not schema drift — the content is live, just filed under a
different version number than the local filename implies. Confirmed
directly: every migration applied earlier in *this same session* shows the
identical pattern.

**Genuine exceptions worth a closer look**, rather than just a relabeling:
`20260618000002_baseline_schema_snapshot.sql` has no obviously-named remote
counterpart at all (and a second copy of the same filename exists under
`supabase/migrations/_unshipped/`, per earlier session notes — unclear
whether either was ever actually applied as its own discrete migration, or
whether its content arrived piecemeal via earlier ad hoc applies and this
file is a documentation-only consolidation). A handful of others in the
diff may be similar — this list wasn't individually verified past the
name-matching pass described above.

**Suggested fix:** either (a) rename each local `.sql` file's timestamp
prefix to match its actual recorded remote version, so `git log` and the
Supabase dashboard agree on what a migration is called, or (b) if the
Supabase CLI ever becomes available in this environment, run a proper
`supabase db push`/`db pull` reconciliation pass once, then keep it as the
apply mechanism going forward instead of ad hoc `apply_migration` calls.
Either way, don't treat local filenames as authoritative for "what version
is this schema change" until this is resolved — the live database is
always the source of truth in the meantime, per this repo's own existing
schema-reference guidance.

---

## 14. Migration-time dynamic SQL via `EXECUTE`/`format()` — safe today, worth a guardrail note

**Files:** `supabase/migrations/20260614122755_fix_property_owners_policies.sql:7`,
`supabase/migrations/20260614122744_fix_quote_requests_policies.sql:7`,
`supabase/migrations/20260707141631_security_definer_execute_grants.sql:29-30`

Found during a sanitization audit. Three migrations build SQL dynamically:
the two `fix_*_policies.sql` files do
`EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON ...'` where
`r.policyname` comes from `pg_policies`, not user input, and
`security_definer_execute_grants.sql` does
`EXECUTE format('REVOKE EXECUTE ON FUNCTION %s ...', fn)` where `fn` is
drawn from a hardcoded array literal. Neither is exploitable — these are
one-time migration scripts, not runtime RPCs, and no value in either
string originates from a user-supplied identifier.

**Suggested fix:** no action needed against current usage, but if either
pattern is ever copied into a runtime `SECURITY DEFINER` function callable
from the app, switch to `format('...', quote_ident(...))` or the `%I`/`%L`
format specifiers rather than raw string concatenation, so a future copy-
paste doesn't turn a safe migration-only pattern into an injectable one.

---

## 15. PostgREST `.or()` filter-string construction — fragile pattern, not currently exploitable

**Files:** `lib/turnovers/generator.ts:393`, `lib/sms/optin-claim.ts:22`,
`app/api/integrations/[provider]/callback/route.ts:255`,
`app/(dashboard)/messages/page.tsx:21`, `lib/dexie/context.tsx:401`

Found during the same audit. Several call sites build Supabase `.or()`
filter strings via template literals — a PostgREST filter-injection
surface in principle (e.g. a raw `,role.eq.admin` could smuggle in an
extra OR condition if attacker-controlled text were ever interpolated
directly). Traced every current call site: all interpolated values are
internally-generated UUIDs (`booking.id`, `user.id`,
`membership.org_id` from the session) or computed ISO dates — never raw
external/free-text input — so there is no live exploit today.

**Suggested fix:** add a small typed helper (e.g. `orFilter(...)` that
validates UUID/date shape before interpolating) at these call sites, or at
minimum a comment noting the constraint, so a future contributor doesn't
accidentally pass a free-text field (a search query, an external booking
ID) into this pattern without realizing it needs escaping/validation first.

---

## 16. Vendor work-order completion — RESOLVED 2026-08-01

**Files:** `app/api/work-orders/[token]/complete/route.ts`,
`app/api/work-orders/[token]/complete/helpers.ts`,
`supabase/migrations/20260801200000_complete_work_order_via_token_rpc.sql`

The completion is now ONE TRANSACTION: `complete_work_order_via_token()` claims
the work order, allocates the invoice number, inserts the invoice, the line
items and the status-change row, and returns the result. Either all of it
lands or none does, which closes all three residual holes the 2026-07-31
reordering left open — the compensating delete that could itself fail, the
window where an invoice existed against a not-yet-completed work order, and
the burnt invoice number on a post-sequence failure. `rollbackUnclaimedInvoice`
and `createVendorInvoice` are deleted rather than kept: a rolled-back
transaction leaves nothing to compensate for.

The route keeps token validation, payload validation, the audit log and Inngest
dispatch — the last two deliberately OUTSIDE the transaction, since an event
fired from one that later aborts cannot be unfired.

Verified against the live E2E project inside a rolled-back `DO` block: claim +
invoice + 2 line items + 1 status row in a single call; a replay returning
`already_closed` and writing nothing further; an unpriced completion writing no
invoice and leaving `actual_cost` untouched. Applied to BOTH projects.

**It also surfaced a live silent-data-loss bug** — see the note in
`unit/guardrails/generated-column-writes.test.ts`. `work_order_line_items.line_total`
is `GENERATED ALWAYS`, so the old `insertVendorLineItems()` insert failed with
428C9 on EVERY vendor completion and only `console.error`'d, discarding the
vendor's itemisation entirely. A second instance of the same class
(`assignment_outcomes.duration_minutes` in `turnover-events.ts`) was found by
the new guardrail and fixed in the same change.

**The earlier blocking concern is resolved:** migrations are now applied to
both the production and E2E projects via MCP as part of the change, so a new DB
function no longer reds the e2e suite until someone applies it by hand.


## 17. Smaller items deferred from the 2026-07-30 pre-launch remediation

Each was found during that pass, judged deliberately rather than missed,
and left with a reason. Recorded here so they don't only exist in a
transcript.

- **Crew outbox reconnect waits out its backoff.** `SyncEngine`'s `online`
  handler has no `ignoreBackoff`, unlike the vendor path
  (`lib/dexie/vendorWoSyncService.ts`), so a crew member regaining signal
  can wait up to the full ~5-minute backoff before their queued work
  drains. Same class as the vendor bug fixed on 2026-07-31; not fixed
  because no spec exercises it and it would touch the crew backoff tests.

- **~149 Server Action reads still collapse "query errored" into "zero
  rows".** Baselined in `unit/guardrails/supabase-error-handling.test.ts`
  (481 sites / 169 files, shrink-only). Every dashboard *read* path was
  fixed; the Server Actions were not, because each needs its own
  user-facing message and fail-vs-degrade decision, and a mechanical
  rewrite of 149 write paths would have been worse than the known gap.

- **The E2E project cannot catch the missing-GRANT class.** It carries a
  blanket `GRANT ALL` to `authenticated` on 91 of 93 public tables, so the
  new policy↔GRANT invariant in `scripts/check-db-invariants.mjs` passes
  vacuously there. That check found nine ungranted tables in production —
  but only because it was run against production by hand. As CI is wired
  (E2E only), it would not have caught them. Either point the job at
  production read-only as well, or make E2E's grants mirror production.

- **E2E has no storage buckets** except the two guidebook ones — no
  `compliance-documents`, `work-order-photos` or `turnover-photos`. So no
  e2e test exercises photo upload or compliance documents, which is exactly
  the surface the B2 cross-tenant blocker was about.

- **Migration history has drifted between projects.** Production has
  `20260730123000` and `20260730213349`; E2E has `20260730122734`,
  `20260730122817`, `20260730213400`. Different sets on each, and at least
  one on each side has no local file — the same untracked-drift class as
  the B2 blocker itself. See also entry 13 above.

- **`compareCodeUnits` exists twice** (`lib/inngest/functions/
  build-shopping-cart.ts` exported, `app/(dashboard)/inventory/actions.ts`
  local) because the latter is `'use server'`, where every export must be
  an async action, so sharing it needs a third module. Fine at two copies;
  factor it out if a third canonicalisation sort appears.

- **`cron/maintenance-schedules.ts:326`** remains a named `REAL GAP` in
  `unit/guardrails/inngest-insert-idempotency.test.ts` — a step retry can
  append a duplicate escalation note. Cosmetic (a duplicate note, not a
  duplicate financial record); closing it needs a product decision about
  what makes two escalation events "the same".

---

## 18. `check-type-drift.mjs` compares column PRESENCE but not NULLABILITY

**File:** `scripts/check-type-drift.mjs` (CI job `db-invariants`)

Found while wiring the `<Database>` generic into the Supabase clients
(2026-08-03, PR #548). The gate diffs `types/database.ts` against the live
schema for enum labels, table presence, and column presence — but never
compares whether a column is nullable. So a hand-written interface can claim
`specialty: VendorSpecialty` for a column that is `NULL`-able and the gate
stays green.

That is not a cosmetic gap. It is the direction that actually breaks: code
trusts the non-null type and dereferences. Four of the defects the generic
found were exactly this shape — `vendors.specialty` and
`crew_members.specialty` are nullable, and two components called
`.replace()` on them unguarded; `property_assets.macrs_class` /
`depreciation_method` / `salvage_value` are nullable and the depreciation
calculator passed them straight through. Those four were corrected in #548,
but nothing stops the next one.

**The data is already there — this is script-only work.** No migration and
no new plumbing:

- `public.db_type_shape_report()` already returns `is_nullable` per column
  (see `supabase/migrations/20260726014601_...sql`, the `'is_nullable',
  (c.is_nullable = 'YES')` key). The script simply ignores it — `grep -c
  is_nullable scripts/check-type-drift.mjs` is 0.
- `parseInterfaces()` already captures each field's TYPE TEXT, not just its
  name (`fields[f[1]] = f[2]`), so the TS side needs no new parsing either.

**Suggested fix:** in the section-3 column loop, for every column present on
both sides, compare `dbCols[col].is_nullable` against whether the TS type
text matches `/\|\s*null/` (or the field is declared optional with `?:`).

Two asymmetries worth encoding rather than treating alike:

- **DB nullable + TS non-null → failure.** This is the dangerous direction
  described above.
- **DB NOT NULL + TS nullable → warning at most.** Over-defensive, never
  unsafe, and sometimes deliberate (a column that is NOT NULL today but was
  backfilled recently). Consider reporting it separately rather than failing.

**Size, measured 2026-08-03 against production: 17 columns**, all in the
dangerous direction, across 90 mapped tables / 1106 fields:

```
bookings.source                            ical_feeds.source
checklist_item_signals.dynamic_photo_required   organizations.repuguard_status
checklist_item_signals.flag_probability     properties.avg_stay_length
crew_members.preferred_contact              properties.avg_turnovers_per_month
crew_members.specialty                      properties.bedrooms
ical_feeds.last_sync_status                 properties.checkin_time
vendors.specialty                           properties.checkout_time
work_order_line_items.line_total            properties.max_guests
                                            properties.property_type
```

17 is small enough to FIX in the same PR that adds the check, so this needs
no clean-baseline ratchet — unlike `supabase-error-handling`. Note most of
these are nullable-with-a-DEFAULT, so the fix is usually to mark the field
`| null` and route the read through `withPropertyDefaults()`
(`lib/properties/defaults.ts`) or the column's own default, not to change
the schema.

**Two gotchas for whoever picks this up:**

- The interfaces carry PostgREST embed aliases as fields (e.g.
  `turnovers.turnover_assignments`, `turnover_assignments.crew_members`).
  They are not columns, so they simply won't join against
  `information_schema` — but they must not be reported as "TS field missing
  from the DB" either. `COLUMN_ALLOWLIST` already exists for this.
- `Json` columns and the deliberate widenings (e.g.
  `guidebook_configurations.extension_contact_method` is TEXT-with-CHECK and
  is intentionally typed `string | null`, narrowed at the boundary instead)
  need an allowlist entry or they will read as drift.

---

## 19. 49 more `jsx-a11y/label-has-associated-control` violations across 11 files

Found while fixing the 7 in `turnovers/turnover-board.tsx` (now resolved —
each `<label>` there was a sibling of its control with no `htmlFor`/`id`
link, so screen readers announced the field with no name, and clicking the
label text didn't focus the control). Same rule already runs repo-wide on
every `npm run lint` (`eslint .`) at `warn` severity as part of the jsx-a11y
rollout described in CLAUDE.md's Code Quality Standards — this is the full
list of what it's still catching, pulled via:

```bash
npx eslint . --format json 2>/dev/null | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
for (const f of data) {
  const n = f.messages.filter(m => m.ruleId === 'jsx-a11y/label-has-associated-control').length;
  if (n) console.log(n, f.filePath);
}
"
```

**File-by-file breakdown (56 total found 2026-07-31, 7 already fixed in
`turnover-board.tsx`, 49 remaining):**

| Count | File |
|---|---|
| 11 | `app/(dashboard)/maintenance/maintenance-board.tsx` |
| 10 | `app/(dashboard)/vendors/vendors-client.tsx` |
| 7  | `app/(dashboard)/comms-log/comms-log-client.tsx` |
| 6  | `app/(dashboard)/bookings/bookings-client.tsx` |
| 4  | `app/(dashboard)/reviews/reviews-client.tsx` |
| 3  | `app/(dashboard)/settings/settings-tabs.tsx` |
| 2  | `app/(dashboard)/maintenance/CreateWorkOrderModal.tsx` |
| 2  | `components/property/PropertyMaintenanceManager.tsx` |
| 2  | `components/work-orders/VendorDispatchDialog.tsx` |
| 1  | `app/(dashboard)/properties/clone-property-modal.tsx` |
| 1  | `app/(dashboard)/templates/maintenance/create/create-template-builder.tsx` |

Note `settings-tabs.tsx` includes 2 flagged as "A form label must have
accessible text" (lines 629, 661) rather than the more common "must be
associated with a control" message — same underlying rule, worth checking
those two aren't a genuinely empty `<label>` rather than just a missing
`htmlFor`/`id` pair before applying the same mechanical fix.

**Suggested fix:** same mechanical pattern as `turnover-board.tsx` — add a
matching `id`/`htmlFor` pair to each label/control. Watch for the same
uniqueness trap that came up there: any label/control pair that renders
inside a list item (a row per turnover, vendor, work order, etc.) needs an
id keyed off that row's own id (e.g. `` `field-name-${row.id}` ``), not a
static string, or multiple simultaneously-rendered rows collide on the
same DOM id. A static id is only safe for a form that has at most one
mounted instance at a time (a modal, a single settings panel).

Not done in this pass because it's real, multi-file work rather than a
one-line change — 11 files' worth of JSX to individually verify (which
control each label is meant to pair with, and whether that control is
inside a list needing a per-row id) is enough surface area to warrant its
own pass rather than folding it into an unrelated PR.

---

## 20. Turnover card header nests interactive elements (`role="button"` div containing real buttons/inputs)

**File:** `app/(dashboard)/turnovers/turnover-board.tsx`, `TurnoverCard`'s
card header (`<div role="button" tabIndex={0} onClick={...expand/collapse...}>`,
around line 370)

Flagged by CodeRabbit on PR #542: the header div that toggles the card's
expanded state is a `role="button"` container, but it wraps several real
interactive descendants — a bulk-select `<input type="checkbox">`, a
`<button>` on the pending-assignment status badge, and (further down the
same header) the `CrewAssignment` component's own buttons and the
`QuickFlagPanel`/archive buttons. Each of those descendants calls
`e.stopPropagation()` on its own click to keep it from *also* toggling the
card, which works functionally, but nesting real interactive controls
inside a `role="button"` ancestor is a known ARIA/WCAG anti-pattern —
assistive tech has no well-defined behavior for "interactive element
inside an interactive element," and a screen reader user tabbing through
the card can get an inconsistent read on what's actually clickable.

This predates this PR — the pattern already existed before any of the
turnover-events/duration-tracking/FAQ work landed; this PR only touched a
couple of the *nested* propagation-guard divs inside it (fixing their own,
separate keyboard-listener gaps), not the outer header itself.

**Suggested fix:** per CodeRabbit's own recommendation, either (a) make the
expand/collapse trigger a real `<button>` that wraps only non-interactive
content (property name, status badges, times — move the checkbox, crew
controls, and action buttons outside it), or (b) keep the header as a
plain non-interactive `<div>` and add a small dedicated expand/collapse
`<button>` (e.g. wrapping just the chevron icon) as the actual toggle
control, with the rest of the header's content living alongside it rather
than inside a click target.

**Why not fixed here:** this is a real layout restructuring, not a
markup-only tweak — CodeRabbit itself tagged it "Heavy lift." Getting it
right means deciding where the click-to-expand hit target should actually
live once it's no longer "the whole header," verifying every existing
propagation-stopping button still works with the new structure, and a live
browser check (this pattern is used across the whole card, so a visual
regression here would be immediately obvious to every PM using the
Turnovers board) — not something to attempt as a drive-by fix while
resolving an unrelated merge conflict.

---

## 21. ~~`types/database.generated.ts` is stale for `organizations.stripe_event_at`~~ — RESOLVED 2026-08-05

Regenerated against production (`vpmznjktllhmmbfnxuvk`) via the Supabase MCP
`generate_typescript_types` tool, as its own mechanical commit with no other
changes — which is what the "why it was not done here" note below asked for.

The diff came out to exactly the six predicted columns on `organizations`,
each appearing three times (Row / Insert / Update): `stripe_event_at` added,
the five `repuguard_*` columns removed. Nothing else in the 6,300-line file
moved, so the "landing a multi-thousand-line generated diff would bury the
review surface" concern turned out not to apply — the schema had drifted in
one table only.

Verified afterwards: `tsc --noEmit` clean, 2,957 tests passing, and
`types/database.ts` already carried `stripe_event_at` with no `repuguard`
reference, so the two type files now agree. `scripts/check-type-drift.mjs`
could not be run locally (it needs the E2E credentials and self-disarms
without them) — but note it would not have caught this drift regardless: it
diffs the HAND-WRITTEN `types/database.ts` against the live schema, never the
generated file. Nothing in CI compares the generated file to anything, which
is why this went stale silently and will again.

The original entry follows.

---

`supabase/migrations/20260804210000_stripe_subscription_event_recency_guard.sql`
added `organizations.stripe_event_at timestamptz` (the monotonic guard that
stops an out-of-order Stripe delivery overwriting newer entitlement — Stripe
retries for ~3 days and does not guarantee order). It was applied to both
production (`vpmznjktllhmmbfnxuvk`) and E2E (`syhthijeqlnltufdawyb`).

The hand-written `types/database.ts` — the app's import surface, and the file
`scripts/check-type-drift.mjs` actually compares against the live schema — was
updated in the same commit, so nothing is broken and CI is not red.
`types/database.generated.ts` was NOT regenerated, so the two type files
disagree about this one column.

The same commit's sibling migration
(`20260804230000_drop_vestigial_repuguard_columns.sql`) DROPPED
`organizations.repuguard_status` and `organizations.repuguard_stripe_subscription_id`,
which the generated file still declares — so the drift is in both directions:
one column missing, two columns that no longer exist.

**Why it was not done here:** regenerating requires the Supabase CLI
(`npx supabase gen types typescript --project-id vpmznjktllhmmbfnxuvk >
types/database.generated.ts`) or the Supabase MCP `generate_typescript_types`
tool, and it rewrites the whole file. Landing a multi-thousand-line generated
diff inside a behaviour-change commit would bury the actual review surface —
the recency guard and the RepuGuard gate removal — in noise.

**Fix:** regenerate on its own, as a single mechanical commit with no other
changes, and confirm `types/database.ts` still agrees afterwards.

**Why it matters despite not being red:** `lib/supabase/server.ts` still omits
the `<Database>` generic (see the note in `types/database.ts`), so no
`.from()`/`.rpc()` call is type-checked against the generated schema yet. The
day that generic is wired up — which is the stated direction — every stale
column in the generated file becomes a compile error or, worse, a silently
wrong inferred row type. The drift is free right now and expensive later.

### ~~Related: three more RepuGuard columns are now unread~~ — RESOLVED 2026-08-04

`repuguard_trial_start`, `repuguard_trial_end` and `repuguard_founding_member`
were held back from `20260804230000` because a "founding member" flag can
encode commercial intent (grandfathered pricing, a launch cohort) that
outlives whatever code once set it, and a column drop is irreversible.

Confirmed with the product owner and dropped in
`20260804240000_drop_remaining_repuguard_columns.sql`, applied to both
projects. The evidence: zero readers anywhere in the repo (only the
`Organization` interface and the historical migrations that created them), and
all three empty on BOTH projects — 0 trial starts, 0 trial ends, 0 founding
members across 8 production orgs and 1 E2E org. No cohort existed to preserve.

The trial columns had in fact been carrying nothing since June:
`20260608122111_repuguard_bundled_activation.sql` explicitly NULLed
`repuguard_trial_start`/`repuguard_trial_end` when RepuGuard was folded into
every plan. `organizations` now has no `repuguard%` column at all.

**This does not shrink the generated-types item above — it grows it.**
`types/database.generated.ts` is now stale by six columns on `organizations`:
one missing (`stripe_event_at`) and five declaring columns that no longer
exist. `types/database.ts` is correct, so CI stays green, but the regeneration
commit is now worth more than when it was first logged.

---

## 22. The Kroger cart does not build itself — it waits for a PM button press

**Files:** `lib/inngest/functions/inventory-events.ts`
(`handleInventoryCountSubmitted`), `lib/inngest/functions/build-shopping-cart.ts`,
`app/(dashboard)/inventory/actions.ts` (`triggerShoppingCart`)

**Deferred deliberately — the button is acceptable for launch** (product owner,
2026-08-07). Logged so the gap between the stated promise and the shipped
behaviour is written down rather than rediscovered.

CLAUDE.md's "core automation promise" states it flatly:

> When inventory drops below par, a Kroger cart builds itself.

It does not. Found while auditing the crew inventory screen against the
intended flow (crew counts → below par → PM email, immediate for a same-day
flip and aggregated otherwise → Kroger cart when connected).

**What actually happens.** `handleInventoryCountSubmitted` applies the count,
computes below-par items, creates the `purchase_orders` row, and emails the PM.
It sends **no Inngest events at all** — verified by grep, the function body
contains zero `inngest.send`/`sendEventAsync` calls.

The only sender of `inventory/cart_requested` anywhere in the repo is
`triggerShoppingCart()` in `app/(dashboard)/inventory/actions.ts`, whose only
caller is a "Build Cart" button at `app/(dashboard)/inventory/inventory-manager.tsx:1231`.

So the PM must notice the restock email, open the inventory page, and press a
button. Everything downstream of that press is correct and already hardened —
`buildShoppingCart` checks `preferred_retailer === 'kroger'`, checks the OAuth
connection and location id, and no-ops cleanly when either is missing, which is
exactly the "no Kroger account connected → email only" branch of the flow.

**Why this was not just implemented.** It writes to the customer's REAL Kroger
cart. That function's own header comment records a past incident:

> A PM double-clicking "Build Cart" produced two concurrent runs, each of which
> added the same items to the REAL Kroger cart — real duplicate grocery spend.

Auto-firing it on every crew count submission across every property is a
materially different risk and load profile from a deliberate button press, so
it is a product decision rather than a defect fix.

**What it would take.** Send `inventory/cart_requested` from
`handleInventoryCountSubmitted` after the purchase order is created, gated on
the org having Kroger connected, scoped to the single `property_id` the count
came from. The duplicate-protection already exists and does not need building:
`buildShoppingCart` has a per-org concurrency limit of 1 plus a content-keyed
milestone claim in its step 6. The pieces to think about before shipping it:

- **Fan-out.** One event per count submission, per property. A 50-property org
  doing evening turnovers submits ~50 counts in a window; the per-org
  concurrency limit of 1 serialises them, which is safe but slow, and each run
  currently emails the PM a "your cart is ready" notice.
- **Whether the PM wants a cart per property or one merged cart.** The existing
  button already supports both — `triggerShoppingCart()` takes `propertyIds`
  and a `modality`. An automatic trigger has to pick one, and per-property is
  the natural fit for the event but probably not what a PM wants to receive.
- **The same-day-flip distinction.** The email path already treats a same-day
  flip as urgent and everything else as end-of-day aggregate. An automatic cart
  build plausibly wants the same split rather than firing on every count.
- **A kill switch.** Anything that spends money automatically should be gated
  on an org-level setting, the way `SMS_ENABLED` gates sends, rather than being
  unconditional on deploy.

---

## 23. The crew device's cached turnover set is unbounded — and local pruning cannot fix it

**Files:** `lib/dexie/sync/turnovers.ts` (`fetchAssignedTurnoverIds`),
`lib/dexie/prune.ts` (`pruneLocalCache`), `lib/dexie/sync/assets.ts`
(`computeAssignedPropertyIds`)

Found during the Dexie sync audit (2026-08-07). Not fixed here because the
remedy is a RETENTION POLICY decision — how far back a crew member can open a
finished turnover offline — not a defect fix, and getting it wrong deletes
work off a phone.

**The finding.** `fetchAssignedTurnoverIds()` reads `turnover_assignments`
for the crew member with **no date bound and no status filter**:

```ts
supabase.from('turnover_assignments').select('turnover_id').eq('crew_member_id', crewMemberId)
```

Every turnover they have ever been assigned stays in the assigned set forever,
because a completed turnover keeps its assignment row (`cancelTurnoversForBooking`
doesn't remove them either — see item 22's neighbour finding). So
`reconcileRemovedTurnovers()`, which removes anything NOT in the assigned set,
never removes finished work.

Everything scoped to that set grows with it:

| Table | Scoped to | Grows? |
|---|---|---|
| `turnovers` | assigned set | yes |
| `checklist_instances` / `checklist_instance_items` | assigned set | yes |
| `properties`, `inventory_items` | ALL cached turnovers (`syncScopeReferenceData`) | yes |
| `property_assets` | ACTIVE turnovers only (`computeAssignedPropertyIds`) | pulled narrow, pruned wide → over-retained |

`prune.ts`'s own header says it exists because "everything else is bulkPut-only
and therefore grows without bound on a device that stays logged in for months."
It fixed `messages`. This is the same problem one level up: the pruning that
does exist is scoped to a set that itself never shrinks.

**Evidence.** Production is pre-launch small, but already lopsided: 19
`turnover_assignments` rows, of which **12 (63%) point at completed or
cancelled turnovers**, and 324 `checklist_instance_items` sit on completed
turnovers. Extrapolating from that ratio — ~27 checklist items per turnover — a
crew member doing 3 turnovers a day accumulates roughly 1,100 turnovers and
~30,000 checklist-item rows per year, none ever removed, plus the properties,
inventory items and assets behind them.

The consequence is the one this file already documents for orphaned photo
blobs: storage pressure, then the browser evicts the origin, and **the mutation
outbox goes with it**. Same catastrophic ending, different road.

**The trap: pruning locally does NOT work.** The obvious fix — delete finished
turnovers older than N days from Dexie — thrashes. `partitionByKnown()` splits
the assigned set into "known" (already cached, delta-pulled) and "fresh" (not
cached, pulled in FULL with no cursor). A turnover pruned locally but still in
the assigned set is by definition not cached, so the very next `fullCrewResync`
classifies it as fresh and pulls the whole row back — along with its checklist
instances and items, which take the same known/fresh split. Delete, re-pull,
delete, re-pull, every safety-poll tick, forever. Anyone who tries the local-GC
approach first will lose an afternoon to this.

**So the bound has to be on the assignment query itself**, so an old finished
turnover is not in the assigned set at all — at which point the existing
`reconcileRemovedTurnovers()` removes it and its checklists for free, and
`pruneLocalCache()`'s property scope shrinks on its own with no change.

**What has to be decided first:**

- **The window.** The crew list renders `today .. today+7d`
  (`app/crew/page.tsx`), so a lookback of a week or two preserves everything
  the UI can actually reach. Anything shorter starts deleting turnovers a crew
  member could still navigate to; anything much longer barely bounds it.
- **The safety condition, which is not optional.** A turnover must NEVER leave
  the device while an outbox mutation still references it or its checklist
  rows — pending OR dead-lettered. `shadowPendingMutations()` replays those
  over every pull, and `FailedSyncBanner` is built on them; dropping the cached
  row underneath a queued write destroys both the retry affordance and the
  crew member's most recent truth.
- **Whether the detail page needs a read-only past view.** With the window in
  place, opening an old completed turnover hits the "no longer assigned to
  you" state added 2026-08-07. That is honest but may not be the desired
  product answer for work finished last month.

**Also worth folding in when this is done:** the three scopes above disagree.
`computeAssignedPropertyIds()` filters out completed/cancelled;
`syncScopeReferenceData()` and `pruneLocalCache()` do not. The direction is
safe today (assets are pulled narrow and pruned wide, so they are
over-retained, never lost), but once the assigned set is bounded, all three
should be derived from one helper rather than three hand-rolled sets.

---

## 24. Guest SMS opt-in stores no evidence of the consent it relies on

**File:** `app/actions/guidebook.ts` (`optInGuestSms`), table
`guidebook_guest_sms_optins`

Found during the guidebook audit (2026-08-07). Not fixed here: it needs a
migration, and what to retain is a legal question rather than an engineering
one.

The consent LOGIC is careful — STOP is honoured globally by phone across every
org and booking, re-consent is restricted to the handset (START/YES/UNSTOP),
the revocation record is deliberately kept forever by
`guest-pii-retention`, and a degraded consent read fails closed. What is
missing is the EVIDENCE.

`guidebook_guest_sms_optins` holds `phone_e164`, `opted_in_at`,
`opted_out_at`, `is_active` and the send bookkeeping — and nothing about the
consent event itself:

- no record of the disclosure text the guest was actually shown (it lives only
  in `app/g/b/[token]/opt-in/opt-in-client.tsx`, and changing that copy leaves
  no trace of what earlier opt-ins agreed to)
- no IP address or user agent
- no record of which guidebook token was used

Under TCPA the burden of proving prior express written consent sits with the
sender. Today the strongest evidence FieldStay could produce for a disputed
opt-in is a row saying a number opted in at a timestamp — with no way to show
what was on screen when it happened, and no way to distinguish the guest from
anyone else holding the booking's guidebook link.

**Why it was not just added.** Storing an IP and user agent against a phone
number is itself a PII expansion, and `guest-pii-retention` currently deletes
opt-in rows (except revocations) on a schedule — so consent evidence would
need its own retention rule, probably a longer one than the PII it sits
beside. That is a decision for whoever owns the compliance posture, not a
default to pick while auditing.

**If it is taken on**, the shape that fits the existing design: a
`consent_disclosure_version` (or the literal text hash) written alongside
`opted_in_at`, plus request metadata, and an explicit carve-out in
`lib/inngest/functions/cron/guest-pii-retention.ts` so consent records outlive
the guest data they attest to — mirroring how revocations are already exempt
from that sweep.

**Adjacent, already fixed 2026-08-07:** the 15-minute number-correction window
was measured from `opted_in_at`, which the upsert refreshes on every
submission, so the window restarted on each resubmit and could be walked
forward indefinitely. It now anchors on the immutable `created_at`.

---

## 25. The Inngest route serves on every deployment, so preview builds run production background jobs

**Files:** `app/api/inngest/route.ts`, `lib/env.ts`

Vercel's Inngest integration syncs *every* deployment, previews included. Each
synced app registers the full function list, and Inngest fans every event and
every cron to every registered app. So each surviving preview deployment is
another complete copy of the platform's background workload, pointed at
whatever infrastructure its env vars name.

**Observed 2026-08-09**, not hypothetical:

- `asset-health-org` ran on preview release `c8e1b3d9` at 12:31:36 UTC
  (`environment: preview`, host `fieldstay-kbvqf0p3h-….vercel.app`) and failed
  writing scores. It had rows to write — and the E2E project has 0 active
  assets and 1 org, so that preview build was reading and writing the
  **production** Supabase project with a production service-role key.
- On 2026-08-08 at 23:01, **two different preview releases** (`7dcd0e9a`,
  `b036ab16`) both ran `daily-wrapup-org` against the production Resend
  account. That is the whole of CUSHION-F/G: not an idempotency bug in our
  code, but N deployments racing on one idempotency key. Sentry issues
  CUSHION-J/K/M, D/E/H and F/G are all this same cause.
- It was survivable only by luck. The pre-fix `persistScores` write failed
  100% of the time (see the RPC note in `cron/asset-health-helpers.ts`), so
  the preview copies of that cron could not corrupt anything. Nothing gave
  the same protection to the functions that were succeeding.

**Gate crons only and it does not work.** `daily-wrapup-org` is EVENT-triggered.
Inngest delivers an event to every synced app, so a cron-only gate would have
left the Resend collision exactly as it is. The gate has to be on *serving*.

**Why the env-var fix is not sufficient on its own.** Removing the Inngest keys
from preview does close this, and should be done first because it is
immediate. But environment scope is a dashboard setting that fails OPEN: one
variable re-added by someone who does not know this history silently restores
the entire problem, and no code review would ever see it. A route gate fails
closed and shows up in a diff.

Note also that the three Supabase vars are tier `always` — unsetting them on
preview makes every preview deploy refuse to boot at
`instrumentation.ts#register()`. The env-side fix for those is to point preview
at the E2E project (`syhthijeqlnltufdawyb`), not to unscope them.

**Suggested fix.** Keep the single `serve()` call and gate its exports:

```ts
const handlers = serve({ client: inngest, functions: [ ...unchanged... ] })

// Non-production deployments must not register with Inngest: an app that
// never completes the sync handshake receives neither crons nor events.
const mayServe =
  resolveDeployTarget() === 'production' ||
  process.env.INNGEST_ALLOW_NON_PRODUCTION === 'true'

const refuse = () =>
  new Response('Inngest is served from production deployments only', { status: 403 })

export const GET  = mayServe ? handlers.GET  : refuse
export const POST = mayServe ? handlers.POST : refuse
export const PUT  = mayServe ? handlers.PUT  : refuse
```

`resolveDeployTarget()` already exists in `lib/env.ts` and checks `VERCEL_ENV`
first, so the `FIELDSTAY_ENV_TARGET` escape hatch cannot downgrade a real
production deploy into skipping the gate.

Two constraints on whoever picks this up:

- `unit/guardrails/forbidden-patterns.test.ts` counts `/=\s*serve\(/g` and
  requires exactly 1. `const handlers = serve({...})` still satisfies that, and
  CLAUDE.md's "exactly ONE serve() call" rule is preserved — but the prose in
  CLAUDE.md's Inngest section names the destructured-export form specifically
  and should be updated to match.
- `INNGEST_ALLOW_NON_PRODUCTION` must be added to `ENV_SPEC` in `lib/env.ts`
  (tier `optional`) in the same change, or
  `unit/guardrails/env-schema-coverage.test.ts` fails on the drift.

**Cost to accept.** Previews lose background-job testing entirely — any preview
flow calling `inngest.send()` fails. If that matters, the better answer is an
Inngest **branch environment** for preview rather than the shared production
one, which fixes isolation without giving the capability up.

---

## 26. Six Inngest steps still return a bearer token into execution history

**Status:** open, ratcheted. Enforced by
`unit/guardrails/inngest-history-secrets.test.ts` — the BASELINE below is
shrink-only, so nothing new can join it, but nothing prunes it automatically
either.

**What it is.** An Inngest step's return value is persisted as execution
history and rendered in a third-party console — durable storage outside this
system, the same as Axiom and Sentry. Six steps return a bearer credential for
an UNAUTHENTICATED route:

| File | Column | What the token opens |
|---|---|---|
| `lib/inngest/functions/guidebook-guest-opted-in.ts` | `guidebook_token` | `/g/b/<token>` — the guest portal |
| `lib/inngest/functions/guidebook-stay-extension-handler.ts` | `guidebook_token` | same |
| `lib/inngest/functions/guidebook-pre-arrival-email-cron.ts` | `guidebook_token` | same |
| `lib/inngest/functions/work-order-dispatch.ts` | `stripe_connect_token` | a vendor's Stripe Connect onboarding link |
| `lib/inngest/functions/work-order-events.ts` | `stripe_connect_token`, `quote_token` | same, plus the vendor quote portal |
| `lib/inngest/functions/cron/vendor-connect-onboarding.ts` | `stripe_connect_token` | same |

**Why it is open rather than done.** `work-order-vendor-assigned.ts` was fixed
in the same change that added the guardrail (2026-08-09) and is the reference
shape; the remaining six are the same edit six times, but each one moves a read
into a different consuming step and needs its own test-double sequence updated.
Batching them was judged worse than leaving a visible, enforced list.

**The fix, per file.** Stop selecting the token in the step that returns. Read
it inside the step that consumes it, via a small primary-key helper, and return
a boolean if the caller only needs to know whether it exists. See
`readPublicUrl()` / `readVendorContact()` in
`lib/inngest/functions/work-order-vendor-assigned.ts`.

**When you fix one, delete its BASELINE entry in the same change.** The
guardrail asserts every entry is still an offender, so a fixed file left in the
list fails CI — that is deliberate, and it is what stops the list rotting into
a permanent allowlist.

**What this is NOT.** `door_code_secret_id` appears in two step returns and is
excluded on purpose: it is a Vault secret *identifier*, redeemable only with
service-role Vault access, not a bearer credential. The decrypted door code it
points at is already handled correctly — `guidebook-guest-opted-in.ts` decrypts
it inside the sending step and never returns it, which is the comment that made
this whole class visible in the first place.

---

## 27. GDPR export still builds synchronously on the request thread

**Status:** open by decision, with a runtime trigger. Not enforced by a test —
the signal is a log line, deliberately.

**What it is.** `GET /api/gdpr/export` assembles the whole Article 15 payload
and `JSON.stringify`s it inside the request. Scalability audit P2-14 proposed
moving it to an Inngest job that writes to Storage and returns a signed URL,
the same shape as the CPA export.

**Why it is not done.** The audit's own text says the route is "bounded today"
and the risk is "any future cap increase". Rebuilding it now means a new table,
a Storage bucket, an Inngest function and a polling/emailed-link UI — and it
makes every export slower and more failure-prone, for volumes no account is
near. Production's largest history series is orders of magnitude below the
ceiling.

**What was done instead (2026-08-10).** The real defect in that route was not
scale, it was honesty. The series were `.limit(500)` / `.limit(200)`, which
silently dropped rows from a right-of-access response — "all the personal data
we hold about you" quietly meaning "the most recent 500 events", with nothing
in the payload or the logs saying so. They now page to completeness under a
`HISTORY_ROW_CEILING` of 5,000 per series, and crossing it is disclosed twice:
a `completeness` block in the payload (always present, not only when it fires,
so consumers actually build against it) and a `console.warn`.

**The trigger.** That warn line IS the signal to do this work:

```
[gdpr/export] user <id> hit the 5000/series ceiling — export returned partial and said so
```

When it starts appearing, the synchronous build has outgrown the request
thread and the async job becomes the right call. Until then it is speculative
complexity. Do not raise `HISTORY_ROW_CEILING` as the fix — raising it is the
thing the ceiling exists to prevent someone doing by reflex.
