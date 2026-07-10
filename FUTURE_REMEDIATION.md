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
- `is_block` is hardcoded `false` for every Hospitable reservation — there's
  no confirmed way to detect a manually-blocked calendar date via
  Hospitable's API, so a PM's manual block won't suppress a turnover or show
  as blocked in FieldStay. Honestly documented in code, never mentioned to
  customers.
- Zero automated test coverage on anything I/O-bearing (sync orchestration,
  webhook handling, token refresh) — only the pure property/reservation
  mapping functions are unit-tested.

---

## 5. OwnerRez: webhook delivery payload shape never verified against a real event

**File:** `lib/integrations/providers/ownerrez.ts` (`handleWebhookEvent`,
`~line 185-231`), `lib/integrations/providers/ownerrez-api.ts`
(`registerWebhookSubscriptions`, `~line 285-311`)

FieldStay registers webhook subscriptions with OwnerRez using dot-notation
event types (`booking.created`, `booking.modified`, `guest.updated`, etc.),
but `handleWebhookEvent`'s switch only recognizes a generic
`entity_insert`/`entity_update`/`entity_delete` envelope with a separate
`entity_type` field. Git history shows an earlier version of this file
switched directly on the dot-notation names instead — the current shape
replaced it with no comment citing a confirmed real payload sample. If
OwnerRez's actual delivery echoes the subscription name literally rather
than the assumed generic envelope, every booking/guest webhook silently
hits the `default: unknown action` branch and does nothing — no error, just
a `console.warn`.

**Impact is bounded**, not data-loss: the 15-minute incremental-sync cron
and 6-hour reviews cron don't depend on webhooks at all, so the worst case
is "near-real-time sync via webhook silently never fires, data still
arrives within 15 minutes via cron" rather than anything going missing.
Still, any customer-facing claim of "instant" or "real-time" sync should be
verified against an actual captured OwnerRez webhook payload (e.g. via
Vercel logs after a real booking change) before being taken at face value.

**Suggested fix:** capture one real webhook delivery for each subscribed
event type, confirm the actual field names, and add the same kind of
"✅ Confirmed live" annotation this codebase already uses for Hospitable's
adapter once verified.

---

## 6. OwnerRez: no reconciliation for hard-deleted bookings/holds

**File:** `lib/inngest/functions/ownerrez/incremental-sync.ts`

`handleWebhookEvent` treats `entity_delete` as distinct from
`entity_insert`/`entity_update`, implying OwnerRez can hard-delete a
booking or quote-hold record — but `incremental-sync.ts` has no code path
that ever detects or reconciles a record disappearing from OwnerRez; it
only upserts whatever `getBookings(since_utc)` currently returns.
Cancellation (the common case) is handled correctly as a status change and
excluded from turnover generation. But if OwnerRez ever truly hard-deletes
a quote-hold/block rather than cancelling it, and the `since_utc`-filtered
list endpoint omits deleted records (typical REST behavior), the stale
`status:'blocked'` row would persist in FieldStay indefinitely — showing
the property as unavailable on the calendar/owner portal with nothing to
ever clear it.

**Suggested fix:** periodically reconcile FieldStay's `blocked` bookings
against a fresh `properties[]`-scoped fetch and mark ones no longer present
upstream as resolved, or confirm with OwnerRez support whether hard deletes
of holds/blocks are actually possible before treating this as live risk.

---

## 7. OwnerRez: unconfirmed property detail field names

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

## 8. OwnerRez: orphaned marketplace-install artifacts are never cleaned up

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

## 9. `repuguard/activated` event is defined but never wired to anything

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

## 10. `billing/subscription-updated` is sent but has zero consumers

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

## 11. Hospitable reservations sync window is a diagnostic stopgap, not a real design

**File:** `lib/integrations/providers/hospitable.ts` (`hospFetchReservations()`)

Found and partially fixed live on 2026-07-10: `GET /reservations` with
`start_date = today − 90 days` and no `end_date` returned `meta.total: 0`
for a real, listed, in-window (checkin 5 days out) test reservation —
consistently, regardless of the `status[]` filter. Our own doc's note
that `start_date` "defaults to next 2 weeks if omitted" was the tell —
this endpoint applies a forward-looking window sized relative to
`start_date`, not an open "everything since `start_date`" range, so a
90-day-in-the-past `start_date` put the entire query window in deep
history. Shrinking the lookback to 7 days immediately fixed it — the
same reservation, and 3 others, synced correctly with real
`financials.host.revenue` data on the very next attempt.

**This is a real, customer-impacting bug that predates today** — every
existing Hospitable-connected org's *initial* sync (first connect, or
"resync everything") would have missed essentially all upcoming/current
reservations, only ever surfacing ones from roughly 76–90 days in the
past. Ongoing bookings that received any qualifying webhook update after
connection would still have synced correctly via the incremental path
(which fetches a single reservation by ID with no date filter at all,
unaffected by this bug) — so the practical damage is bounded to bookings
that existed at connection time and never changed since, not a total
loss, but still a real gap for any org that connected and relied on
initial sync alone.

**The 7-day lookback is a diagnostic fix, not a considered design** — it
unblocked testing but:
- Caps how far *forward* upcoming reservations sync (fine today since
  each new/changed reservation still arrives via webhook regardless, but
  worth confirming there's no forward cap symmetrically biting the same
  way the backward one did).
- Removes any deep-history coverage entirely — if revenue backfill for
  older stays ever matters, this needs a second, explicit
  historical-range call, not folded into the same window.

**Suggested fix:** decide the real requirements (how far forward does
initial sync need to reach for upcoming turnovers to generate correctly?
does historical revenue backfill matter, and if so how far back?) and
implement as two explicit calls if both are needed, rather than one
window trying to serve both purposes. Also worth confirming with
Hospitable/Patrick whether there's a documented maximum window size
`start_date` implies, since our own docs' "next 2 weeks" phrasing is the
only hint we have and hasn't been directly confirmed as an exact rule.

---

## 12. Dashboard layout and `requireOrgMember()` are two independent implementations of the same lookup

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
