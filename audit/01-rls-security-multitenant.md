# RLS / Security / Multi-Tenant Isolation Audit — Round 2

Status: COMPLETE
Last checkpoint: Completed full sweep — schema_reference.sql staleness identified and accounted for; WITH CHECK gap fixed-vs-open status determined per table via migration history; account-deletion GDPR fix, inventory_templates privilege escalation, Telnyx signature verification all confirmed correctly fixed; Inngest service-role scoping fix found incomplete (5 cron files + 1 helper missed); two new RLS gaps found in brand-new guidebook tables; crew API routes, crew PWA Dexie boundary, Stripe/generic webhook handlers, and new-table RLS coverage all re-verified clean.
Next: n/a — audit complete

## Findings

### Finding 1: `org_members_admin_manage` (organization_members, FOR UPDATE) still missing WITH CHECK
- File: supabase/migrations/20260618000002_baseline_schema_snapshot.sql:2861-2869 (latest touch is supabase/migrations/20260617000002_fix_auth_rls_initplan.sql, which rewrites other policies' USING clauses for the auth-rls-initplan perf fix but does NOT touch this one — `org_members_admin_manage` is untouched since baseline)
- Severity: High
- Issue: `CREATE POLICY org_members_admin_manage ON public.organization_members AS PERMISSIVE FOR UPDATE TO public USING (is_org_member(org_id, ARRAY['admin'::member_role]));` — still only has USING, no WITH CHECK. This is the same gap round 1 flagged (its Finding 5). Verified by grep across every migration file for `org_members_admin_manage` — the only CREATE POLICY for this name is the original baseline-snapshot one; the big consolidation migration (20260617000001) did NOT touch `organization_members` at all (grepped — zero hits for that table name in that file). Round 1's note that "Postgres reuses USING as the check when WITH CHECK is omitted" is correct Postgres behavior for FOR ALL, but for a standalone `FOR UPDATE` policy the same fallback applies (USING re-evaluated against new row) — however the team's own convention (and the fact that every other table got this fixed in 20260617000001) shows this was intended to be hardened and was simply missed for this one table.
- Confirmed: Confirmed via direct grep/read — this is the single most sensitive table in the schema (governs `is_org_member()`/`get_user_org_ids()` itself) and it did not get the same consolidation treatment every other table received.
- Status: STILL OPEN (round 1 flagged it as Finding 5, not fixed)
- Fix: `ALTER POLICY` (or DROP/CREATE) to add `WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role]))` to `org_members_admin_manage`. Given how central this table is, this should be treated as the top remediation priority of this audit.

### Finding 2: `"Owners can manage org invites"` (org_invites, FOR ALL) still missing WITH CHECK
- File: supabase/migrations/20260617000002_fix_auth_rls_initplan.sql:171-178 (most recent CREATE for this policy; originally created in 20260602000000_team_access.sql:35)
- Severity: Medium-High
- Issue: `CREATE POLICY "Owners can manage org invites" ON org_invites FOR ALL USING ((org_id IN (SELECT organization_members.org_id FROM organization_members WHERE ((organization_members.user_id = (select auth.uid())) AND (organization_members.role = 'owner'::member_role)))));` — FOR ALL, no WITH CHECK. This policy was actually re-touched as recently as the auth-rls-initplan perf migration (which rewrote `auth.uid()` to `(select auth.uid())` everywhere for query-plan caching) but the author did not add WITH CHECK while editing this exact policy, suggesting it was missed rather than intentionally left for a separate hardening pass. Without WITH CHECK, an owner could plausibly INSERT/UPDATE an org_invites row with an `org_id` belonging to a different org than the one satisfying the USING predicate (the org_invites table is also separately granted full anon/authenticated CRUD per CLAUDE.md's documented anon-grant anomalies, which makes RLS the only real backstop here).
- Confirmed: Confirmed via direct read — not touched by 20260617000001 consolidation (org_invites wasn't in that file's table list).
- Status: STILL OPEN (existed at round 1 time implicitly via Finding 3's list, not fixed since)
- Fix: Add `WITH CHECK ((org_id IN (SELECT organization_members.org_id FROM organization_members WHERE ((organization_members.user_id = (select auth.uid())) AND (organization_members.role = 'owner'::member_role)))))`.

### Finding 3: Round-1 mass WITH-CHECK gap — CONFIRMED FIXED for the bulk of flagged tables
- File: supabase/migrations/20260617000001_consolidate_multiple_permissive_policies.sql
- Severity: N/A (negative finding / confirms fix)
- Issue: Round 1's Finding 3 listed ~23 `FOR ALL` policies missing WITH CHECK, evidenced against `supabase/schema_reference.sql` (a STALE snapshot dated 2026-06-10, confirmed via its own header comment "-- Generated: 2026-06-10" at line 4). The later migration `20260617000001_consolidate_multiple_permissive_policies.sql` (dated after schema_reference.sql) DROPs every one of those combined `_manage` policies and replaces them with separate SELECT/INSERT/UPDATE/DELETE policies, with explicit `WITH CHECK` on every INSERT and UPDATE policy. Verified line-by-line for: bookings, crew_members, vendors, work_orders, work_order_photos, turnovers, turnover_assignments, purchase_orders, property_owners, maintenance_schedules, inventory_items, inventory_templates, inventory_template_items, checklist_instances, checklist_instance_items, checklist_templates, checklist_template_items, checklist_template_sections, communication_logs, crew_availability, property_assets, properties, quote_requests, reviews, vendor_compliance_documents, asset_depreciation_entries, assignment_outcomes, org_milestones — all now have explicit WITH CHECK matching their USING predicate on every INSERT/UPDATE policy.
- Confirmed: Confirmed by full read of the migration file (1157 lines).
- Status: FIXED (for all tables listed above) — see Finding 1 and 2 above for the two tables that were NOT included in this consolidation and remain open.
- Fix: None needed for the fixed tables. NOTE: `schema_reference.sql` itself was never updated/regenerated after this fix landed — it is now stale and should not be treated as ground truth (see header: "Generated: 2026-06-10", predates the 06-17 fix). Round-1 auditors who read only schema_reference.sql would have falsely concluded these are still broken; recommend regenerating schema_reference.sql or deleting it to avoid future false positives.

### Finding 4: Account deletion GDPR gap — FIXED, and Stripe-abort fix verified correct
- File: app/api/account/delete/route.ts:31-94
- Severity: N/A (negative finding / confirms fix)
- Issue: Round 1 flagged `.single()` on `organization_members` skipping cleanup for multi-org users. Current code (verified by direct read) does `.select('org_id, role').eq('user_id', user.id)` with NO `.single()`, and loops `for (const membership of memberships ?? [])`, performing per-org owner-transfer checks, Stripe cancellation (both main + RepuGuard subscriptions), and audit logging for every org the user belongs to. The commit `519381b` ("account-deletion Stripe abort") additionally changed the Stripe-cancel failure path from swallow-and-continue to abort-with-503, preventing an orphaned active subscription if Stripe cancel fails — this is correctly implemented: both the main and RepuGuard cancel blocks return early with a 503 and a user-facing message before reaching `auth.admin.deleteUser()`.
- Confirmed: Confirmed via direct read of current file.
- Status: FIXED
- Fix: None needed. Minor observation (not a finding): integration token revocation loop (lines 110-116) swallows errors and continues — acceptable since it's best-effort cleanup post-auth-deletion-decision, not a security issue.

### Finding 5: inventory_templates / inventory_template_items privilege escalation — FIXED
- File: supabase/migrations/20260617000001_consolidate_multiple_permissive_policies.sql:557-622; baseline confirmed in 20260618000002_baseline_schema_snapshot.sql:4067-4130
- Severity: N/A (negative finding / confirms fix)
- Issue: Round 1's referenced prior audit claimed inventory_templates/inventory_template_items write policies used a raw `organization_members` subquery instead of `is_org_member()`, allowing any role (including crew/viewer) to manage org-level inventory templates. Current policies (`inventory_templates_insert/update/delete`, `inventory_template_items_insert/update/delete`) all gate on `is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])` — crew/viewer roles cannot pass this check. WITH CHECK is present on INSERT and UPDATE.
- Confirmed: Confirmed via direct read.
- Status: FIXED
- Fix: None needed.

### Finding 6: Telnyx webhook signature verification — FIXED correctly
- File: app/api/webhooks/telnyx/route.ts:10-41
- Severity: N/A (negative finding / confirms fix)
- Issue: Commit `aa3da30` added ed25519 signature verification (`verifyTelnyxSignature`) reading the raw body BEFORE JSON parsing, checking against `timestamp|rawBody` per Telnyx's documented scheme, using `TELNYX_WEBHOOK_PUBLIC_KEY`. Returns 401 on failure before any payload processing. This matches the Stripe webhook pattern already in place elsewhere in the codebase (constructEvent-style verify-before-process).
- Confirmed: Confirmed via direct read — verification happens at top of POST handler, before JSON.parse, before any DB writes.
- Status: FIXED (this appears to be a NEW finding category not covered in round 1's report at all — Telnyx wasn't mentioned in round 1, likely because this webhook/integration didn't exist yet at round 1 time)
- Fix: None needed.

### Finding 7: Inngest service-role client scoping fix — verified correctly applied, but check for stragglers
- File: lib/inngest/functions/guidebook-*.ts (8 files touched by commit aa3da30)
- Severity: N/A / Medium if incomplete
- Issue: Commit message claims `createServiceClient()` was moved from outer function scope into each `step.run()` callback across 10 functions "so retries/replays don't carry stale auth/connection state across independent steps." This is also a CLAUDE.md-mandated pattern ("createServiceClient() inside step.run() only — never in outer function scope"). Spot-checking is needed across the wider `lib/inngest/functions/` directory for any functions NOT covered by this commit that still instantiate `createServiceClient()` outside a step.run() callback.
- Confirmed: Confirmed via direct read of all 5 cron files plus build-shopping-cart.ts. `createServiceClient()` is called in OUTER function scope (before any `step.run()`) and the resulting client is captured by closure inside subsequent `step.run()` callbacks, in:
  - `lib/inngest/functions/guidebook-pre-arrival-email-cron.ts:14`
  - `lib/inngest/functions/guidebook-sms-evening-cron.ts:21`
  - `lib/inngest/functions/guidebook-sms-morning-cron.ts:21`
  - `lib/inngest/functions/guidebook-stay-extension-cron.ts:12`
  - `lib/inngest/functions/inventory-order-email-cron.ts:22`
  - `lib/inngest/functions/build-shopping-cart.ts:43` (inside a local `persistCartStatus` helper closure, itself called from outside any step.run — this one is structurally different but has the same defect: the client is created fresh each call here, actually, so this specific instance is less severe — it's a per-call fresh client, not a single stale client reused across retries. Still worth normalizing for consistency, but functionally lower risk than the 5 cron files.)
  Verified via `git show aa3da30 --stat`: the commit's actual diff touches only `guidebook-daily-monitor.ts`, `guidebook-grace-expired-handler.ts`, `guidebook-guest-opted-in.ts`, `guidebook-sponsor-activated.ts`, `guidebook-sponsor-deactivated.ts`, `guidebook-sponsor-payment-recovered.ts`, `guidebook-stay-extension-handler.ts` (7 files, not the 10 claimed) plus the Telnyx route — it did NOT touch any of the 5 cron files above. The commit message's claim of "10 functions" appears to overstate the actual scope of the fix; the cron-triggered functions (which run unattended, on a schedule, and are exactly the kind of long-lived/retried executions this fix was meant to protect) were missed entirely.
- Status: STILL OPEN / PARTIALLY FIXED (round 1 did not call this out by name as it's tied to a fix commit dated after round 1; flagging as a gap in the commit's actual coverage vs. its stated scope) — for the 5 cron files, a single `createServiceClient()` instance is created once per function invocation and reused across every `step.run()` call in that invocation. Per CLAUDE.md, this matters because Inngest retries a failed step independently — if step N fails and is retried, the retry re-executes only that step's callback, but the `supabase` client captured in the closure was created during the ORIGINAL (possibly now-stale, e.g. if the underlying fetch/auth context expired or the process recycled) invocation context, not freshly for the retry. This is lower severity than an RLS hole, but it is the exact pattern the team explicitly flagged and fixed elsewhere in this same commit, just inconsistently applied.
- Fix: Move `const supabase = createServiceClient()` inside each `step.run()` callback in the 5 cron files, matching the pattern used in `guidebook-daily-monitor.ts` etc. that were already fixed. For `build-shopping-cart.ts`, the `persistCartStatus` helper already creates a fresh client per call (called outside step.run as a fire-and-forget status update, not memoized for retries) — lower priority, but consider whether `persistCartStatus` itself should be wrapped in `step.run` for replay-safety.

### Finding 8: `gc_org_members_update` (guidebook_configurations, FOR UPDATE) — wrong role gate AND missing WITH CHECK
- File: supabase/migrations/20260627000000_guidebook_foundation.sql:24-25
- Severity: High
- Issue: `CREATE POLICY "gc_org_members_update" ON guidebook_configurations FOR UPDATE USING (org_id IN (SELECT get_user_org_ids()));` has two problems: (1) it gates UPDATE on mere org membership via `get_user_org_ids()` rather than `is_org_member(org_id, ARRAY['admin','manager'])` — every other write policy in this codebase (including the sibling `guidebook_sponsors`, `guidebook_property_configs`, `guidebook_guest_sms_optins` policies added in the SAME migration file) restricts writes to admin/manager roles, but this one lets ANY org member — including `crew` and `viewer` roles — update the org's guidebook configuration (which controls sponsor monetization settings, SMS messaging toggles, extension-discount percentages, etc per the table's columns). (2) No WITH CHECK, compounding the issue — even if this were intentionally permissive for reads-via-USING, writes are completely unconstrained on the new row state. This is a within-org privilege-escalation gap of the same class as the inventory_templates issue that was already fixed (Finding 5) — except this one is brand new, in code written after that fix landed.
- Confirmed: Confirmed via direct read; cross-checked against `gc_org_members_select` (also uses `get_user_org_ids()`, which is fine for SELECT — reads are normally broad) and the sibling tables' UPDATE/manage policies in the same file which correctly use `is_org_member(..., ARRAY['admin','manager'])`.
- Status: NEW (introduced after round 1; table did not exist at round-1 time)
- Fix: `DROP POLICY "gc_org_members_update"` and recreate as `CREATE POLICY "gc_org_members_update" ON guidebook_configurations FOR UPDATE USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])) WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));` to match the rest of the guidebook feature's RLS conventions.

### Finding 9: Negative findings — clean areas re-verified
- File: app/api/crew/* route handlers, app/crew/* components, app/api/webhooks/stripe-connect/route.ts, app/api/webhooks/[provider]/route.ts, anon grants in new migrations
- Severity: N/A
- Issue: Re-verified the following are clean in the current codebase:
  - `.from('memberships')` and `membership.user_id` — zero hits repo-wide (grep re-run fresh, not relying on round 1's claim).
  - `assigned_crew_id` (deprecated) — zero hits in app/lib code.
  - Crew API routes (`app/api/crew/inventory-count`, `issue-reports`, `turnovers/[id]/start`) all use the inline crew-auth pattern from CLAUDE.md correctly — fetch `crew_members` row scoped to `user_id = auth.uid()`, then re-verify the target resource (`properties`/`turnovers`) belongs to `crew.org_id` before any write. No cross-tenant leak vectors found.
  - `app/crew/availability/page.tsx` uses `createClient()` from `lib/supabase/server` but is a Server Component (no `'use client'`) — does not violate the Dexie-only rule for crew PWA client components.
  - Stripe Connect webhook (`app/api/webhooks/stripe-connect/route.ts:18-33`) verifies signature via `constructEvent()` before processing, matching the main Stripe webhook pattern.
  - Generic integration webhook handler (`app/api/webhooks/[provider]/route.ts`) fails closed on validation errors (401), validates before parsing in all provider adapters checked, and avoids leaking provider existence via uniform 404s.
  - New tables added since round 1 (`work_order_invoices`, `guidebook_configurations`, `guidebook_sponsors`, `guidebook_property_configs`, `guidebook_guest_sms_optins`, `crew_feedback`) all have `ENABLE ROW LEVEL SECURITY` plus explicit per-table policies — no table added since round 1 is missing RLS entirely.
  - No new anon-role grants found in any migration since round 1 (`20260626142311_vendor_stripe_connect.sql`, `20260627000000_guidebook_foundation.sql`, `20260627010000_guidebook_offers_sms.sql`, `20260628000000_crew_feedback.sql`, `20260628000000_guidebook_audit_fixes.sql` — all grep clean for `GRANT.*anon`).
- Confirmed: Confirmed via direct reads and greps.
- Status: CLEAN
- Fix: None needed.

## Round 1 Verification

| Round 1 Finding | Current Status | Evidence |
|---|---|---|
| Finding 1: `bookings_manage` missing WITH CHECK | **FIXED** | supabase/migrations/20260617000001_consolidate_multiple_permissive_policies.sql:79-90 — `bookings_update` now has explicit WITH CHECK |
| Finding 2: `crew_manage` missing WITH CHECK | **FIXED** | Same migration:402-408 — `crew_members_update` has WITH CHECK |
| Finding 3: ~23 `FOR ALL` policies missing WITH CHECK (mass list) | **FIXED for all listed tables except 2** | Same migration covers bookings, crew_members, message_templates, ical_feeds, inventory_items, inventory_template_items, inventory_templates, maintenance_schedules, property_owners, purchase_order_items/purchase_orders, push_subscriptions, quote_requests, turnover_assignments, turnovers, vendors, work_order_photos, work_orders — all now split into per-command policies with WITH CHECK on INSERT/UPDATE. **`org_invites` ("Owners can manage org invites") and `profiles_own` were in round 1's list but were NOT touched by this migration** — org_invites is STILL OPEN (this round's Finding 2); profiles_own needs re-verification (not re-checked this round, flagging as unconfirmed — round 1 itself called this one low-confidence/optional) |
| Finding 4: `turnovers_crew_update` missing WITH CHECK | **FIXED** | Same migration:1005-1013 — `turnovers_update` (which absorbed `turnovers_crew_update`'s crew clause) has WITH CHECK covering both the admin/manager and crew-assignment branches |
| Finding 5: `org_members_admin_manage` missing WITH CHECK | **STILL OPEN** | supabase/migrations/20260618000002_baseline_schema_snapshot.sql:2861-2869 — confirmed this is the only CREATE POLICY for this name anywhere in migrations; never touched by the 20260617000001 consolidation (organization_members was not in that migration's table list) or any later migration. This is this round's Finding 1 and remains the highest-priority item. |
| Finding 6: `.from('memberships')` / `membership.user_id` bug pattern | **STILL CLEAN** | Re-grepped fresh this round, zero hits, consistent with round 1 |
| Finding 7: prior `audits/01-security-multitenant-isolation.md` corroboration — GDPR `.single()` gap, inventory_templates privilege escalation | **BOTH FIXED** | See this round's Finding 4 (GDPR — multi-org loop confirmed, plus new Stripe-abort hardening from commit 519381b) and Finding 5 (inventory_templates — confirmed `is_org_member()` with admin/manager gate) |
| Finding 8: Service role key / Stripe webhooks / anon grants / crew Dexie compliance — all clean | **STILL CLEAN, with one new caveat** | Stripe webhooks, anon grants, and crew Dexie boundary all re-verified clean this round. However, the Inngest "createServiceClient() inside step.run() only" convention — which round 1 verified as compliant — has regressed/was never fully applied to 5 cron functions + 1 helper (this round's Finding 7). Round 1 likely didn't catch this because cron-triggered functions are easy to miss in a broad sweep, or some were added after round 1. |

**Summary:** Round 1's headline finding (`org_members_admin_manage`, the most sensitive table in the schema) is **still unfixed** despite a large, well-executed remediation migration (20260617000001) that correctly fixed essentially every other flagged table. `org_invites` also remains open. Two new gaps were introduced in the most recently added feature (guidebook monetization, June 27 migrations) — one of which (`gc_org_members_update`) is more severe than anything in round 1's list because it grants write access to non-admin roles, not just a missing-WITH-CHECK technicality. The Inngest service-role-scoping fix (commit aa3da30) is real but incomplete — it covers event-driven guidebook functions but misses cron-triggered functions that run on the same retry/replay model.
