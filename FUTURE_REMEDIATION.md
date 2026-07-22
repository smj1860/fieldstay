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

## 2. `SyncEngine.uploadOne()` growing via flat if-chains

**File:** `lib/dexie/syncService.ts`

Dispatches on 6 `table === '...'` branches (one, `checklist_instances`,
added most recently). Each branch is simple and non-nested — no individual
complexity/depth violation — but the function is trending toward the point
where a per-table handler map (`Record<string, (mutation) => Promise<void>>`)
would read more cleanly than sequential early-return `if`s. Not urgent;
worth doing the next time a 7th table is added.

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

## 8. `repuguard/activated` event is defined but never wired to anything

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

## 9. `billing/subscription-updated` is sent but has zero consumers

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

---

## 10. Dashboard layout and `requireOrgMember()` are two independent implementations of the same lookup

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

**Status: undecided** — open question is whether Supabase Auth's built-in
limiting is sufficient as-is, or whether FieldStay should add its own
app-level throttling on top. Not yet resolved either way; no code change
made pending that decision.

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

**Suggested fix (pending the decision above):** if Supabase's built-in
limits are judged insufficient, add an app-level pre-check — e.g. a Server
Action wrapper that rate-limits by IP/email before calling the Supabase
client — for tighter, FieldStay-controlled throttling.

---

## 12. `crew/feedback` sends its notification email outside Inngest, un-awaited

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

---

## 13. Migration filename timestamps vs. recorded applied versions have drifted

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
