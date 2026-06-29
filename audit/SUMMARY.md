# FieldStay Codebase Audit — Round 2 Coordinating Summary

Status: IN PROGRESS
Last checkpoint: round 2 kicked off after pulling latest fixes from main (commits aa3da30, 519381b, 65fd3f7, a03165f, a215f89, 466cfe7)
Next: waiting for domain agents to report in

This is a re-audit following fixes applied after round 1 (see audit/round1/ for the original findings — do not treat those as current state, they are historical snapshots only). Each agent appends a section here when it finishes its domain, with a link to its findings file and a 3-5 bullet summary of top issues: regressions, newly-introduced issues, anything missed in round 1, and confirmation of what was actually fixed.

---

## Schema Naming / API / Webhooks — Round 2 — by Schema/API/Webhooks Auditor
File: audit/03-schema-api-webhooks.md
Top issues:
- Telnyx webhook ed25519 signature verification (round 1 Finding 1) is correctly implemented: real `createVerify('ed25519')` over `timestamp|rawBody`, correct Telnyx header names, raw body read before parsing, fails closed with 401. No regression.
- wo_status cast smell in vendor work-order completion route (round 1 Finding 3) is fixed: now casts to the full `WoStatus` type instead of a hand-rolled 3-value union.
- NEW (Medium): a migration file named literally `new asset_type_standards_rls` (no timestamp, no `.sql` extension) sits in `supabase/migrations/` — violates the `YYYYMMDDHHMMSS_description.sql` convention and may be silently skipped by `supabase db push`; live DB state for `asset_type_standards` RLS not verified in this pass.
- NEW (Low): `TELNYX_WEBHOOK_PUBLIC_KEY` is not documented in `.env.example` despite being required by the new signature-verification code (fails closed if unset, so not a security bug, just a doc gap).
- All clean: `.from('memberships')`, `assigned_crew_id`, `work_order_notes`, `supabase.raw()/.modify()` — zero occurrences app-wide. All 6 most recent migrations (20260625–20260628) are fully reflected in `types/database.ts`. OwnerRez/Hostaway/Kroger webhook adapters all fail closed correctly (no stub returns `true`).

## Idempotency / Inngest — Round 2 — by Idempotency/Inngest Auditor
File: audit/02-idempotency-inngest.md
Top issues:
- CONFIRMED FIXED: all 3 substantive round-1 bugs are resolved — the guest-SMS check-then-act race in guidebook-guest-opted-in.ts now uses an atomic `UPDATE ... WHERE door_code_sent_at IS NULL RETURNING id` claim (with rollback on SMS send failure); the repuguard-batch-generate.ts outer-scope counter hazard is fixed via step-return-value accumulation; its notify-pm idempotency key now includes a per-batch marker so same-day re-runs aren't silently de-duped.
- CONFIRMED FIXED: the originally-named 10 files (7 guidebook-*.ts + 3 work-order-*.ts) all now correctly call `createServiceClient()` inside each `step.run()` callback instead of the outer function scope.
- MISSED IN ROUND 1 (High): 9 additional files have the IDENTICAL outer-scope `createServiceClient()` bug and were never touched by the fix commit — inventory-order-email-cron.ts, ownerrez/initial-sync.ts, guidebook-sms-evening-cron.ts, cron/checklist-signals.ts, cron/work-order-ops.ts, guidebook-pre-arrival-email-cron.ts, guidebook-stay-extension-cron.ts, build-shopping-cart.ts, guidebook-sms-morning-cron.ts. Notably 3 of these (ownerrez/initial-sync.ts, cron/checklist-signals.ts, cron/work-order-ops.ts) were explicitly cited in round 1 as "spot-checked, confirmed clean" — that spot-check was wrong. build-shopping-cart.ts is particularly notable since it drives live Kroger cart API calls.
- All other domain checks clean: single `serve()` call, all events registered in `lib/inngest/events.ts`, no `step.sleep` nested inside `step.run`, no `for...of` using bare `return` inside a `step.run` callback, all `owner_transactions` writes use the correct `onConflict: 'source_reference_id,source', ignoreDuplicates: true` upsert pattern, purchase_order creation correctly checks `source_count_id` first, and the Hostaway O(n²) lookup fix (Map-based) is verified in place.

## Scalability / Loops / Tech Debt — Round 2 — by Scalability/Loops/Tech-Debt auditor
File: audit/04-scalability-loops-techdebt.md
Top issues:
- Confirmed fixed: OwnerRez initial-sync's sequential per-property detail-fetch step is now fanned out into one memoized step per property (Critical round-1 finding resolved correctly); maintenance-schedules vacancy-gap N+1 is now 3 batched queries with in-memory computation; Hostaway O(n²) `.find()` replaced with a Map; Telnyx webhook now has real ed25519 signature verification.
- New regression (Medium): account deletion's Stripe-cancel abort (route.ts:66-94) sits inside the per-membership loop — a multi-org owner can have org A's `account.deleted` audit log already written before org B's Stripe failure aborts the request with a 503, leaving an inconsistent audit trail and a non-idempotent retry.
- Still open / missed by all three fix commits: Inventory dashboard page.tsx's unbounded + duplicate `inventory_items` fetches (round-1 Medium, untouched); bulk work-order action handlers in maintenance-board.tsx still clear selection without checking server-action results (round-1 Medium, untouched even though the same file was edited for a different fix); OwnerRez initial-sync's `patch-property-fields`/`apply-checklist-template` loops remain sequential per-property writes (round-1 Finding 4, only half-fixed — the sibling loop in the same file got the fan-out treatment, these two did not); sequential integration-token revocation on account deletion (round-1 Finding 12, untouched).
- Newly found (Low): Telnyx webhook's new per-row audit-log loop (route.ts:86-93, 102-109) has no try/catch around `logAuditEvent`, risking a 500/retry on a logging hiccup after the consent-flag write already succeeded.
- Verified previously-suspected pagination concern is actually fine: both Hostaway and OwnerRez API clients have explicit `MAX_PAGES` caps with abort-and-log behavior — not unbounded as flagged "suspected" in round 1.
