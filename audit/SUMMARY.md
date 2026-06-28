# FieldStay Codebase Audit — Coordinating Summary

Status: COMPLETE
Last checkpoint: all 4 domain agents (RLS/security, idempotency/Inngest, schema/API/webhooks, scalability/tech-debt) finished and appended below
Next: none — see individual findings files for full detail (audit/01-04*.md)

Each agent appends a section here when it finishes its domain, with a link to its findings file and a 3-5 bullet summary of top issues.

---

## Schema Naming / API / Webhooks — by schema-api-webhooks auditor
File: audit/03-schema-api-webhooks.md
Top issues:
- HIGH: Telnyx SMS webhook (`app/api/webhooks/telnyx/route.ts`) has zero signature verification — an explicit TODO admits the ed25519 check was deferred — so anyone can forge STOP/START messages to flip SMS consent for arbitrary phone numbers.
- LOW: The generic `[provider]` webhook route (OwnerRez) correctly fails closed if `validateWebhook()` rejects, but the actual crypto/credential check lives in unreviewed provider adapters — flagged as a watch item for whoever audits `lib/integrations/*`.
- LOW: A `wo_status` type cast in the vendor work-order completion route narrows to 3 of 6 enum values; safe today only because of a coupled `.in('status', [...])` filter upstream — a type-safety smell, not a live bug.
- Everything else checked came back clean: no `.from('memberships')`, no `assigned_crew_id` in app code, no `inventory_count_draft_items`/`inventory_count_items` column cross-contamination, no `work_order_notes`, zero `.raw()`/`.modify()` usage, Stripe/Connect webhooks both verify signatures and dedupe correctly, OAuth CSRF state handling is solid (DB row + cookie, one-time use, expiry, open-redirect guard), all token-based public vendor/work-order portal routes validate tokens/expiry/state with atomic claims, and the 3 most recent migrations are fully reflected in `types/database.ts`.

## RLS / Security / Multi-Tenant — by RLS-security-multitenant auditor
File: audit/01-rls-security-multitenant.md
Top issues:
- HIGH: `organization_members` UPDATE policy (`org_members_admin_manage`) has no explicit `WITH CHECK` — the most sensitive table in the schema (every other RLS policy depends on it) relies on implicit Postgres fallback behavior instead of the codebase's mandated explicit pattern.
- HIGH: ~20+ `FOR ALL` policies across the schema (`bookings_manage`, `crew_manage`, `work_orders_manage`, `vendors_manage`, `purchase_orders_manage`, `turnovers_manage`, `property_owners_manage`, `wo_photos_manage`, etc.) are missing `WITH CHECK`, inconsistent with other `_manage` policies in the same file that do have it — mechanical fix, but should be done in one migration pass.
- A pre-existing, more detailed audit already exists at `audits/01-security-multitenant-isolation.md` that independently corroborates the WITH CHECK gaps and additionally flags two non-mechanical issues worth prioritizing: `app/api/account/delete/route.ts` uses `.single()` on `organization_members`, silently skipping Stripe/integration cleanup for multi-org users on deletion (GDPR erasure gap); and `inventory_templates`/`inventory_template_items` write policies use a raw subquery instead of `is_org_member()`, letting crew/viewer roles modify org-level inventory templates (privilege escalation).
- Clean: zero `.from('memberships')` or `membership.user_id` bugs found; Stripe webhooks verify signatures; service role key never reaches client components and is always scoped by `org_id` after `requireOrgMember()`; `oauth_states`/`stripe_processed_events`/`wo_number_counters` intentionally have zero RLS policies (service-role-only, confirmed by usage); anon grants are broad but match CLAUDE.md's already-documented known anomalies (no new ones found); crew PWA components never bypass Dexie for table reads (only auth.signOut() and Storage uploads use the Supabase client directly).

