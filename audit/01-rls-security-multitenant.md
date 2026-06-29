# RLS / Security / Multi-Tenant Isolation Audit — Round 2

Status: IN PROGRESS
Last checkpoint: Confirmed schema_reference.sql is STALE (dated 2026-06-10, predates 20260617000001 consolidation migration which fixed ~27 tables' WITH CHECK gaps). Confirmed organization_members.org_members_admin_manage and org_invites "Owners can manage org invites" are the two tables NOT covered by that consolidation and remain genuinely open. Verified account-deletion GDPR fix, inventory_templates privilege escalation fix, and Telnyx webhook signature fix are all correctly implemented.
Next: Grep for createServiceClient() outside step.run() across all Inngest functions; check requireOrgMember() usage coverage on server actions/route handlers; re-check memberships/user_id bug pattern; check anon grants for new anomalies; check crew PWA Dexie compliance for regressions.

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
- Confirmed: Suspected — investigating further below (see next checkpoint).
- Status: investigating
- Fix: TBD pending full repo grep.

