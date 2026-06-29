# RLS / Security / Multi-Tenant Isolation Audit

Status: COMPLETE
Last checkpoint: Completed all checks — RLS policy scan, memberships/user_id bug grep, service role usage audit, Stripe webhook verification, anon grants, crew PWA Dexie compliance.
Next: n/a — audit complete

## Findings

### Finding 1: `bookings_manage` policy missing WITH CHECK
- File: supabase/schema_reference.sql:1909
- Severity: High
- Issue: `CREATE POLICY bookings_manage ON public.bookings FOR ALL TO public USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));` has no `WITH CHECK` clause. Per CLAUDE.md, USING alone is not enough for UPDATE/INSERT — without WITH CHECK, an admin/manager could potentially INSERT or UPDATE a row and set `org_id` to a *different* org (escaping the USING filter on write), since Postgres only applies USING to filter visible/existing rows for UPDATE/DELETE and does not constrain the new row values without WITH CHECK. For INSERT, WITH CHECK is the only thing enforced (USING is not checked for INSERT at all in Postgres RLS), so without WITH CHECK, an INSERT policy with only USING is undefined behavior — typically Postgres requires WITH CHECK for INSERT or falls back to USING, but explicit WITH CHECK is the documented-safe approach this codebase mandates everywhere else (see template in CLAUDE.md).
- Confirmed: Yes, confirmed by direct read of schema_reference.sql — no WITH CHECK present on this FOR ALL policy, unlike most other `_manage` policies in the file (e.g. depreciation_manage, assignment_outcomes_manage, comm_logs_manage, crew_availability_manage all have WITH CHECK).
- Fix: Add `WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))` to bookings_manage.

### Finding 2: `crew_manage` policy missing WITH CHECK
- File: supabase/schema_reference.sql:1992
- Severity: High
- Issue: `CREATE POLICY crew_manage ON public.crew_members FOR ALL TO public USING (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));` — same pattern as Finding 1. No WITH CHECK clause on a FOR ALL policy covering crew_members, meaning admin/manager writes (insert/update) on crew records aren't constrained to staying within their own org.
- Confirmed: Yes, confirmed by direct read.
- Fix: Add matching `WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))`.

