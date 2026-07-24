# Security & Multi-Tenant Isolation Audit

## Executive Summary

Overall the codebase follows the documented `org_id` + `get_user_org_ids()` /
`is_org_member()` RLS pattern fairly consistently for the tables that DO have
policies, and **no `.from('memberships')` references remain** — the historical
bug class is fully eradicated. Token-gated public portals (`/owner/[token]`,
`/work-orders/[token]/**`, `/accept-invite/[token]`,
`/crew/accept-invite/[token]`), the Stripe webhook, and the OwnerRez webhook all
correctly verify signatures/tokens, check expiry, and are idempotent. The
`createServiceClient` (service-role) usage is confined to Inngest functions and
specific server-side route handlers/Server Components — no client component
imports it, and it is never logged or returned in responses. Input validation on
API routes is generally good (rate limiting, size limits, type checks, prompt
injection mitigations on the AI-backed routes).

The most significant issue is **systemic**: the **migrations directory in this
repo is materially behind the live database** (per CLAUDE.md's own warning) —
most core tables (`properties`, `work_orders`, `turnovers`, `organizations`,
etc.) have no corresponding `CREATE TABLE` / `ENABLE ROW LEVEL SECURITY`
statements in `supabase/migrations/*.sql`, even though the live DB (confirmed
via direct query of `pg_policies`) has RLS enabled and reasonable policies for
nearly all of them. Within the live policy set there are several smaller gaps:
a handful of tables (`org_master_checklist_items`, `org_master_maintenance_schedules`,
`owner_transactions`, `ical_feeds`, `guest_message_templates`) have only an
`ALL`/manage policy scoped to `admin|manager`, with no dedicated SELECT policy
for other roles; several `FOR ALL` policies (`bookings_manage`, `crew_manage`,
`vendors_manage`, `maintenance_manage`, `work_orders_manage`,
`inventory_items_manage`) lack an explicit `WITH CHECK` clause; and
`oauth_states` has no policies returned by `pg_policies` at all (likely
intentional default-deny, but unconfirmed and undocumented). One functional bug
was found in `app/api/account/delete/route.ts` using `.single()` against
`organization_members`, which would silently skip cleanup for any user
belonging to multiple orgs.

**Findings: 1 CRITICAL, 3 HIGH, 6 MEDIUM, 3 LOW.**

---

## Findings

### CRITICAL: Migrations directory does not reflect live schema/RLS state — cannot be used to provision a secure environment
**Status: STALE/LARGELY FIXED (as of 2026-07-23)** — this finding was dated
against a repo with only 13 migration files. The repo now has 310+ migrations
including proper baseline schema files with RLS. Recommend a fresh spot-check
of live RLS coverage rather than treating this as still-critical.
- **Area:** RLS
- **Location:** `supabase/migrations/*.sql` (only 13 files, ~840 lines total) vs. live DB (60+ tables with RLS + policies)
- **Description:** Tables referenced throughout `app/` and `lib/` — including
  core multi-tenant tables like `properties`, `organizations`,
  `organization_members`, `work_orders`, `turnovers`, `vendors`,
  `purchase_orders`, `bookings`, `crew_members`, `inventory_items`, etc. — have
  **no `CREATE TABLE`, `ENABLE ROW LEVEL SECURITY`, or `CREATE POLICY`
  statements anywhere in `supabase/migrations/`**. The live database (queried
  directly) does have RLS enabled and policies defined for nearly all of these
  (see Table-by-Table matrix below), so the *production* posture is currently
  reasonable — but the migration history cannot reproduce it.
- **Risk:** (1) Any new environment (staging, disaster recovery, local dev via
  `supabase db reset`) built from these migrations would be missing RLS on the
  vast majority of tables — full cross-tenant data exposure. (2) Future
  developers/agents reading `supabase/migrations/` to understand "what RLS
  exists" (as this very audit was instructed to do) will dramatically
  undercount protections and may duplicate or conflict with live policies.
  (3) No single source of truth makes drift detection (CLAUDE.md's own stated
  problem — "schema is ahead of codebase") worse over time.
- **Recommendation:** Run `supabase db pull` / `supabase db diff` against the
  live project (`vpmznjktllhmmbfnxuvk`) and commit a baseline migration that
  captures the current live schema + RLS policies for every table. Going
  forward, enforce that every live DB change is first expressed as a migration
  file (CLAUDE.md already states this rule for `types/database.ts` — the same
  applies to RLS).

---

### HIGH: `org_master_checklist_items` and `org_master_maintenance_schedules` have only an `ALL` policy — no read policy for non-admin/manager roles (crew/viewer)
- **Area:** RLS
- **Location:** live `pg_policies` — `org_master_checklist_items` policy
  `"Admins and managers manage master checklist"` (cmd=ALL,
  `is_org_member(org_id, ARRAY['admin','manager','owner'])`);
  `org_master_maintenance_schedules` policy `"Admins managers owners manage
  master maintenance"` (same shape). No migration file defines these tables or
  policies.
- **Description:** Both tables have exactly one policy each, `FOR ALL`, scoped
  to `admin|manager|owner`. There is no `SELECT` policy for `crew` or `viewer`
  roles. If any UI surface lets crew/viewer roles read these (e.g. to display
  seeded master checklist items during onboarding wizard or a maintenance
  overview), those reads will silently return empty results under RLS for
  those roles. This is a functional gap more than a leak, but it diverges from
  the standard `<table>_select` + `<table>_manage` pattern in CLAUDE.md and the
  `ALL` policy with `is_org_member` bundles read+write into one role check,
  making the access boundary harder to audit.
- **Risk:** Functional breakage for crew/viewer roles if these tables are read
  from a context where `requireOrgMember()` returns those roles; also an
  audit-clarity risk — a future change to the `ALL` policy could inadvertently
  also change read access.
- **Recommendation:** Split into the standard two-policy shape:
  `..._select` (`org_id IN (SELECT get_user_org_ids())`, all roles) and
  `..._manage` (`FOR ALL`, `is_org_member(org_id, ARRAY['admin','manager'])` —
  note 'owner' already passes automatically per `is_org_member` semantics, so
  the explicit `'owner'::member_role` in the array is redundant but harmless).

---

### HIGH: `owner_transactions` has no dedicated SELECT policy — relies solely on the admin/manager `ALL` policy
- **Area:** RLS
- **Location:** live `pg_policies` — `owner_transactions` has only
  `owner_transactions_manage` (`FOR ALL`,
  `is_org_member(org_id, ARRAY['admin','manager'])`, with matching
  `WITH CHECK`). No `owner_transactions_select` policy exists. No migration
  file defines this table.
- **Description:** Per CLAUDE.md, `owner_transactions` is the P&L ledger and
  is read by `crew`/`viewer` roles in some contexts (and is the financial
  automation target for Step 3 of the roadmap — cleaning fees, WO completion
  expenses, booking revenue, inventory purchases). With only an `admin|manager`
  `ALL` policy, a `crew` or `viewer` org member querying
  `.from('owner_transactions')` directly (e.g. via PowerSync sync rules or a
  future dashboard widget) would get zero rows, even for their own org's data.
  Conversely, if a future PowerSync sync rule or server action assumes
  "any org member can read owner_transactions" (matching the documented
  `<table>_select` pattern elsewhere), it will silently fail.
- **Risk:** Primarily a functional/availability gap today (financial data is
  *more* restricted than the standard pattern, not less — so not a leak), but
  it is an inconsistency that could mask a future regression where someone
  "fixes" it by adding an overly broad SELECT policy without org scoping.
- **Recommendation:** Add
  `CREATE POLICY "owner_transactions_select" ON owner_transactions FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()))` if any non-admin/manager role
  needs to read this table (check `app/(dashboard)/owners/**` and
  `app/(dashboard)/reports/**` usages), or explicitly document that
  owner_transactions reads are admin/manager+service-role only by design.

---

### HIGH: `oauth_states` has RLS referenced in code paths but no policy found in `pg_policies`
- **Area:** RLS / Service Role
- **Location:** `lib/integrations/vault.ts`, `app/api/integrations/[provider]/connect/route.ts`,
  `app/api/integrations/[provider]/callback/route.ts` (all use
  `createServiceClient` per earlier grep). `pg_policies` query returned **no
  rows for `oauth_states`**.
- **Description:** `oauth_states` stores CSRF state tokens for OAuth flows.
  No SELECT/INSERT/UPDATE/DELETE policy exists for this table in the live DB
  (it may have RLS enabled with zero policies — which would mean
  default-deny for `authenticated`/`anon`, or RLS may not be enabled at all —
  the `relrowsecurity` check was blocked by the sandbox's production-read
  policy, so this could not be confirmed). All current usages are via
  `createServiceClient()` (service role, bypasses RLS), which is appropriate
  for OAuth state — but this should be verified and made explicit.
- **Risk:** If RLS is **disabled** on `oauth_states` and a future code path
  queries it with the anon/authenticated client, any user could potentially
  read or tamper with other users'/orgs' OAuth state tokens, enabling OAuth
  CSRF or token-fixation style attacks against the integrations flow.
- **Recommendation:** Confirm `oauth_states` has
  `ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY` with **no** permissive
  policies for `authenticated`/`anon` (default-deny, service-role only is
  correct here), and add an explicit migration documenting this intentional
  "no policies = service-role only" design — matching the comment style already
  used for `stripe_processed_events` and `wo_number_counters` in
  `supabase/migrations/20260609000008_grant_missing_tables_vendor_address.sql`.

---

### MEDIUM: `bookings_manage` ALL policy has `USING` but no `WITH CHECK`
- **Area:** RLS
- **Location:** live `pg_policies` — `bookings` table, policy `bookings_manage`
  (`cmd=ALL`, `qual = is_org_member(org_id, ARRAY['admin','manager'])`,
  `with_check = null`).
- **Description:** Per CLAUDE.md's standard template, `FOR ALL` policies should
  have matching `USING` and `WITH CHECK` clauses
  (`is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role])`
  for both). For `bookings_manage`, `with_check` is `null`, which means
  PostgreSQL falls back to using the `USING` clause for the check — this is
  *usually* safe for same-column policies, but it means an `UPDATE` could
  theoretically change a row's `org_id` to a different org the user is also an
  `admin|manager` of, since there's no explicit re-check that the *new* row
  still belongs to the *original* org context being operated on at the
  application layer (the risk is more about defense-in-depth / drift from the
  documented pattern than an active exploit, since `org_id` is rarely
  user-editable). Several other `ALL` policies have the same gap:
  `crew_manage`, `inventory_items_manage`, `purchase_orders_manage`,
  `property_owners_manage` (one of two), `turnovers_manage`,
  `vendors_manage`, `assets... ` (assets_manage has WITH CHECK, OK).
- **Risk:** Low-probability cross-org row "donation" if `org_id` is ever
  user-editable on these tables via an UPDATE path that doesn't separately
  validate `org_id` server-side (mitigated today because server actions filter
  `.eq('org_id', membership.org_id)` per `requireOrgMember()` convention).
- **Recommendation:** Add explicit `WITH CHECK` clauses matching `USING` to all
  `FOR ALL` policies, per the CLAUDE.md template:
  ```sql
  CREATE POLICY "table_manage" ON my_table FOR ALL
    USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  ```

---

### MEDIUM: `app/api/account/delete/route.ts` uses `.single()` on `organization_members`, silently skipping cleanup for multi-org users
- **Area:** Input Validation / Logic
- **Location:** `app/api/account/delete/route.ts:31-35`
  ```ts
  const { data: membership } = await admin
    .from('organization_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .single()

  if (membership) { ... } // Stripe cancellation, integration token revocation, audit log
  ```
- **Description:** `organization_members` is a join table — a user can belong
  to multiple orgs (e.g. a crew member working for two PM companies, or an
  owner who also manages their own properties as `admin` elsewhere). `.single()`
  returns an error (and `data: null`) if more than one row matches. In that
  case `membership` is falsy, the entire `if (membership)` block is skipped —
  **no Stripe subscription cancellation, no integration-token revocation, no
  audit log entry** — yet execution falls through to
  `admin.auth.admin.deleteUser(user.id)`, which still deletes the auth user.
- **Risk:** For multi-org users, account deletion silently leaves active Stripe
  subscriptions running (billing continues for an org with no owner present to
  manage it) and leaves OAuth integration tokens un-revoked in the vault
  (stale credentials retained after the user believes their data was deleted —
  a GDPR "right to erasure" gap).
- **Recommendation:** Replace `.single()` with no modifier (returns an array)
  and either iterate over all memberships, or use `.maybeSingle()` plus handle
  the multi-row case explicitly (e.g. only allow self-deletion when the user has
  exactly one membership, or loop `for (const membership of memberships ?? [])`
  and run the owner/Stripe/integration cleanup per org).

---

### MEDIUM: OwnerRez webhook handler logs externally-supplied identifiers without validation
- **Area:** Input Validation
- **Location:** `app/api/webhooks/[provider]/route.ts:75-78`
  ```ts
  const action         = String(payload.action ?? payload.event_type ?? '')
  const externalUserId = String(payload.user_id ?? payload.account_id ?? '')
  console.log(`[Webhook:${providerId}] Received action: "${action}" for external user: ${externalUserId}`)
  ```
- **Description:** `action` and `externalUserId` come directly from the
  (authenticated, per `validateWebhook`) request body but are coerced with
  `String()` and logged without length limits or character sanitization before
  any further validation. Since `validateWebhook` runs first (auth check), this
  is lower risk than an unauthenticated route, but log injection (newlines,
  control characters, extremely long strings from a compromised/misconfigured
  upstream) is still possible into application logs.
- **Risk:** Log injection / log forging (fake log lines that could mislead
  on-call engineers), and potential log volume abuse if `payload` is very large
  (no body size cap visible on this route).
- **Recommendation:** Truncate `action`/`externalUserId` to a reasonable max
  length before logging (e.g. 100 chars) and strip control characters. Consider
  adding a body size limit at the route or middleware level for all webhook
  endpoints.

---

### MEDIUM: `app/api/work-orders/[token]/complete/route.ts` GET handler does not check token expiry
- **Area:** Input Validation
- **Location:** `app/api/work-orders/[token]/complete/route.ts:154-176` (GET handler)
- **Description:** The `POST` handler correctly checks
  `completion_token_expires_at` and returns `410 Gone` if expired (lines 41-46).
  The `GET` handler (used to render the vendor portal form) only checks
  `workOrder.portal_enabled` and does **not** check
  `completion_token_expires_at`. A vendor with an expired link can still view
  work order details (title, description, scheduled date, estimated cost,
  property name/city/state) via `GET`, even though `POST` would correctly
  reject their submission.
- **Risk:** Low-severity information disclosure — an expired vendor token still
  reveals work order/property details to whoever holds the (expired) link, with
  no time-bound on visibility.
- **Recommendation:** Add the same expiry check to the GET handler:
  ```ts
  const expired = workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()
  if (!workOrder.portal_enabled || expired) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  ```
  (Note: `app/work-orders/[token]/page.tsx`, the Server Component rendering the
  same data, *does* compute `expired` and pass it to `<VendorPortal>` — only this
  API route's GET is missing the check.)

---

### LOW: `inventory_templates` / `inventory_template_items` write policies use raw `organization_members` subquery instead of `is_org_member()`, granting ALL roles manage access
- **Area:** RLS
- **Location:** live `pg_policies` —
  `"org members can manage inventory templates"` (`inventory_templates`, FOR ALL,
  `org_id IN (SELECT organization_members.org_id FROM organization_members WHERE
  organization_members.user_id = auth.uid())`); same pattern for
  `inventory_template_items`.
- **Description:** Unlike the standard `is_org_member(org_id, ARRAY['admin','manager'])`
  write-policy template, these two policies grant `FOR ALL` (including
  INSERT/UPDATE/DELETE) to **any** org member regardless of role — `crew` and
  `viewer` roles can modify org-level inventory templates.
- **Risk:** A `crew` or `viewer`-role user could modify the org's inventory
  template (which seeds `inventory_items` for new properties), a privilege
  escalation relative to the documented role model (template management should
  be `admin|manager`). Not a cross-tenant leak (still scoped to the user's own
  `org_id`), but a within-org privilege boundary violation.
- **Recommendation:** Replace with the standard pattern:
  ```sql
  CREATE POLICY "inventory_templates_manage" ON inventory_templates FOR ALL
    USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
    WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));
  ```
  and add a separate `_select` policy with `org_id IN (SELECT get_user_org_ids())`
  for read access by all roles.

---

### LOW: `quote_requests` has multiple overlapping/redundant policies mixing `get_user_org_ids()` and raw `organization_members` subqueries
- **Area:** RLS
- **Location:** live `pg_policies` — `quote_requests` has 5 policies:
  `quote_requests_insert`/`_select`/`_update` (raw `organization_members`
  subquery, any role), `"Org members can view quote requests"`
  (`get_user_org_ids()`), and `"Admins and managers can manage quote requests"`
  (`is_org_member`, FOR ALL). No migration defines any of these.
- **Description:** Functionally these overlap (Postgres ORs permissive
  policies), so the net effect is "any org member can insert/select/update,
  admin/manager can do anything" — not a leak, but the redundancy makes the
  effective access boundary hard to reason about and increases the chance that
  a future "tightening" edit (like the one done for `org_milestones` in
  `20260608000001_rls_hardening.sql`) misses one of the duplicate policies and
  leaves the looser one in effect (this exact failure mode is called out by
  name in that migration's own comments for `org_milestones`/`reviews`).
- **Risk:** Future security-tightening changes to `quote_requests` could be
  silently neutralized by a forgotten duplicate permissive policy.
- **Recommendation:** Consolidate to one `_select` (org-scoped, all roles), one
  `_insert`/`_manage` (admin/manager via `is_org_member`), dropping the raw
  `organization_members`-subquery duplicates, following the same remediation
  pattern as `20260608000001_rls_hardening.sql`.

---

### LOW: `property_owners` has two overlapping `ALL` management policies with different role sets
- **Area:** RLS
- **Location:** live `pg_policies` — `property_owners` has
  `"Admins managers owners manage property owners"` (`is_org_member(org_id,
  ARRAY['admin','manager','owner'])`) AND `property_owners_manage`
  (`is_org_member(org_id, ARRAY['admin','manager'])`), plus a separate INSERT
  policy for any org member.
- **Description:** Both `ALL` policies are functionally near-identical since
  `is_org_member` already treats `'owner'` as always-passing per CLAUDE.md
  (`'owner' role ALWAYS passes, regardless of p_roles array`) — so the explicit
  `'owner'::member_role` in the first policy's array is redundant. Having two
  separate `ALL` policies for the same table is not a security issue (both are
  equally permissive to admin/manager/owner) but is dead weight that should be
  consolidated for clarity, same rationale as the `quote_requests` finding.
- **Risk:** None directly — purely a maintainability/clarity issue that
  increases risk of confusion during future audits.
- **Recommendation:** Drop one of the two duplicate `ALL` policies.

---

## Areas 2–4 Summary (no additional findings beyond those listed above)

### Area 2 — Tenant-ID leakage via middleware/routing/headers
- `lib/supabase/middleware.ts` (the only middleware-related file; **no root
  `middleware.ts` exists** in the project) does nothing beyond
  `supabase.auth.getUser()` to refresh the session — it does not read or trust
  any `org_id` from headers, query params, or cookies. No tenant-ID
  short-circuiting found.
- `org_id` is consistently derived server-side from
  `requireOrgMember()` → `organization_members` lookup keyed on
  `auth.uid()`, never from client-supplied values. Verified in
  `lib/auth.ts`, all `app/(dashboard)/**/actions.ts` spot-checked, and the
  API routes reviewed in Area 4.
- No caching headers (`Cache-Control`, `unstable_cache`, etc.) were found on
  any route handler that returns org-scoped data — pages are dynamically
  rendered per-request via Server Components reading cookies, so Vercel's Data
  Cache / Full Route Cache would not apply by default. No cross-tenant cache
  poisoning vector identified.

### Area 3 — Service-role bypass protection
- `createServiceClient()` (defined in `lib/supabase/server.ts:51-66`) reads
  `process.env.SUPABASE_SERVICE_ROLE_KEY` and is **never** referenced from a
  `'use client'` file (verified via grep + spot-check of every matching file —
  see Appendix). It is never returned in a JSON response or interpolated into
  a string that's logged.
- All Server-Component usages of `createServiceClient` are in either (a)
  token-validated public portals where there is no Supabase session cookie to
  use (`/owner/[token]`, `/work-orders/[token]/**`, `/accept-invite/[token]`,
  `/crew/accept-invite/[token]`), or (b) `requireOrgMember()`-gated dashboard
  pages that explicitly filter by `membership.org_id` after obtaining the
  admin client (`reviews`, `settings/team`, `settings/integrations`,
  `settings/audit`) — all confirmed by reading the files.
- `app/api/integrations/[provider]/connect/route.ts` and `.../callback/route.ts`
  use `createClient` from `@supabase/supabase-js` directly (not
  `lib/supabase/server.ts`'s `createServiceClient`) with the service role key,
  for the documented reason that `oauth_states` has no RLS policy for
  authenticated reads. This is consistent with the codebase's stated design
  ("oauth_states has no RLS policy for reads — it is a server-side-only table" —
  comment at `app/api/integrations/[provider]/callback/route.ts:117-118`), but
  see the HIGH finding above recommending this be confirmed/documented at the
  DB level too.

### Area 4 — OWASP input validation on API routes
- **Stripe webhook** (`app/api/webhooks/stripe/route.ts`): verifies signature
  via `stripe.webhooks.constructEvent(body, signature, STRIPE_WEBHOOK_SECRET)`
  using the raw text body (`request.text()`), correctly rejects missing
  signatures, and dedupes via `stripe_processed_events` with a unique
  constraint (`23505` handling). 
- **OwnerRez/provider webhook** (`app/api/webhooks/[provider]/route.ts`):
  delegates to `providerAdapter.validateWebhook()` before processing, fails
  closed on validation errors, dedupes via `ownerrez_processed_webhooks`.
- **Vendor/owner token routes** (`app/api/work-orders/[token]/{complete,quote}/route.ts`,
  `app/owner/[token]/page.tsx`, `app/work-orders/[token]/**`): all validate the
  token against the DB, check expiry/revocation, and use atomic
  `UPDATE ... WHERE status IN (...)` claims for idempotency. One MEDIUM finding
  above (GET handler missing expiry check).
- **Crew routes** (`app/api/crew/**`): all derive `org_id`/`crew.id` from the
  authenticated session via `crew_members.user_id = auth.uid()`, never trust
  client-supplied IDs for org scoping; `inventory-count/route.ts` explicitly
  re-validates `propertyId` against `crew.org_id` before use (line 26-31,
  comment: "never trust a client-supplied propertyId").
- **AI-backed routes** (`app/api/repuguard/generate/route.ts`,
  `app/api/assets/scan-data-plate/route.ts`): both rate-limited per user, both
  validate/sanitize inputs (HTML-entity-encoding review text and internal notes
  before prompt interpolation, explicit prompt-injection countermeasures in the
  system prompt; image type/size validation). Good practice.
- **Milestone routes** (`app/api/milestones/**`): all derive `org_id` from
  `requireOrgMember()`, validate `body.milestone` presence, use `.eq('org_id', ...)`
  scoping on every write. No injection risk — no string concatenation into
  queries anywhere in the reviewed routes; all filters use `.eq()`/`.in()`/`.gt()`
  with parameterized values via the Supabase client.
- No `.from()` calls were found anywhere that build table/column names via
  string concatenation from user input.

---

## Table-by-Table RLS Coverage Matrix

_Built from live `pg_policies` query (project `vpmznjktllhmmbfnxuvk`) cross-referenced
against `.from('table_name')` usages in `app/` and `lib/`. "Migration?" = whether a
corresponding `CREATE TABLE`/`ENABLE RLS`/`CREATE POLICY` exists in
`supabase/migrations/*.sql`._

| Table | RLS Enabled? (live) | SELECT policy | Write policy | Migration? | Notes |
|---|---|---|---|---|---|
| asset_depreciation_entries | yes | depreciation_select (org_id) | depreciation_manage ALL (admin/manager, w/check) | grants only (20260609000008) | OK |
| assignment_outcomes | yes | assignment_outcomes_select (org_id) | assignment_outcomes_manage ALL (w/check) | grants only | OK |
| audit_events | yes | audit_events_select (owner only) | none (service-role only) | yes (20260609000003 + 20260608000001) | Intentional, documented |
| bookings | yes | bookings_select (org_id) | bookings_manage ALL (no WITH CHECK) | none | See MEDIUM finding |
| checklist_instance_items | yes | instance_items_select + crew_update | instance_items_manage ALL | none | OK, layered crew policy |
| checklist_instances | yes | checklist_instances_select + crew_select | checklist_instances_manage ALL | none | OK |
| checklist_template_items | yes | template_items_select | template_items_manage ALL | none | OK |
| checklist_template_sections | yes | template_sections_select | template_sections_manage ALL | none | OK |
| checklist_templates | yes | checklist_templates_select | checklist_templates_manage ALL | none | OK |
| communication_logs | yes | comm_logs_select (org_id) | comm_logs_manage ALL (w/check) | grants only | OK |
| crew_availability | yes | crew_availability_select | crew_availability_manage ALL (w/check) + self_manage | grants only | OK |
| crew_members | yes | crew_select (org_id) + crew_view_own | crew_manage ALL (no WITH CHECK) | none | minor: no WITH CHECK |
| guest_message_templates | yes | **none found** | message_templates_manage ALL (admin/manager) | none | Possible read gap — see note below |
| guest_messages_sent | yes | messages_sent_select (org_id) | **no write policy found** | none | service-role write only? verify |
| ical_feeds | yes | **none found** | ical_feeds_manage ALL (admin/manager) | none | read gap — relies on ALL covering SELECT for admin/manager only |
| integration_connections | yes | users_view_own_connections (auth.uid()=user_id) | **none found** | none | service-role write; per-user not per-org (see note) |
| integration_providers | yes | "Anyone can read active providers" (is_active=true) | none | none | Public read of provider catalog — OK (non-tenant data) |
| inventory_catalog | yes | inventory_catalog_read (true) | none | none | Global seed catalog, public read — OK |
| inventory_count_draft_items | yes | icdi_select + draft_items_select | icdi_manage ALL + draft_items_insert | yes | OK (post drop_broken_rls fix) |
| inventory_count_drafts | yes | icd_select + drafts_select | icd_manage ALL + drafts_insert + drafts_manage UPDATE | yes | OK |
| inventory_count_items | yes | count_items_select | count_items_crew_insert only | none | No admin/manager manage policy — verify intentional |
| inventory_counts | yes | inventory_counts_select | inventory_counts_crew_insert only | none | No admin/manager UPDATE/DELETE policy found |
| inventory_items | yes | inventory_items_select + crew_select | inventory_items_manage ALL + insert policy | none | OK |
| inventory_template_items | yes | (covered by ALL) | "...manage inventory template items" ALL (org_id via subquery) | none | OK but uses raw `organization_members` subquery instead of `get_user_org_ids()`/`is_org_member()` — inconsistent pattern, not a bug |
| inventory_templates | yes | (covered by ALL) | "...manage inventory templates" ALL | none | same note as above — any org member (not just admin/manager) can manage |
| maintenance_schedule_template_items | yes | msti_select | msti_manage ALL (w/check) | grants only | OK |
| maintenance_schedule_templates | yes | mst_select (org or is_system) | mst_manage ALL (w/check) | grants only | OK |
| maintenance_schedules | yes | maintenance_select | maintenance_manage ALL (no WITH CHECK) | none | minor |
| messages | yes | messages_select (sender/recipient) | messages_insert + messages_mark_read | none | Not org-scoped — scoped by sender/recipient identity instead; reasonable for DM-style table |
| oauth_states | unknown (blocked) | **none found** | **none found** | none | See HIGH finding — verify default-deny |
| org_invites | yes | (covered by ALL, owner only) | "Owners can manage org invites" ALL | yes (20260602000000) | OK |
| org_master_checklist_items | yes | **none found** | "Admins and managers manage master checklist" ALL | none | See HIGH finding |
| org_master_maintenance_schedules | yes | **none found** | "Admins managers owners manage master maintenance" ALL | none | See HIGH finding |
| org_milestones | yes | org_milestones_select (org_id) | org_milestones_manage ALL (w/check, admin/mgr/owner) | yes (20260608000001 + 20260609000003) | OK |
| organization_members | yes | org_members_select (org_id) | org_members_insert_self + admin_delete + admin_manage UPDATE | none | OK — no DELETE-by-self issue |
| organizations | yes | orgs_select (id in get_user_org_ids) | orgs_insert (auth.uid() not null) + orgs_update (admin) | none | orgs_insert allows ANY authenticated user to create an org row — standard for self-serve signup, OK |
| owner_portal_tokens | yes | (covered by ALL) | portal_tokens_manage ALL (via property_owners subquery, admin/manager) | none | No SELECT policy — anon access is via service-role only (app/owner/[token]/page.tsx), OK by design |
| owner_transactions | yes | **none found** | owner_transactions_manage ALL (w/check, admin/manager) | none | See HIGH finding |
| ownerrez_processed_webhooks | yes (per migration) | n/a | n/a | yes (20260609000007) | service-role only, no policies — correct |
| powersync_crew_instances/properties/turnovers | yes | crew_select_own_* (auth.uid()=user_id) | none | none | Read-only views for PowerSync, OK |
| profiles | yes | profiles_own ALL (id=auth.uid()) | (same) | none | OK |
| properties | yes | properties_select (org_id) | properties_manage ALL (w/check) | none | OK |
| property_assets | yes | assets_select (org_id) | assets_manage ALL (w/check) | grants only | OK |
| property_owners | yes | (covered by ALL policies + insert) | 2x ALL policies (admin/mgr/owner and admin/mgr) + insert | none | Two overlapping ALL policies — redundant but not insecure |
| purchase_order_items | yes | (via subquery to purchase_orders) | po_items_manage ALL (admin/manager via subquery) | none | No direct SELECT policy — relies on ALL for admin/manager; non-admin org members cannot read PO line items directly (verify intent) |
| purchase_orders | yes | (covered by ALL) | purchase_orders_manage ALL (admin/manager) | none | No separate SELECT — same pattern as above |
| push_subscriptions | yes | (covered by ALL, self) | "Crew members manage own..." ALL (crew_member_id -> auth.uid()) | grants only | OK |
| quote_requests | yes | quote_requests_select + "Org members can view" + Admins manage | quote_requests_insert/update + Admins manage ALL | grants only | Multiple overlapping policies (some via raw `organization_members` subquery, some via `get_user_org_ids()`) — redundant, not insecure |
| review_responses | yes | (via reviews/ALL) | review_responses_service_write ALL (admin/owner) | yes (20260601000000 + 20260608000001) | OK |
| reviews | yes | "Org members can read their reviews" | reviews_service_write ALL (admin/owner) | yes | OK |
| stripe_processed_events | yes | none (service-role only) | none | yes (20260609000002) | Correct — webhook dedup table |
| turnover_assignments | yes | assignments_select + assignments_crew_select | assignments_manage ALL (admin/manager) | none | OK |
| turnovers | yes | turnovers_select + turnovers_crew_select | turnovers_manage ALL + turnovers_crew_update | none | OK |
| vendor_compliance_documents | yes | compliance_docs_select (org_id) | compliance_docs_manage ALL (w/check) | grants only | OK |
| vendor_compliance_status | VIEW | n/a (view, inherits from vendors/vendor_compliance_documents RLS) | n/a | none | Should verify view uses `security_invoker` so RLS of base tables applies |
| vendors | yes | vendors_select (org_id) | vendors_manage ALL (no WITH CHECK) | none | minor |
| work_order_line_items | yes | "Members view org line items" (org_id) | insert/delete (admin/manager) | none | No UPDATE policy found — verify if line items are ever updated in place vs delete+recreate |
| work_order_photos | yes | wo_photos_select (via work_orders subquery) | wo_photos_manage ALL (admin/manager via subquery) | none | OK |
| work_order_updates | yes | wo_updates_select (org_id) | wo_updates_insert (admin/manager) only, no UPDATE/DELETE | none | Append-only log — correct by design |
| work_orders | yes | work_orders_select (org_id) | work_orders_manage ALL (no WITH CHECK) | none | minor |
| asset_type_standards | (grant SELECT only) | assumed `true`/global — not in policy list | n/a | grants only | Global read-only catalog table, GRANT SELECT to authenticated, no per-row policy needed if effectively public seed data — verify RLS enabled with permissive SELECT-all policy or RLS disabled intentionally for public catalog |

---

## Appendix: grep results for `memberships` and service-role usage

### `.from('memberships')` search
```
$ grep -rn "from('memberships')\|from(\"memberships\")" app lib --include="*.ts" --include="*.tsx"
(no matches — fully eradicated)
```

### `createServiceClient` / `SUPABASE_SERVICE_ROLE_KEY` usages (files)
```
app/api/assets/cpa-export/route.ts
app/api/account/delete/route.ts
app/api/crew/accept-invite/route.ts
app/api/integrations/[provider]/connect/route.ts
app/api/integrations/[provider]/callback/route.ts
app/api/gdpr/export/route.ts
app/api/webhooks/[provider]/route.ts
app/api/webhooks/stripe/route.ts
app/api/work-orders/[token]/complete/route.ts
app/api/work-orders/[token]/quote/route.ts
app/api/repuguard/generate/route.ts
app/api/repuguard/activate/route.ts
app/(auth)/callback/route.ts
app/crew/accept-invite/[token]/page.tsx        (Server Component, no 'use client')
app/(dashboard)/comms-log/actions.ts
app/(dashboard)/reviews/page.tsx               (Server Component, no 'use client')
app/(dashboard)/settings/team/actions.ts
app/(dashboard)/settings/team/page.tsx         (Server Component, no 'use client')
app/(dashboard)/settings/audit/page.tsx        (Server Component, no 'use client')
app/(dashboard)/settings/integrations/actions.ts
app/(dashboard)/settings/integrations/page.tsx (Server Component, no 'use client')
app/(dashboard)/turnovers/actions.ts
app/accept-invite/[token]/page.tsx             (Server Component, no 'use client')
app/onboarding/actions.ts
app/work-orders/[token]/page.tsx               (Server Component, no 'use client')
app/work-orders/[token]/quote/page.tsx         (Server Component, no 'use client')
app/owner/[token]/page.tsx                     (Server Component, no 'use client')
lib/supabase/server.ts                         (definition)
lib/auth.ts
lib/integrations/providers/ownerrez-api.ts
lib/integrations/vault.ts
lib/audit.ts
lib/push/send-push.ts
lib/inngest/helpers.ts
lib/inngest/functions/**  (all Inngest functions, expected)
```
All `'use client'` components were checked — **none** import or call
`createServiceClient`. All Server-Component usages are in token-validated
public portal pages (`app/owner/[token]`, `app/work-orders/[token]/**`,
`app/accept-invite/[token]`, `app/crew/accept-invite/[token]`) or
`requireOrgMember()`-gated dashboard pages that need to bypass RLS for
admin-curated views (`reviews`, `settings/team`, `settings/integrations`,
`settings/audit`).
