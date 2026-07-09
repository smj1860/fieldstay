# Future Remediation

Known gaps identified during self-audits that have **not** been fixed yet —
either lower priority than what was in progress at the time, or needing a
bit more design than a one-line change. Each entry has enough context to
pick back up without re-deriving the finding from scratch.

---

## 1. `checklist_instances_crew_update` RLS policy isn't column-scoped

**File:** `supabase/migrations/20260708234410_checklist_inventory_confirmation.sql`

The crew `UPDATE` policy on `checklist_instances` is gated only on
`turnover_id` (via `turnover_assignments` → `crew_members` → `auth.uid()`).
It was added so crew could write `completed_at`/`completed_by_crew_id` for
"Confirm Checklist Complete", but Postgres RLS is row-level, not
column-level — a crew session calling Supabase directly (outside the app's
own UI, which does allowlist the fields it sends in
`lib/dexie/syncService.ts`) could legally overwrite any column on a row
it's allowed to touch, including `org_id`, `template_id`, `template_snapshot`,
or `status`.

This mirrors the pre-existing `checklist_instance_items` crew policy's
shape exactly, so it's consistent with established precedent, not a new
deviation — but it's a real gap worth closing.

**Suggested fix:** a `BEFORE UPDATE` trigger (`SECURITY DEFINER`, same
pattern already used in this migration for
`set_checklist_instance_started_at`) that rejects or reverts changes to
protected columns when the acting role is a crew member and not a PM.

---

## 2. `ensureVendorConnectInvited` has a TOCTOU race across its three callers

**File:** `lib/stripe/vendor-connect-invite.ts`

> **Update:** the single-invocation partial-failure case (a Resend failure
> orphaning the just-created Stripe account, because `stripe_connect_account_id`
> was only persisted *after* the email send, in a combined update with
> `stripe_connect_invite_sent_at`) has been fixed — the account id is now
> persisted immediately after creation, and the completion check is based
> solely on `stripe_connect_invite_sent_at`, so a retry reuses the existing
> account instead of creating a second one. The **concurrent-invocation**
> race described below is still open.

Re-reads the vendor row fresh before acting, but there's no lock between
that read and the `stripe.accounts.create()` + email send + `UPDATE`. It's
now called from three independent triggers:
- the nightly cron (`lib/inngest/functions/cron/vendor-connect-onboarding.ts`)
- work order dispatch (`lib/inngest/functions/work-order-dispatch.ts`)
- indirectly, the "Resend Payment Setup Email" button
  (`resendVendorConnectInvite` in `app/(dashboard)/vendors/actions.ts`,
  which shares the same read-then-act shape without the guard at all)

A vendor added and immediately dispatched a work order in the same window
the cron also picks them up — or a PM clicking "Resend" right as dispatch's
auto-invite fires — can create two Stripe Express accounts and send two
invite emails, with one account silently orphaned (last `UPDATE` wins on
`stripe_connect_account_id`).

**Suggested fix:** a partial unique index on `vendors` (e.g. on
`stripe_connect_account_id` where not null) won't prevent the double
`accounts.create()` call itself — better to serialize via
`SELECT ... FOR UPDATE` inside a transaction, or a Postgres advisory lock
keyed on `vendor_id`, wrapping the check-and-act in `ensureVendorConnectInvited`
and `resendVendorConnectInvite` both.

---

## 3. `DexieProvider`'s `useEffect` closure is doing too much (structural)

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

## 4. `SyncEngine.uploadOne()` growing via flat if-chains

**File:** `lib/dexie/syncService.ts`

Dispatches on 6 `table === '...'` branches (one, `checklist_instances`,
added most recently). Each branch is simple and non-nested — no individual
complexity/depth violation — but the function is trending toward the point
where a per-table handler map (`Record<string, (mutation) => Promise<void>>`)
would read more cleanly than sequential early-return `if`s. Not urgent;
worth doing the next time a 7th table is added.

---

## 5. Dev-mode CSP blocks Turbopack hydration — browser testing is broken repo-wide

**File:** `next.config.ts`

The `Content-Security-Policy` header (`script-src 'self' 'wasm-unsafe-eval'`,
no `'unsafe-inline'` or nonce) blocks Turbopack's inline hydration scripts
entirely in dev mode, producing
`PAGEERROR: Invariant: Expected a request ID to be defined for the document via self.__next_r`
and React never mounting. Confirmed by temporarily patching `headers()` to
return `[]` when `NODE_ENV !== 'production'` — the page mounted and worked
once that header was removed — then reverting the patch since it was only
for local verification, not a real fix to ship.

This means **no one can currently exercise the app in a browser against
`next dev`** without disabling the CSP locally first. Production is
unaffected (this is a dev-only symptom of the same header applying in both
modes).

**Suggested fix:** either add a nonce-based `script-src` that Turbopack's
dev-mode hydration script can use, or conditionally relax `script-src` to
include `'unsafe-inline'` only when `NODE_ENV !== 'production'`.

---

## 6. Vendor/compliance mutation actions don't check role, only org membership

**Files:** `app/(dashboard)/vendors/actions.ts` (all exports),
`app/(dashboard)/maintenance/actions.ts`, `app/(dashboard)/maintenance/work-order-actions.ts`

Every server action here starts with `requireOrgMember()`, which confirms
org membership but not role — so a `viewer` role member can currently call
`resendVendorConnectInvite`, `deleteComplianceDocument`,
`verifyComplianceDocument`, `bulkUpdateWorkOrderStatus`, etc., the same as
an `admin`/`manager`. This is a long-standing, app-wide pattern (not
introduced by any of the recent vendor-payment work) — flagging it here
because it came up while auditing those same files, not because it's new.

**Suggested fix:** decide whether `viewer` should be read-only across the
app and, if so, add an `is_org_member(org_id, ARRAY['admin','manager'])`-style
role check (matching the RLS convention already used at the DB layer) to
each mutating action — probably worth doing as one pass across the whole
`app/(dashboard)` actions surface rather than file-by-file.

---

## 7. Hospitable: `reservation_messages` is collected but has no UI

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

## 8. Hospitable: crew sync visibility and doc accuracy gaps

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

## 9. OwnerRez: webhook delivery payload shape never verified against a real event

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

## 10. OwnerRez: no reconciliation for hard-deleted bookings/holds

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

## 11. OwnerRez: unconfirmed property detail field names

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

## 12. OwnerRez: orphaned marketplace-install artifacts are never cleaned up

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