## Idempotency / Inngest — by idempotency-inngest-correctness auditor
File: audit/02-idempotency-inngest.md
Top issues:
- HIGH: `createServiceClient()` is called in the outer function scope (before the first `step.run()`), violating CLAUDE.md's explicit rule, across 10 files: all of `guidebook-sponsor-activated.ts`, `guidebook-sponsor-deactivated.ts`, `guidebook-daily-monitor.ts`, `guidebook-grace-expired-handler.ts`, `guidebook-sponsor-payment-recovered.ts`, `guidebook-guest-opted-in.ts`, `guidebook-stay-extension-handler.ts`, plus `work-order-vendor-assigned.ts`, `work-order-crew-assigned.ts`, `work-order-crew-completed.ts`. Every other function file in the codebase does this correctly, so it's a contained but repeated mistake across two feature areas.
- MEDIUM: `guidebook-guest-opted-in.ts` has a genuine check-then-act race on its door-code SMS dedup (`door_code_sent_at` is read, the SMS is sent, then the field is written after) — a retry between send and write would double-text a guest; `sendSMS` carries no idempotency key. Needs an atomic claim (`UPDATE ... WHERE door_code_sent_at IS NULL`) before sending.
- LOW/MEDIUM: `repuguard-batch-generate.ts` mutates `generated`/`skipped` counters in outer scope across `step.run` boundaries (fragile but likely fine in practice), and its PM-notification email idempotency key is scoped only to org+user+day, so a second same-day batch run (e.g. after hitting `BATCH_LIMIT=25`) silently never notifies the PM.
- Confirmed clean: exactly one `serve()` call in `app/api/inngest/route.ts`; no `step.sleep`/`step.sleepUntil` nested inside `step.run` anywhere; all `for...of` loops inside `step.run` correctly use `continue` (never `return`) to skip iterations (checked `flagged-turnover-wo.ts`, `ownerrez/incremental-sync.ts`, `ownerrez/ownerrez-reviews-sync.ts`); all events sent/used as triggers are registered in `lib/inngest/events.ts`; the four "financial automation" functions from CLAUDE.md's Step 3 (turnover/completed, work_order/completed, purchase_order/approved, booking/confirmed) all correctly use atomic `upsert(..., { onConflict: 'source_reference_id,source', ignoreDuplicates: true })` against `owner_transactions` — no double-posting risk found there.
- Best-practice reference found: `build-shopping-cart.ts` guards the live Kroger cart-add API call with a `runId`-scoped `org_milestones` check before calling the external API, preventing duplicate-cart-add on step retry — worth using as the template when fixing the SMS race above.

## Scalability / Loops / Tech Debt — by scalability-loops-techdebt auditor
File: audit/04-scalability-loops-techdebt.md
Top issues:
- CRITICAL: `lib/inngest/functions/ownerrez/initial-sync.ts:242-319` fetches property details sequentially (with a hardcoded 150ms sleep) for every property inside a single non-resumable `step.run` — a host with 200+ properties means 30s+ of sequential external calls, and any retry discards all prior progress and re-burns OwnerRez API quota.
- HIGH: `lib/inngest/functions/cron/maintenance-schedules.ts:365-423` and `lib/maintenance/vacancy-suggestions.ts:25-48` have a two-level N+1 — one `bookings` query per property, then one `maintenance_schedules` query per booking-gap — all unbatched and unbounded by `.limit()`, unlike the batched-email pattern used a few lines later in the same file.
- HIGH: `lib/inngest/functions/ownerrez/incremental-sync.ts:204-248` does a per-row `properties` SELECT plus sequential `resend.emails.send` inside one step with no `.in()` batching or `Promise.all`.
- HIGH: `app/api/webhooks/telnyx/route.ts` has zero signature verification (admitted via TODO comment) — anyone can spoof STOP/START SMS messages to flip a guest's SMS opt-in/opt-out flag, the same class of risk CLAUDE.md treats as mandatory-fix for Stripe.
- MEDIUM: `app/api/account/delete/route.ts:64-78` proceeds with account deletion even when Stripe subscription cancellation fails (error only `console.error`'d), risking an orphaned billable subscription with no FieldStay account left to cancel it from.
- MEDIUM: `app/(dashboard)/inventory/page.tsx` runs an unbounded, near-duplicate full `inventory_items` fetch twice (no `.limit()` on `items`, `allInventoryItems`, or `pendingDrafts`) while sibling queries on the same page correctly use `.limit(20)`/`.limit(50)`.
- MEDIUM: Several UI write paths show success regardless of write outcome — `reviews-client.tsx`'s `confirmPosted()` has no error check at all on its `.update()`, and `maintenance-board.tsx`'s bulk vendor-assign/status-update handlers clear selection without checking the server action's returned error.
- LOW: Minor rollup of scattered silent-failure patterns (unguarded `.then()` on read-receipt marking, swallowed photo-upload errors, unhandled guidebook-config load failures, missing crew-facing error messages on WO completion failure) and a couple of low-impact tech-debt items (O(n²) `.find()` in a loop in Hostaway sync, unbatched per-row geocoding `.update()` writes in a low-traffic ops-only function).
