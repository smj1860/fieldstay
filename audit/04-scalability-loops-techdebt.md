# Scalability / Loops / Silent Failures / Tech Debt Audit — Round 2

Status: IN PROGRESS
Last checkpoint: verified all 3 fix commits against live code (ownerrez initial/incremental sync, account delete route, maintenance-schedules.ts, hostaway initial-sync.ts, inventory page.tsx, repuguard-batch-generate.ts, reviews-client.tsx)
Next: sweep for new N+1/silent-failure patterns introduced by recent commits, finalize Round 1 Verification table

## Findings

### Finding A: Multi-org account deletion can log "account.deleted" for an org whose Stripe cancel later fails, and partially delete state across orgs
- File: app/api/account/delete/route.ts:41-102
- Severity: Medium
- Issue: The round-1 fix (commit 519381b) correctly aborts with a 503 when `stripe.subscriptions.cancel()` fails for an owned org — but the abort happens *inside* the `for (const membership of memberships ?? [])` loop. If a user owns multiple orgs (org A succeeds, org B's Stripe cancel fails), org A's `logAuditEvent({ action: 'account.deleted' })` at line 97-101 already ran for org A before the loop reaches org B and returns the 503. The route returns an error telling the user "please try again," but org A has already been audit-logged as deleted (and if `deleteUser` doesn't run, org A's org_id data is NOT actually deleted via cascade — only the audit log was written prematurely, which is itself a minor data-integrity issue: an audit trail claiming a deletion occurred when the auth user deletion that triggers the FK cascade never happened). Re-running the whole DELETE request after a fix is also not idempotent for org A: it will attempt org A's Stripe cancel again (now a no-op since already cancelled, fine) but will log a second `account.deleted` audit event for org A.
- Confirmed: Yes, read directly — `logAuditEvent` call sits at line 97-101, after the Stripe-cancel block, inside the same per-membership loop that can return early on a later iteration.
- Fix: Move the audit-log calls to fire only after ALL memberships have successfully passed the Stripe-cancellation gate (collect successes first, write audit events in a second pass), or write a "deletion_initiated" event distinct from "account.deleted" until the auth user delete actually succeeds at the end of the function.

### Finding B: Round-1 Medium finding — unbounded/duplicate inventory queries on Inventory dashboard — NOT fixed
- File: app/(dashboard)/inventory/page.tsx:28-33, 57-63, 69-81
- Severity: Medium
- Issue: None of the three fix commits touched this file. `items` (full `inventory_items`, no `.limit()`), `allInventoryItems` (a near-duplicate full `inventory_items` fetch with a `properties` join, no `.limit()`), and `pendingDrafts` (all `inventory_count_drafts` with nested `inventory_count_draft_items`, no `.limit()`) are all still present exactly as flagged in round 1. The duplicate-query waste (`items` and `allInventoryItems` are two near-identical full-table fetches in the same `Promise.all`) is also unchanged.
- Confirmed: Yes, read directly, lines unchanged from round-1 line numbers.
- Status: STILL OPEN (not addressed by any of the three fix commits despite being in scope for "scalability" work this round).
- Fix: As round 1 — add `.limit()`/pagination, and eliminate the duplicate `inventory_items` fetch by deriving one view from the other in memory.

### Finding C: Bulk work-order action handlers still clear selection without checking server-action result
- File: app/(dashboard)/maintenance/maintenance-board.tsx:2453-2455, 2470-2472
- Severity: Medium
- Issue: `bulkAssignVendor`/`bulkUpdateWorkOrderStatus` results are still not inspected before `clearSelection()` runs — unchanged from round 1 (Finding 14). The tech-debt sweep commit (a03165f) touched this same file (added photo-upload-failure warning surfacing at lines 418/455) but did not address the bulk-action result-checking gap a few hundred lines later.
- Confirmed: Yes, read directly.
- Status: STILL OPEN.
- Fix: As round 1 — check `{ error }`/`{ success }` before clearing selection; surface failures via the same `onWarning` pattern the sweep commit just added for photo uploads in this very file.

### Finding D: OwnerRez initial-sync `patch-property-fields` and `apply-checklist-template` loops remain sequential per-property writes
- File: lib/inngest/functions/ownerrez/initial-sync.ts:173-195 (patch loop), :376-381 (checklist-apply loop)
- Severity: Low (downgraded from round-1 Medium since the higher-impact detail-fetch step (Finding 2) was fixed)
- Issue: The fan-out fix in this same file (519381b) only addressed the `fetch-property-detail` step (Finding 2). The `patch-property-fields` step still does one `.update()` per property sequentially inside a single step, and `apply-checklist-template` still calls `applyMasterChecklistToProperty` once per property sequentially inside a single step. Both remain unbounded (no `.limit()` on the underlying property fetch) and un-fanned-out, so a retry of either step re-runs from scratch for all properties, same risk class as Finding 2 before its fix (just smaller in per-iteration cost — one `.update()`/checklist-application call vs. a full external API call + 150ms sleep).
- Confirmed: Yes, read directly — code is unchanged from round 1 in these two loops.
- Status: STILL OPEN (round-1 Finding 4, partially addressed — only the detail-fetch sibling loop in the same file was fixed).
- Fix: Same as round 1 — batch `patch-property-fields` into one `.upsert()`/multi-row update where the patch payload differs per row (Supabase doesn't support per-row differing payloads in a single `.update()`, so this needs either a `upsert` with full row payloads or per-row steps like the detail-fetch fix); fan out `apply-checklist-template` into one step per property using the same `step.run('apply-checklist-${property.id}', ...)` pattern just established for property-detail fetches in this file.

### Finding E: Geocoding-backfill per-row sequential .update() — unchanged
- File: lib/inngest/functions/geocoding-backfill.ts:54-65, 96-107
- Severity: Low
- Issue: Round-1 Finding 9 (per-row sequential `.update()` instead of batched upsert) is untouched by any of the three fix commits. Still low severity / ops-only blast radius.
- Confirmed: Yes, read directly, code unchanged.
- Status: STILL OPEN.
- Fix: As round 1.

### Finding F (RESOLVED, listed for completeness): Telnyx webhook signature verification now implemented correctly
- File: app/api/webhooks/telnyx/route.ts:7-41
- Severity: N/A (fixed)
- Issue: Round-1 Finding 13 flagged a deferred/missing ed25519 signature check. Live code now reads the raw body first, computes `verifyTelnyxSignature()` against `timestamp|rawBody` using `crypto.createVerify('ed25519')` and the `telnyx-signature-ed25519`/`telnyx-timestamp` headers, and returns 401 before any payload parsing or DB writes if verification fails or the public key/headers are missing.
- Confirmed: Yes, read directly.
- Status: FIXED.

### Finding G: New silent-failure pattern — Telnyx webhook opt-out/opt-in audit log loop has no error handling
- File: app/api/webhooks/telnyx/route.ts:86-93, 102-109
- Severity: Low
- Issue: The `for (const row of updated ?? [])` loops calling `logAuditEvent(...)` per affected org have no try/catch — if `logAuditEvent` throws (e.g. transient DB error), the entire webhook handler throws after the `is_active` update already succeeded, causing Telnyx to see a 500 and retry the webhook, which could lead to duplicate STOP/START processing (each retry re-runs the `.update()` — idempotent for the opt-in flag itself, but `logAuditEvent` calls would duplicate audit entries on a partial retry, or the response update step could double-fire if Telnyx's retry semantics resend the identical body). Minor since `.update()...is_active = false/true` is naturally idempotent, but worth a try/catch around the audit log call so a logging hiccup can't turn a successful consent-flag write into a perceived failure.
- Confirmed: Yes, read directly — this loop pattern is newly introduced in the aa3da30 Telnyx security fix commit (the route was previously not signature-verified, so this loop logic appears new/changed in this commit).
- Fix: Wrap `logAuditEvent` calls in try/catch with console.error fallback, consistent with the non-fatal logging pattern used elsewhere (e.g. ownerrez sync's writeSyncCount).
