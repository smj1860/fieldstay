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

```text
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

## 21. Core-billing webhook can write entitlement to a different org than it notifies

**File:** `app/api/webhooks/stripe/handlers/core-billing.ts`,
`resolveSubscriptionOrg()` / `applySubscriptionUpdate()` /
`handleCoreSubscriptionUpdate()` (around lines 115–255, 289–322)

Flagged by CodeRabbit on PR #542. `resolveSubscriptionOrg()` resolves the org
by subscription metadata first, customer id second, and returns it as `org`.
`applySubscriptionUpdate(supabase, org, customerId, ...)` then calls
`update_organization_subscription_from_stripe`, an RPC that does its own
independent lookup **keyed on `p_customer_id`**, not on `org.id` — the two
resolutions are not guaranteed to agree. The RPC's own fallback comment
(lines 225–236) already documents that they *can* disagree: "org already
carrying a DIFFERENT customer id, where the backfill deliberately no-ops."

When they disagree, `applySubscriptionUpdate` writes entitlement fields
(plan, plan_status, max_properties, trial_ends_at) to whatever org the RPC's
customer-id lookup found — call it org B — and returns org B's
`previous_plan`. But `handleCoreSubscriptionUpdate` (line 289 onward) keeps
using `org` — org A, the metadata-resolved one — for the
`billing/subscription-updated` Inngest event, the audit log entry, and the
trial/payment emails. Org A gets notified of a plan change it didn't
actually receive; org B silently has its entitlement changed with no event,
no audit row, and no email.

**Why not fixed here:** this needs an explicit reconciliation policy, not a
mechanical patch. The RPC is the source of truth for what actually got
written (it holds the row lock), so the natural fix is having
`applySubscriptionUpdate` return the RPC's own `org_id`/`org_name` and using
*that* for every downstream side effect instead of the pre-resolved `org` —
but that changes behavior for the (hopefully large) majority of calls where
the two agree, and needs to handle the "RPC found nothing, fell back to a
direct update on org.id" branch (lines 233–250) consistently too, since that
branch's write target and the side effects' target are already the same
(`org.id`) and must stay that way. It also deserves a regression test that
mocks the RPC to return a *different* `org_id` than the metadata-resolved
one and asserts the notification fires for the RPC's org — the existing
`unit/webhooks/core-billing-subscription-update.test.ts` mocks always agree
on `org_id`, so this class of bug wouldn't be caught by the current suite.
Given this is live billing/entitlement code with multiple interacting fixes
already layered on it (see the comment block at lines 274–288), it's a
"heavy lift" per CodeRabbit's own label and warrants a dedicated pass rather
than a drive-by change.
