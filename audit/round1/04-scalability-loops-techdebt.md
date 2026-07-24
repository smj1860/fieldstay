# Scalability / Loops / Silent Failures / Tech Debt Audit

> **ARCHIVED — superseded by `audit/` Round 2. Findings here reflect the codebase as of 2026-07-13 and should not be read as current state.**

Status: COMPLETE
Last checkpoint: Reviewed all lib/inngest/functions/cron/*.ts, ownerrez/hostaway sync functions, geocoding-backfill.ts, account deletion route, Telnyx webhook, inventory/capital-planning dashboard pages, turnover-board/turnover-gantt, GDPR export route, crew API routes, and ~20+ dashboard/crew client components (owners-manager, inventory-manager, assets-board, bookings-client, crew-manage-client, integrations-client, settings-tabs, messages clients, reviews-client, maintenance-board, guidebook-client, crew work-order completion page) via a combination of direct reads and a delegated sub-agent pass.
Next: None — audit complete. Remaining untouched files (small modals/buttons/banners: ical-form.tsx, crew-setup.tsx, trigger-projections-button.tsx, trigger-ledger-button.tsx, reset-password-form.tsx, dashboard-shell.tsx, session-refresh-guard.tsx, cookie-notice.tsx, time-off-request.tsx, install-banner.tsx, RepuGuardSandbox.tsx, onboarding modals, crisp-widget.tsx, dashboard-toast-provider.tsx) are judged low-yield based on the consistent pattern of clean results in structurally similar small UI components reviewed so far, and are not expected to contain scalability/N+1/silent-failure issues of note. A non-finding worth noting for future review: crew-shell.tsx polls the Dexie outbox sync on a fixed 30-second interval with no exponential backoff — low impact (bounded local polling, not a DB/API hot loop) so not written up as a standalone finding.

## Findings

### Finding 1: Unbounded per-property + per-gap N+1 query loop in vacancy-gap maintenance suggestions
- File: lib/inngest/functions/cron/maintenance-schedules.ts:365-423 (step `find-vacancy-gaps`), and lib/maintenance/vacancy-suggestions.ts:25-48
- Severity: High
- Issue: Fetches ALL active properties org-wide with no `.limit()` (`properties` table, `.eq('is_active', true)`), then for EACH property issues a separate `bookings` query (line 380-386), and then for EACH booking-gap within that property's bookings calls `findMaintenanceCandidatesForWindow(supabase, ...)` (line 400-405) which itself issues a `maintenance_schedules` query per call. This is N+1 two levels deep: O(properties) booking queries + O(properties * gaps) maintenance_schedules queries, all sequential `await`s inside nested `for` loops. At 50 properties with active bookings this could be hundreds of sequential round trips inside one `step.run`, with no batching and no `.limit()` anywhere in the chain. Also a step-timeout risk: Inngest steps have a max execution duration, and this single step covers every org's properties in one unmemoized unit — a slow run loses all progress on retry (the whole step re-runs from scratch).
- Confirmed: Yes — read directly. `for (const property of properties ?? [])` → `await supabase.from('bookings')...` → nested `for (let i = 0; i < bookings.length; i++)` → `await findMaintenanceCandidatesForWindow(...)` → another `await supabase.from('maintenance_schedules')...` inside that helper.
- Fix: Batch the `bookings` query for all property IDs at once (`.in('property_id', propertyIds)`) and group in memory — the same pattern already used a few lines later in this same file for `find-pm-emails-gaps` (batched `getPmEmailsByOrgIds`). Similarly batch `maintenance_schedules` lookups by fetching all active schedules for the relevant properties up front and filtering in-memory per gap window, rather than querying per gap.

### Finding 2: Sequential per-property OwnerRez API detail fetch inside one unmemoized step
- File: lib/inngest/functions/ownerrez/initial-sync.ts:242-319 (`fetch-property-details` step)
- Severity: Critical
- Issue: `for (const dbProp of dbProperties)` calls `client.getPropertyDetail(orId)` sequentially per property plus a hardcoded 150ms sleep per iteration, all inside a single `step.run`. For a host with 200+ properties this is 30s+ of sequential external API calls inside one non-resumable step. If the step times out or the function retries, ALL prior successful detail fetches are discarded and re-run from scratch (no incremental checkpointing within the step), wasting OwnerRez API quota and increasing the chance of hitting OwnerRez rate limits on every retry.
- Confirmed: Yes, per sub-agent review of the full file.
- Fix: Split into one step per property (or per small batch) so Inngest memoizes progress, or use a concurrency-limited `Promise.all` to parallelize the safe (non-rate-limited) portion of the work.

### Finding 3: N+1 query pattern in OwnerRez incremental sync for owner-block property names
- File: lib/inngest/functions/ownerrez/incremental-sync.ts:204-248
- Severity: High
- Issue: Per-booking-row loop calls `findMaintenanceCandidatesForWindow` plus a separate `properties` SELECT per row (lines 216-220) inside a single `step.run`, with no `.in()` batching. `resend.emails.send` is also called sequentially per row in the same loop with no `Promise.all`, risking step-timeout for hosts with many simultaneous owner blocks.
- Confirmed: Yes, per sub-agent review.
- Fix: Pre-fetch all property names in one `.in()` query before the loop; batch email sends or fire via `step.sendEvent` fan-out instead of inline sequential sends.

### Finding 4: N+1 .update() per property instead of batched upsert
- File: lib/inngest/functions/ownerrez/initial-sync.ts:173-195 (patch-property-fields loop), and :354-359 (applyMasterChecklistToProperty loop)
- Severity: Medium
- Issue: Both loops perform one Supabase write per property sequentially instead of a single batched upsert with `.in()`/array payload. Unbounded for large portfolios (no `.limit()`); for orgs with 50+ properties this multiplies round trips linearly. Failures are at least collected here (not silently swallowed), which is good, but the query pattern itself is inefficient at scale.
- Confirmed: Yes, per sub-agent review.
- Fix: Batch `.update()` calls into a single `.upsert()` with an array of rows where the side effects allow it; where per-property side effects (e.g. checklist application) are unavoidable, consider fanning out via Inngest step concurrency rather than one mega-step.

### Finding 5: Hostaway/OwnerRez API clients' pagination behavior unverified — possible unbounded external API fetch
- File: lib/integrations/providers/hostaway.ts, lib/integrations/providers/ownerrez-api.ts (functions `getListings`/`getBookings`/`getProperties` called from lib/inngest/functions/hostaway/initial-sync.ts and ownerrez/initial-sync.ts)
- Severity: Medium (Suspected — needs verification)
- Issue: The Inngest sync functions call these client methods and hold the full result set in memory with no evidence of a page-count or result-count cap. If the underlying client methods auto-paginate without an upper bound, a host with a very large number of listings/bookings could cause large in-memory arrays and many sequential upstream API calls within one Inngest step.
- Confirmed/Suspected: Suspected — the API client implementations were not read in this pass.
- Fix: Verify pagination logic in lib/integrations/providers/hostaway.ts and ownerrez-api.ts; ensure a sane upper bound or cursor-based incremental processing.

### Finding 7: Unbounded inventory queries on main Inventory dashboard page
- File: app/(dashboard)/inventory/page.tsx:28-33, 57-63, 69-81
- Severity: Medium
- Issue: Three of the eight parallel queries on the Inventory page have no `.limit()`: `items` (all `inventory_items` for the org, line 28-33), `allInventoryItems` (a near-duplicate full `inventory_items` fetch with a join to `properties`, line 57-63 — note this duplicates the `items` query above almost entirely, just with different columns/ordering, doubling the read cost), and `pendingDrafts` (all `inventory_count_drafts` with status `pending_review`, including nested `inventory_count_draft_items` joins, line 69-81). Other queries on the same page (`purchaseOrders`, `recentCounts`) were correctly capped with `.limit(20)`/`.limit(50)`. For an org at the 50-property ceiling with ~20-50 inventory items per property, `inventory_items` alone could return 1000-2500 rows fetched twice per page load, and `pendingDrafts` has no bound on accumulated unreviewed counts over time.
- Confirmed: Yes, read directly.
- Fix: Add `.limit()` to `items`/`allInventoryItems` (or better, eliminate the duplicate query — derive one view from the other in memory) and to `pendingDrafts`; consider pagination for inventory items the same way comms-log/page.tsx already does (it uses `PAGE_SIZE = 100` with `.range()` — a good pattern to copy here).

### Finding 9: Geocoding backfill — unbounded fetch + per-row sequential updates in one unmemoized step
- File: lib/inngest/functions/geocoding-backfill.ts:28-68, 70-110
- Severity: Low
- Issue: Both `geocode-properties` and `geocode-vendors` steps fetch ALL rows org-wide with no `.limit()` (`is('lat', null)`), then after geocoding unique zips, loop over every property/vendor row and issue one sequential `.update()` per row (lines 54-65, 96-107) instead of a batched `upsert`. This is intentionally a cross-tenant admin/ops-only function per the code comment, so the blast radius is limited to whoever triggers it, but at scale (thousands of properties never geocoded) this is still a single non-resumable step doing potentially thousands of sequential DB writes — a retry after partial failure re-runs the entire step's writes again (each `.update()` is idempotent so this is safe, just wasteful).
- Confirmed: Yes, read directly. Note the code already references "LOW-4" fixing the zip-dedup N+1 for the geocoding API calls themselves — the remaining per-row `.update()` write pattern was not addressed by that same fix.
- Fix: Batch the per-row updates using `.upsert()` with an array of `{id, lat, lng}` rows (one round trip) instead of one `.update()` per row; this is a one-time low-traffic ops function so severity is Low, but worth cleaning up given the adjacent fix already addressed half the problem.

### Finding 10: Minor O(n²) array scan in Hostaway initial sync
- File: lib/inngest/functions/hostaway/initial-sync.ts:91-94
- Severity: Low
- Issue: A `.find()` call inside a loop over `fsProps` to map back to `listings` produces O(n²) behavior for the property list. Not a DB query issue, but worth flagging as it degrades for large listing counts (100+).
- Confirmed: Yes, per sub-agent review.
- Fix: Pre-build a `Map<id, listing>` before the loop and do O(1) lookups.

### Finding 11: Account deletion proceeds even when Stripe subscription cancellation fails
- File: app/api/account/delete/route.ts:64-78
- Severity: Medium
- Issue: When an owner deletes their account, `stripe.subscriptions.cancel(...)` is wrapped in try/catch for both the main and RepuGuard subscriptions. On failure the error is only `console.error`'d — there is no rethrow, no abort, and no surfacing to the user. The function proceeds to delete the org owner's auth user (which cascades to org data via DB foreign keys per the code comment) regardless of whether the Stripe subscription was actually cancelled. This can leave an active, billable Stripe subscription with no corresponding FieldStay account/org to manage or cancel it from the product UI — a silent billing leak that has to be caught manually in the Stripe dashboard.
- Confirmed: Yes, read directly.
- Fix: If Stripe cancellation fails, either abort the deletion and return an error asking the user to retry (consistent with the explicit 409 returned a few lines above for unresolved org members), or queue a reliable async retry (e.g. an Inngest function) for the Stripe cancellation before allowing the auth user delete to proceed, so a transient Stripe API failure can't permanently orphan a paid subscription.

### Finding 12: Sequential per-connection integration token revocation on account deletion
- File: app/api/account/delete/route.ts:88-97
- Severity: Low
- Issue: `for (const conn of connections ?? [])` calls `revokeIntegrationToken(user.id, conn.provider_id)` sequentially with individual try/catch per iteration. Each failure is logged but does not abort the loop or the overall deletion — acceptable for not blocking deletion, but for a user with many connected integrations this adds sequential latency, and a failed revoke is never retried or surfaced anywhere after the fact.
- Confirmed: Yes, read directly.
- Fix: Use `Promise.allSettled` to revoke all tokens concurrently instead of sequential awaits; consider logging failed revocations to `audit_events` (not just console) so they're discoverable later instead of only living in server logs.

### Finding 13: Telnyx webhook signature verification explicitly deferred — unauthenticated SMS opt-out/opt-in spoofing
- File: app/api/webhooks/telnyx/route.ts:1-9
- Severity: High
- Issue: The file's own comment states `// TODO: verify Telnyx webhook signature (ed25519) before processing — deferred for this session per CLAUDE_55_2 scope.` The route accepts any POST body, extracts a `from` phone number and message text, and toggles `guidebook_guest_sms_optins.is_active` for that phone number org-wide based on STOP/START keywords — with zero signature verification. Anyone who can guess or discover the webhook URL can spoof a payload claiming to be from any phone number and flip that guest's SMS consent flag (opt them out of compliance-relevant SMS, or fraudulently opt back in a number that asked to stop). This is the same class of issue CLAUDE.md flags as mandatory for Stripe ("Always verify signature. No exceptions.") but for Telnyx it is openly unimplemented.
- Confirmed: Yes, read directly — the deferral is explicitly admitted in a code comment.
- Fix: Implement Telnyx's documented ed25519 webhook signature verification (using the `telnyx-signature-ed25519` and `telnyx-timestamp` headers against the raw body) before trusting any field in the payload, mirroring the `stripe.webhooks.constructEvent()` pattern used elsewhere in this codebase. This is consent/compliance-sensitive data (SMS opt-in status under TCPA-adjacent rules), so the unauthenticated write path should be treated as a priority fix, not deferred further.

### Finding 14: Bulk work-order action handlers clear selection without checking for errors
- File: app/(dashboard)/maintenance/maintenance-board.tsx (bulk-action `onChange` handlers calling `bulkAssignVendor`/`bulkUpdateWorkOrderStatus`)
- Severity: Medium
- Issue: The bulk vendor-assign and bulk status-update `onChange` handlers call their respective server actions inside `startBulkAction` but never inspect the returned result for an error before calling `clearSelection()` — selection is cleared and the bulk-action bar disappears regardless of whether the action actually succeeded. At 50-property scale this is exactly the kind of multi-WO bulk operation a PM relies on; a partial failure (e.g. one WO already completed, a vendor deactivated mid-flight) is invisible — the PM has no indication anything went wrong and assumes the bulk update applied to all selected items.
- Confirmed: Yes, per sub-agent review.
- Fix: Check the server action's returned `{ error }`/`{ success }` shape before clearing selection; on error, keep the selection active and surface the error via the existing `assignmentWarning`-style toast pattern used in turnover-board.tsx.

### Finding 15: Review-response confirm action has no error handling — UI shows success on a failed write
- File: app/(dashboard)/reviews/reviews-client.tsx (`confirmPosted()`)
- Severity: Medium
- Issue: `confirmPosted()` performs a direct Supabase `.update()` with no error check at all. Regardless of whether the write succeeds, the code proceeds to call `updateReviewInList()` and show "Posted" in the UI. A real write failure (RLS rejection, network blip, stale row) leaves the database in a state that disagrees with what the PM sees on screen — the PM believes a guest review response was recorded as posted when it was not, with no way to discover the discrepancy except by manually re-checking the review later.
- Confirmed: Yes, per sub-agent review.
- Fix: Check `{ error }` from the `.update()` call; only call `updateReviewInList()` / show "Posted" on success, and surface a visible error (matching the existing `alert()` pattern already used elsewhere in the same file for `markReady()`) on failure.

### Finding 16: Minor silent-failure pattern repeated across messaging read-receipt effects
- File: app/(dashboard)/messages/messages-client.tsx (auto-mark-read effect) and app/crew/messages/page.tsx:38
- Severity: Low
- Issue: Both files call `markConversationRead(otherUserId)` inside a `useEffect` as a bare `.then(...)` (dashboard) or unguarded call (crew PWA) with no `.catch()`. A failure produces an unhandled promise rejection and the read-receipt silently never updates, with no retry and no user-visible indication — duplicated across both the PM dashboard and crew PWA codepaths.
- Confirmed: Yes, per sub-agent review.
- Fix: Add `.catch(err => console.error('[markConversationRead]', err))` at minimum; consider a lightweight retry-on-next-mount since read receipts are not security/financial sensitive but the duplication across two call sites suggests extracting a shared hook (e.g. `useMarkConversationRead`) would also reduce tech debt.

### Finding 17 (rollup, Low severity, not individually itemized): Minor scattered silent-failure / error-suppression patterns
- Photo upload error swallowed silently in maintenance-board.tsx's `CreateWorkOrderModal` (failed `work_order_photos` insert is skipped with no `console.error` and no PM-visible warning — modal closes as if successful).
- guidebook-client.tsx `PropertyGuidebookForm`'s load effect has no error handling on its `.select('*')` — a failed load silently falls through to "create new config" branch, risking an overwrite of an existing but failed-to-load guidebook config.
- app/crew/work-orders/[id]/page.tsx's `handleComplete` catch block resets `setCompleting(false)` but shows no error message to the crew member — they only know to retry by trial and error.
- These are all narrow-blast-radius UI-only issues (single record, no cross-tenant or financial impact) bundled here rather than given individual Critical/High writeups; each fix is the same shape — check the result/error and surface a visible message instead of failing silently.