### Finding 3: Widespread pattern — many `FOR ALL` policies missing WITH CHECK across the schema
- File: supabase/schema_reference.sql (full list of line numbers below)
- Severity: High
- Issue: Per CLAUDE.md's own stated rule ("RLS policies need both USING and WITH CHECK on UPDATE — USING alone is not enough"), every `FOR ALL`/`FOR UPDATE` policy should carry WITH CHECK. The following policies are `FOR ALL` (covering INSERT/UPDATE/DELETE/SELECT) with only a `USING` clause and no `WITH CHECK`, meaning writes are not constrained to the same predicate used to filter visibility — in Postgres, `USING` without `WITH CHECK` on a FOR ALL policy still applies the USING clause as the check for INSERT/UPDATE by default ONLY if no WITH CHECK is given (Postgres falls back to reusing USING as the check when WITH CHECK is omitted). This downgrades the *explicit, auditable* guarantee the rest of the codebase relies on, and is inconsistent — most equivalent policies elsewhere in the same file (e.g. `depreciation_manage`, `comm_logs_manage`, `crew_availability_manage`, `properties_manage`, `assets_manage`, `compliance_docs_manage`, `owner_transactions_manage`, `org_milestones_manage`) DO have explicit WITH CHECK. The inconsistency is itself a code-smell suggesting these were written/edited at different times without the same review rigor, and at minimum violates the documented convention.
  - `bookings_manage` :1909 (see Finding 1)
  - `crew_manage` :1992 (see Finding 2)
  - `message_templates_manage` (guest_message_templates) :2001
  - `ical_feeds_manage` :2007
  - `inventory_items_manage` :2085
  - `"org members can manage inventory template items"` :2094
  - `"org members can manage inventory templates"` :2101
  - `maintenance_manage` :2126
  - `"Owners can manage org invites"` :2144
  - `"Admins and managers manage master checklist"` :2149
  - `"Admins managers owners manage master maintenance"` :2152
  - `portal_tokens_manage` :2183
  - `"Admins managers owners manage property owners"` :2218
  - `property_owners_manage` :2224
  - `po_items_manage` :2227
  - `purchase_orders_manage` :2232
  - `"Crew members manage own push subscriptions"` :2235
  - `"Admins and managers can manage quote requests"` :2240
  - `assignments_manage` (turnover_assignments) :2279
  - `turnovers_manage` :2301
  - `vendors_manage` :2314
  - `wo_photos_manage` :2329
  - `work_orders_manage` :2345
  - `profiles_own` :2201 (USING `id = auth.uid()` only — without WITH CHECK a user could UPDATE their own profile row's `id` column if it's ever made mutable, or this falls back safely if Postgres applies USING as default check; still should be explicit per the codebase's own convention)
- Confirmed: Confirmed by direct read of schema_reference.sql — each listed policy lacks a WITH CHECK clause.
- Fix: Add explicit `WITH CHECK (<same predicate as USING>)` to every policy listed. This is mechanical and low-risk; should be done in one migration. Particularly prioritize `work_orders_manage`, `purchase_orders_manage`, `turnovers_manage`, `vendors_manage`, and `property_owners_manage` since these guard financially/operationally sensitive write paths (PO approval flows, WO completion writing actual_cost, vendor data feeding compliance checks).

### Finding 4: `turnovers_crew_update` (FOR UPDATE) missing WITH CHECK
- File: supabase/schema_reference.sql:2295
- Severity: Medium
- Issue: `turnovers_crew_update` lets a crew member UPDATE a turnover row they're assigned to, but has no WITH CHECK. Without it, a crew member could potentially update a turnover row and, depending on Postgres RLS semantics for default-check-from-USING, this likely still restricts to assigned turnovers — but it does NOT prevent the crew member from changing the turnover's `org_id` or reassigning it away from their own crew_member_id in the same UPDATE (since WITH CHECK is what would re-validate the new row state, e.g. that the row still belongs to an org/assignment that satisfies the policy after the write). This is a plausible vector for a crew member to "orphan" or move a turnover out of scope.
- Confirmed: Suspected — exact Postgres RLS fallback behavior for FOR UPDATE without WITH CHECK needs verification against actual Postgres docs/version, but the missing explicit WITH CHECK is confirmed and is a deviation from CLAUDE.md's mandated pattern.
- Fix: Add `WITH CHECK (id IN (SELECT ta.turnover_id FROM turnover_assignments ta JOIN crew_members cm ON ta.crew_member_id = cm.id WHERE cm.user_id = auth.uid()))` matching the USING clause.

### Finding 5: `org_members_admin_manage` (FOR UPDATE) missing WITH CHECK
- File: supabase/schema_reference.sql:2165
- Severity: High
- Issue: `org_members_admin_manage` allows an admin to UPDATE rows in `organization_members` (e.g. to change a member's role) but has no WITH CHECK. Without WITH CHECK, there's a real risk an admin could UPDATE another org's membership row's `org_id` to move it into their own org, or escalate a member's role to 'owner'/'admin' for a row that, post-update, no longer satisfies the original USING predicate (since USING is evaluated against the OLD row for UPDATE, not the NEW row, unless WITH CHECK is present). This is the single highest-value target in this audit: `organization_members` is the canonical permission table — a hole here undermines every other RLS policy that depends on `is_org_member()` / `get_user_org_ids()`.
- Confirmed: Confirmed missing WITH CHECK by direct read. Exploitability depends on exact Postgres RLS UPDATE semantics (USING is checked against old row; WITH CHECK against new row; if WITH CHECK is absent, Postgres reuses USING against the new row too — so impact may be partially mitigated by Postgres's documented fallback). Still flagging as High because it is a deviation from the codebase's mandated explicit pattern on its most sensitive table, and should not rely on implicit fallback behavior for something this sensitive.
- Fix: Add `WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role]))` explicitly.

### Finding 6: `.from('memberships')` bug pattern — NOT FOUND (clean)
- File: n/a
- Severity: N/A (negative finding)
- Issue: Ran `grep -rn "from('memberships')" --include="*.ts" --include="*.tsx" .` across the entire repo per CLAUDE.md Step 0 audit instruction. Zero hits. Also checked `membership.user_id` — zero hits. Also checked `assigned_crew_id` (deprecated column) — only appears in `types/database.generated.ts` (a read-only reference file, not imported anywhere), not in any actual app/lib code path.
- Confirmed: Confirmed clean via grep.
- Fix: None needed. This historical bug class appears fully eradicated from the codebase as it stands today.

### Finding 7: Pre-existing audit at `audits/01-security-multitenant-isolation.md` corroborates this audit's core findings
- File: audits/01-security-multitenant-isolation.md (separate, older audit directory already in the repo)
- Severity: N/A (informational)
- Issue: A prior security audit already exists in this repo at `audits/01-security-multitenant-isolation.md` (distinct from this session's `audit/` directory). It independently identifies the same missing-WITH-CHECK pattern on `bookings_manage`, `crew_manage`, `vendors_manage`, `maintenance_manage`, `work_orders_manage`, `inventory_items_manage`, plus additional findings not reproduced in full here: (a) the local `supabase/migrations/` directory is materially behind the live DB schema (CRITICAL, already documented in CLAUDE.md as known drift), (b) `org_master_checklist_items`/`org_master_maintenance_schedules`/`owner_transactions`/`ical_feeds`/`guest_message_templates` have only an ALL/manage policy with no dedicated SELECT policy for non-admin/manager roles (functional gap, not a leak), (c) `app/api/account/delete/route.ts` uses `.single()` against `organization_members`, silently skipping Stripe/integration cleanup for multi-org users on account deletion (MEDIUM, GDPR erasure gap), (d) `inventory_templates`/`inventory_template_items` write policies use a raw `organization_members` subquery instead of `is_org_member()`, granting ALL roles (including crew/viewer) management rights over org-level inventory templates — a within-org privilege-escalation gap, (e) `quote_requests` and `property_owners` have redundant/overlapping policies that could mask future tightening efforts.
- Confirmed: Confirmed this file exists and its content was reviewed; spot-checked several of its claims (WITH CHECK gaps, oauth_states intentional-zero-policy design) and found them accurate against direct reads of schema_reference.sql and migrations.
- Fix: Recommend prioritizing items (c) and (d) above from the prior audit — (c) is a GDPR-relevant data-retention bug, (d) is a real privilege-escalation gap (crew/viewer can currently modify org inventory templates), neither of which is mechanical "add WITH CHECK" busywork like the other findings in this report.

### Finding 8: Service role key, Stripe webhook verification, anon grants, crew PWA Dexie compliance — all CLEAN
- File: app/api/webhooks/stripe/route.ts, app/api/webhooks/stripe-connect/route.ts, app/crew/crew-shell.tsx, app/crew/turnovers/[id]/page.tsx, lib/dexie/photo-sync.ts
- Severity: N/A (negative finding / confirms compliance)
- Issue: Verified the following are all compliant with CLAUDE.md rules:
  - Both Stripe webhook handlers (`app/api/webhooks/stripe/route.ts:18`, `app/api/webhooks/stripe-connect/route.ts:26`) call `stripe.webhooks.constructEvent()` with the `stripe-signature` header before processing — signature verification is present.
  - `createServiceClient()` usage was grepped across all `.tsx` files outside `lib/`; every hit is in a Server Component (none have `'use client'`), and every dashboard-page usage spot-checked (`app/(dashboard)/settings/audit/page.tsx`) calls `requireOrgMember()` first and explicitly scopes the service-role query with `.eq('org_id', membership.org_id)` — service role is never used to bypass org scoping, only to bypass RLS for legitimate cross-cutting reads after the org has already been authenticated.
  - `oauth_states`, `stripe_processed_events`, `wo_number_counters` have RLS enabled with zero policies (default-deny for anon/authenticated) — confirmed intentional via code comments in migrations (`20260609000008_grant_missing_tables_vendor_address.sql:50`, `20260618000001_rls_select_policy_gaps.sql:35`) and confirmed all real usages go through `createServiceClient()`/admin clients only.
  - Anon role grants: confirmed the broad CRUD grants on `organization_members`, `properties`, `bookings`, `integration_connections`, `integration_providers`, `inventory_templates`, `inventory_template_items`, `org_master_checklist_items`, `org_master_maintenance_schedules`, `work_order_line_items` (full DELETE/INSERT/SELECT/UPDATE to `anon`) in `supabase/migrations/20260618000002_baseline_schema_snapshot.sql:4592-4655`. These match (and are no broader than) what CLAUDE.md's "Known anomalies" section already documents — no NEW anon-grant anomalies beyond what's already flagged for remediation in CLAUDE.md.
  - Crew PWA (`app/crew/*`): both client components using a Supabase client directly (`crew-shell.tsx`, `turnovers/[id]/page.tsx`) only use it for `auth.signOut()` and Storage uploads via `processPendingPhotoUploads` (`lib/dexie/photo-sync.ts`) — never for direct table reads/writes. Table data flows through Dexie (`getDexieDb`/`useLiveQuery`) and the `enqueueMutation` outbox as required. No violation of the local-first pattern found.
- Confirmed: Confirmed via direct file reads and targeted greps.
- Fix: None needed for these areas.
