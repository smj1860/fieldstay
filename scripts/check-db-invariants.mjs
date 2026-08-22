#!/usr/bin/env node
/**
 * FieldStay — DB invariant check (structural enforcement, Tier 3).
 *
 * The ESLint rules and unit/guardrails/ suite police the CODE; this script
 * polices the DATABASE — the invariants CLAUDE.md states but no code-side
 * check can see. It calls public.db_invariant_report() (see
 * supabase/migrations/20260724131000_db_invariant_report.sql) and fails on:
 *
 *   1. any public table without RLS enabled
 *   2. any RLS-enabled table with ZERO policies that is not in the
 *      SERVICE_ROLE_ONLY_TABLES allowlist below (deny-all is a valid stance
 *      only when it's deliberate) — the allowlist is shrink-only: a stale
 *      entry is itself a failure, same ratchet rule as the Tailwind baseline
 *   3. any FK column without a covering index
 *   4. any anon grant on a public table (all were revoked by
 *      20260724130000_revoke_stale_anon_table_grants.sql; new ones are drift)
 *   5. any column named like a dedup/idempotency key (dedupe_key, dedup_key,
 *      source_reference_id) with no real UNIQUE/partial-unique index behind
 *      it — CLAUDE.md documents these as the dedup mechanism, but nothing
 *      previously verified the DB-level guarantee actually exists
 *   6. any permissive RLS policy facing `authenticated`/PUBLIC whose table
 *      does not hold the matching Postgres GRANT — Postgres checks the grant
 *      BEFORE RLS, so such a table denies every client query while looking
 *      perfectly policed. This class has shipped twice (20260710200000, and
 *      again on nine tables incl. the whole notification bell)
 *   7. any `organizations` row with zero `organization_members` — an org no
 *      member can reach is invisible to RLS forever: unreachable, unpurgeable,
 *      and still holding guest PII (GDPR Art. 17)
 *   8. `storage.objects` policies: any policy that qualifies on `bucket_id`
 *      alone instead of narrowing by owning org, and any bucket with no
 *      policy at all. storage lives outside the `public` schema, so every
 *      other section of this report was blind to it — which is exactly how
 *      bucket-wide access to every tenant's vendor COIs stayed invisible to
 *      code review AND to CI
 *   9. any table carrying `org_id` with no FK to `organizations` — the same
 *      orphaning as (7), one level down
 *
 * Runs in the CI `db-invariants` job against the DEDICATED E2E PROJECT
 * (docs/E2E_SETUP.md). Grant state isn't purely migration-driven (Supabase
 * default privileges differ per project), which is why check 4 demands ZERO
 * rather than diffing a baseline.
 *
 * ⚠️ THE E2E RUN DOES NOT SPEAK FOR PRODUCTION.
 *
 * This header used to claim it did: "both projects receive every migration, so
 * schema-level invariants verified on the E2E project hold for production by
 * construction." The premise is unsound — the two projects' migration ledgers
 * have diverged (verified 2026-08-03: 33 local files absent from live history,
 * 35 live entries with no local file), so "both receive every migration" is an
 * assumption, not a guarantee, and an E2E pass is evidence about the E2E
 * project only.
 *
 * That is a gap in what CI can PROVE, not a known production defect. Production
 * was verified directly on 2026-08-03 and passes all nine checks — including
 * org_id_columns_without_fk, whose single entry is the deliberate
 * ORG_ID_FK_EXCEPTIONS case below. The point is that nothing in CI told us
 * that; a human had to go and look. Hence the opt-in below.
 *
 * Two consequences are now handled explicitly rather than assumed away:
 *
 *   TARGETING — the report function is `LANGUAGE sql` / SECURITY DEFINER with
 *   no DDL or DML (supabase/migrations/20260724131000_db_invariant_report.sql),
 *   i.e. provably read-only, so running it against production is safe. The
 *   blanket production refusal below stays the DEFAULT (CI should not hold
 *   prod credentials by accident) but is now opt-in-able via
 *   DB_INVARIANTS_ALLOW_PROD=1 for a deliberate, human-run verification:
 *       npm run check:db-invariants:prod
 *
 *   ARMEDNESS — self-disarming keeps fork PRs and unconfigured clones from
 *   sitting on a permanently red required check, which is a real and good
 *   reason (see unit/guardrails/ci-gating.test.ts). But on the canonical repo
 *   a silent skip is indistinguishable from a pass, and a `::warning` is not
 *   something anyone reads on a green run. Set DB_INVARIANTS_REQUIRE_ARMED=1
 *   (the CI job does, for non-fork runs) to turn an absent secret into a hard
 *   failure instead.
 */

// Node builtins only — this script runs in the db-invariants CI job, which has
// no `pnpm install` step. Enforced by unit/guardrails/ci-gating.test.ts, which
// fails locally on any bare-specifier import here.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  // On the canonical repo an unarmed run is a silent skip wearing a green
  // check. Forks legitimately have no secrets, so the warn-and-pass path below
  // stays — this flag is what separates the two.
  if (process.env.DB_INVARIANTS_REQUIRE_ARMED === '1') {
    console.error(
      'DB invariant gate is REQUIRED on this run but UNARMED: ' +
        'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
        'Passing here would report a green check for invariants nobody verified. ' +
        'Configure the E2E secrets (docs/E2E_SETUP.md), or unset ' +
        'DB_INVARIANTS_REQUIRE_ARMED if this run genuinely cannot hold them.'
    )
    process.exit(1)
  }

  console.log(
    '::warning title=DB invariant gate UNARMED::NEXT_PUBLIC_SUPABASE_URL / ' +
      'SUPABASE_SERVICE_ROLE_KEY are not configured, so database invariants ' +
      '(RLS on every table, FK indexes, anon-grant hygiene) were NOT checked. ' +
      'Follow docs/E2E_SETUP.md to arm the gate.'
  )
  process.exit(0)
}

/**
 * Calls a read-only introspection RPC and returns its rows, or null when the
 * function is not deployed on the target project (so the caller can fail with a
 * message naming the migration rather than a TypeError).
 *
 * Status code only in the log — the response body is network-controlled data and
 * does not belong in CI output (Sonar S5145).
 */
async function rpc(fn) {
  const r = await fetch(new URL(`/rest/v1/rpc/${fn}`, url), {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: '{}',
  })
  if (!r.ok) {
    console.error(`${fn}() RPC failed: HTTP ${r.status}`)
    return null
  }
  return r.json()
}

const PROD_PROJECT_REF = 'vpmznjktllhmmbfnxuvk'
const allowProd = process.env.DB_INVARIANTS_ALLOW_PROD === '1'

if (url.includes(PROD_PROJECT_REF) && !allowProd) {
  console.error(
    'Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION ' +
      'Supabase project. CI must use the dedicated E2E project — see ' +
      'docs/E2E_SETUP.md.\n' +
      'If you MEANT to verify production (this check is read-only — the report ' +
      'function performs no DDL or DML), re-run with DB_INVARIANTS_ALLOW_PROD=1, ' +
      'or use: npm run check:db-invariants:prod'
  )
  process.exit(1)
}

if (url.includes(PROD_PROJECT_REF)) {
  console.log(
    'Verifying invariants against PRODUCTION (read-only). The E2E run does not ' +
      'speak for production — see the header note.'
  )
}

// Tables that are deliberately service-role-only: RLS enabled with zero
// policies = clients fully locked out, all access via createServiceClient().
// Shrink-only — if a table here gains policies (or is dropped), remove it.
const SERVICE_ROLE_ONLY_TABLES = new Set([
  'pending_integration_links',
  'pending_oauth_authorizations',
  'processed_webhooks',
  // Internal webhook-attribution routing cache — written/read only by
  // resolveHospitableOwner() via service role. See
  // supabase/migrations/20260728120000_integration_entity_owners.sql.
  'integration_entity_owners',
  // Hospitable launch promo singleton counter — RLS with zero policies, all
  // writes via the SECURITY DEFINER claim/tag functions (service_role only).
  // See supabase/migrations/20260727150000_hospitable_launch_promo.sql,
  // applied to production + E2E on 2026-07-30.
  'promo_hospitable_launch_counter',
  // The five below had member-facing policies and no `authenticated` GRANT
  // (2026-07-30 pre-launch audit, H1). Every call site against them uses
  // createServiceClient(), so the policies were dead code that would have
  // silently opened a read/write surface the day someone added the missing
  // grant — dropped by
  // 20260730104000_grant_authenticated_and_drop_dead_policies.sql rather than
  // granted. Re-adding a policy to any of them means adding the grant too
  // (check 6 enforces that) and removing the entry from this list.
  'notification_digest_state',
  'stay_extension_requests',
  'guidebook_offer_redemptions',
  'vendor_assignment_outcomes',
  'guidebook_guest_sms_optins',
])

// Storage buckets with deliberately NO storage.objects policy: no client ever
// reads or writes them through the authenticated API — access is service-role
// only (RLS denies everything else), and public read, where it applies, goes
// through the public URL endpoint which bypasses RLS entirely. Shrink-only,
// same ratchet as SERVICE_ROLE_ONLY_TABLES: a bucket that gains a client
// upload path must gain org-scoped policies and leave this list.
const SERVICE_ROLE_ONLY_BUCKETS = new Set([
  // No reference anywhere in app/ or lib/ — nothing uploads to it.
  // Exists in production only; never created in the E2E project, which is
  // why the staleness filter below tests bucket existence separately.
  'crew-uploads',
  // Read only, and only via the public URL endpoint
  // (app/g/[slug]/page.tsx:17, app/g/b/[token]/page.tsx:17). No client upload.
  'guidebook-sponsor-photos',
])

// Tables carrying org_id that deliberately have NO FK to organizations.
// Shrink-only.
const ORG_ID_FK_EXCEPTIONS = new Set([
  // Holds the platform-level seed template 'FieldStay STR Standard'
  // (org_id 00000000-0000-0000-0000-000000000000, inserted by
  // 20260608043808_add_maintenance_schedule_templates.sql:67-68 and still
  // referenced by its 18 template items). The sentinel org_id is a
  // "belongs to no tenant" marker; creating an organizations row for it just
  // to satisfy a FK would then violate check 7.
  'maintenance_schedule_templates',
])

// ── PostgREST junction-table allowlist (check 10) ──────────────────────────
// A table whose PRIMARY KEY is exactly two single-column FKs to two different
// tables is read by PostgREST as a many-to-many JUNCTION, and it then offers a
// second embedding path between those two parents. Any pre-existing
// `.select('*, parent(...)')` between them starts returning HTTP 300 /
// PGRST201 "Could not embed because more than one relationship was found".
//
// This is not theoretical: 20260810214329_dynamic_par_engine_schema.sql created
// inventory_consumption_stats with PRIMARY KEY (property_id, inventory_item_id)
// and broke four live call sites between inventory_items and properties — the
// inventory page, inventory/actions.ts, lib/notifications.ts and
// lib/support/account-tools.ts. One E2E test caught it; the other three were
// broken in production with every other check green. Fixed by
// 20260811020000_fix_par_stats_junction_ambiguity.sql.
//
// A GENUINE join table belongs here — the shape is correct for it and the
// many-to-many embed is the point. Everything else is the bug above. EMPTY
// today, and shrink-only in spirit: adding an entry means "yes, I want
// PostgREST to treat this as a join table", which is a design decision, not a
// suppression. Verify the embeds you are making ambiguous before adding one.
const JUNCTION_TABLE_ALLOWLIST = new Set([])

const res = await fetch(new URL('/rest/v1/rpc/db_invariant_report', url), {
  method: 'POST',
  headers: {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  },
  body: '{}',
})

if (!res.ok) {
  // Status code only — the response body is network-controlled data and
  // doesn't belong in CI logs (Sonar S5145 log-injection rule).
  console.error(`db_invariant_report RPC failed: HTTP ${res.status}`)
  console.error(
    'Has supabase/migrations/20260724131000_db_invariant_report.sql been applied to the E2E project?'
  )
  process.exit(1)
}

const report = await res.json()

// A section this script expects but the deployed function doesn't return means
// the target project is running an older db_invariant_report() — fail loudly
// rather than throwing a TypeError on `.length` (or, worse, silently skipping
// the check if it were written defensively).
const REQUIRED_SECTIONS = [
  'tables_without_rls',
  'tables_without_policies',
  'unindexed_fk_columns',
  'anon_grant_tables',
  'dedup_columns_without_unique_index',
  'policies_without_grant',
  'orgs_without_members',
  'storage_policies_not_org_scoped',
  'storage_bucket_ids',
  'storage_buckets_without_policies',
  'org_id_columns_without_fk',
]
const missingSections = REQUIRED_SECTIONS.filter((k) => !Array.isArray(report?.[k]))
if (missingSections.length > 0) {
  console.error(
    `db_invariant_report() is missing section(s): ${missingSections.join(', ')}\n` +
      'The target project is running an older version of the function. Apply ' +
      'supabase/migrations/20260730110000_db_invariant_report_security_sections.sql ' +
      'and 20260731100000_db_invariant_report_storage_bucket_ids.sql.'
  )
  process.exit(1)
}

const failures = []

// ── 1. RLS on every table ─────────────────────────────────────────────────
if (report.tables_without_rls.length > 0) {
  failures.push(
    `Tables WITHOUT row level security: ${report.tables_without_rls.join(', ')}\n` +
      '  Every table gets ALTER TABLE ... ENABLE ROW LEVEL SECURITY in the same ' +
      'migration that creates it (CLAUDE.md, Critical Security Rules #2).'
  )
}

// ── 2. Policy-less tables vs the service-role-only allowlist ──────────────
const noPolicies = new Set(report.tables_without_policies)
const unlisted = [...noPolicies].filter((t) => !SERVICE_ROLE_ONLY_TABLES.has(t))
const staleAllowlist = [...SERVICE_ROLE_ONLY_TABLES].filter((t) => !noPolicies.has(t))

if (unlisted.length > 0) {
  failures.push(
    `RLS-enabled tables with ZERO policies (deny-all): ${unlisted.join(', ')}\n` +
      '  Either write real SELECT/INSERT/UPDATE/DELETE policies, or — if the ' +
      'table is genuinely service-role-only — add it to SERVICE_ROLE_ONLY_TABLES ' +
      'in scripts/check-db-invariants.mjs with that justification.'
  )
}
if (staleAllowlist.length > 0) {
  failures.push(
    `Stale SERVICE_ROLE_ONLY_TABLES entries (table now has policies, or was dropped): ${staleAllowlist.join(', ')}\n` +
      '  Remove them from scripts/check-db-invariants.mjs — the allowlist only shrinks.'
  )
}

// ── 3. Unindexed FK columns ───────────────────────────────────────────────
if (report.unindexed_fk_columns.length > 0) {
  const rows = report.unindexed_fk_columns
    .map((f) => `  ${f.table}(${f.columns}) — ${f.constraint}`)
    .join('\n')
  failures.push(
    `Foreign-key columns with no covering index:\n${rows}\n` +
      '  Add CREATE INDEX IF NOT EXISTS in the same migration as the FK — an ' +
      'unindexed FK sequential-scans the referencing table on every parent ' +
      'DELETE/UPDATE.'
  )
}

// ── 4. anon grants ────────────────────────────────────────────────────────
if (report.anon_grant_tables.length > 0) {
  failures.push(
    `Tables with anon grants: ${report.anon_grant_tables.join(', ')}\n` +
      '  All anon table grants were revoked by ' +
      '20260724130000_revoke_stale_anon_table_grants.sql — no client reads ' +
      'tables unauthenticated (public surfaces go through the service client ' +
      'server-side). Revoke the grant; if a genuinely anon-readable table is ' +
      'ever introduced, that is a security-review conversation, not an allowlist edit.'
  )
}

// ── 5. Dedup/idempotency-key columns without a real unique index ──────────
if (report.dedup_columns_without_unique_index.length > 0) {
  const rows = report.dedup_columns_without_unique_index
    .map((d) => `  ${d.table}.${d.column}`)
    .join('\n')
  failures.push(
    `Dedup-key-named columns with no UNIQUE/partial-unique index:\n${rows}\n` +
      '  A column named like a dedup key (dedupe_key/dedup_key/source_reference_id) ' +
      'must actually be backed by a real UNIQUE or partial-unique index — see ' +
      'notifications.dedupe_key or owner_transactions.source_reference_id for the ' +
      'pattern. Without it, a retried/replayed write can silently create a duplicate row.'
  )
}

// ── 6. Member-facing policies with no matching GRANT ──────────────────────
if (report.policies_without_grant.length > 0) {
  const rows = report.policies_without_grant
    .map((p) => `  ${p.table}.${p.policy} needs ${p.privilege}`)
    .join('\n')
  failures.push(
    `RLS policies facing authenticated/PUBLIC whose table lacks the matching GRANT:\n${rows}\n` +
      '  Postgres checks the GRANT before RLS is ever evaluated, so these ' +
      'policies deny every client query while looking correct — and with the ' +
      'error discarded at the call site it renders as an empty state, not a ' +
      'failure. Either GRANT the privilege to `authenticated` (see ' +
      '20260730104000_grant_authenticated_and_drop_dead_policies.sql), or — if ' +
      'the table is genuinely service-role-only — DROP the dead policy and add ' +
      'the table to SERVICE_ROLE_ONLY_TABLES above.'
  )
}

// ── 7. Organizations with zero members ────────────────────────────────────
if (report.orgs_without_members.length > 0) {
  failures.push(
    `Organizations with ZERO organization_members rows: ${report.orgs_without_members.join(', ')}\n` +
      '  An org no member belongs to is unreachable by RLS forever: it can ' +
      'never be listed, audited or purged, yet it still holds properties, ' +
      'bookings and guest PII. Account deletion must delete the organizations ' +
      'row itself (the ON DELETE CASCADE from every org-scoped table then does ' +
      'the real work) — deleting only the auth user leaves exactly this state.'
  )
}

// ── 8. storage.objects policy coverage ────────────────────────────────────
if (report.storage_policies_not_org_scoped.length > 0) {
  const rows = report.storage_policies_not_org_scoped
    .map((p) => `  ${p.policy} (${p.command})`)
    .join('\n')
  failures.push(
    `storage.objects policies that are NOT org-scoped:\n${rows}\n` +
      '  A policy qualifying on `bucket_id` alone lets any authenticated user ' +
      "of any tenant read, overwrite and delete every other tenant's objects. " +
      'Scope by the owning org via public.storage_org_prefix(name) — see ' +
      '20260730101000_compliance_docs_storage_policies_org_scoped.sql.'
  )
}

const unpolicedBuckets = report.storage_buckets_without_policies.filter(
  (b) => !SERVICE_ROLE_ONLY_BUCKETS.has(b)
)
// An allowlist entry is stale only when the bucket EXISTS in this project and
// is no longer policy-less. A bucket that does not exist here at all is not
// stale: this check runs against the E2E project, but the allowlist describes
// production too, and `crew-uploads` (production-only, no policies, no upload
// call site) was being reported as stale purely for being absent.
const existingBuckets = new Set(report.storage_bucket_ids)
const staleBucketAllowlist = [...SERVICE_ROLE_ONLY_BUCKETS].filter(
  (b) => existingBuckets.has(b) && !report.storage_buckets_without_policies.includes(b)
)
if (unpolicedBuckets.length > 0) {
  failures.push(
    `Storage buckets with no storage.objects policy: ${unpolicedBuckets.join(', ')}\n` +
      '  RLS is enabled on storage.objects, so a bucket with no policy denies ' +
      'every client upload and read — silently, since most upload call sites ' +
      "don't check the error. Add org-scoped policies, or add the bucket to " +
      'SERVICE_ROLE_ONLY_BUCKETS above if no client ever touches it.'
  )
}
if (staleBucketAllowlist.length > 0) {
  failures.push(
    `Stale SERVICE_ROLE_ONLY_BUCKETS entries (bucket now has storage.objects policies): ${staleBucketAllowlist.join(', ')}\n` +
      '  Remove them from scripts/check-db-invariants.mjs — the allowlist only shrinks.'
  )
}

// ── 9. org_id columns with no FK to organizations ─────────────────────────
const orgIdNoFk = report.org_id_columns_without_fk.filter((t) => !ORG_ID_FK_EXCEPTIONS.has(t))
const staleOrgFkAllowlist = [...ORG_ID_FK_EXCEPTIONS].filter(
  (t) => !report.org_id_columns_without_fk.includes(t)
)
if (orgIdNoFk.length > 0) {
  failures.push(
    `Tables with an org_id column and no FK to organizations: ${orgIdNoFk.join(', ')}\n` +
      '  Without the constraint, deleting an organization leaves these rows ' +
      'behind — invisible to RLS and unreachable by any cleanup path. Add ' +
      'REFERENCES organizations(id) ON DELETE CASCADE (plus a covering index) ' +
      'in the same migration that adds the column.'
  )
}
if (staleOrgFkAllowlist.length > 0) {
  failures.push(
    `Stale ORG_ID_FK_EXCEPTIONS entries (table now has the FK, or was dropped): ${staleOrgFkAllowlist.join(', ')}\n` +
      '  Remove them from scripts/check-db-invariants.mjs — the allowlist only shrinks.'
  )
}

// ── 10. Accidental PostgREST junction tables ──────────────────────────────
// Separate RPC from db_invariant_report() so this gate works against a project
// that has not yet had the report function extended; a missing function is a
// hard failure, never a silent skip.
const junctionRes = await fetch(new URL('/rest/v1/rpc/accidental_junction_tables', url), {
  method: 'POST',
  headers: {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  },
  body: '{}',
})

if (!junctionRes.ok) {
  console.error(`accidental_junction_tables RPC failed: HTTP ${junctionRes.status}`)
  console.error(
    'Has supabase/migrations/20260811020000_fix_par_stats_junction_ambiguity.sql ' +
      'been applied to this project?'
  )
  process.exit(1)
}

const junctions = await junctionRes.json()
if (!Array.isArray(junctions)) {
  console.error('accidental_junction_tables() did not return a list.')
  process.exit(1)
}

const unexpectedJunctions = junctions.filter((j) => !JUNCTION_TABLE_ALLOWLIST.has(j.junction_table))
const staleJunctionAllowlist = [...JUNCTION_TABLE_ALLOWLIST].filter(
  (t) => !junctions.some((j) => j.junction_table === t)
)
if (unexpectedJunctions.length > 0) {
  const described = unexpectedJunctions
    .map((j) => `${j.junction_table} (PK ${(j.pk_columns ?? []).join(' + ')} -> ${(j.parents ?? []).join(', ')})`)
    .join('; ')
  failures.push(
    `Tables PostgREST will read as many-to-many junctions: ${described}\n` +
      '  A PK of exactly two single-column FKs to two different tables makes ' +
      "EVERY existing embed between those two parents ambiguous (HTTP 300 / " +
      'PGRST201), including ones written long before this table existed. If ' +
      'the second FK column is derivable from the first, drop it and make the ' +
      'PK single-column. If this really is a join table, add it to ' +
      'JUNCTION_TABLE_ALLOWLIST in scripts/check-db-invariants.mjs.'
  )
}
if (staleJunctionAllowlist.length > 0) {
  failures.push(
    `Stale JUNCTION_TABLE_ALLOWLIST entries (table no longer has that shape, or was dropped): ${staleJunctionAllowlist.join(', ')}\n` +
      '  Remove them from scripts/check-db-invariants.mjs — the allowlist only shrinks.'
  )
}

// ── 11-13. RLS POLICY SEMANTICS ───────────────────────────────────────────
//
// Checks 1 and 2 above prove RLS is ENABLED and that a table HAS a policy.
// Neither says the policy is CORRECT, and the gap between "has a policy" and
// "the policy expresses the right rule" is exactly where a cross-tenant leak
// lives. These three close the highest-value part of that gap without needing
// fixtures or a live session.
//
// Deliberately NOT a full authorization proof: that needs a probe harness that
// authenticates as each role and attempts real reads. These catch the shapes
// that are wrong on their face.
const policyRes = await fetch(new URL('/rest/v1/rpc/rls_policy_report', url), {
  method: 'POST',
  headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(30_000),
})

if (!policyRes.ok) {
  console.error(`rls_policy_report RPC failed: HTTP ${policyRes.status}`)
  console.error('Has supabase/migrations/20260815180332_audit_introspection_rpcs.sql been applied to this project?')
  process.exit(1)
}

const policies = await policyRes.json()
if (!Array.isArray(policies)) {
  console.error('rls_policy_report() did not return an array.')
  process.exit(1)
}

/** service_role bypasses RLS entirely, so its policies constrain nothing. */
const isServiceRoleOnly = (p) => Array.isArray(p.roles) && p.roles.length === 1 && p.roles[0] === 'service_role'

const expr = (p) => `${p.qual ?? ''} ${p.with_check ?? ''}`

/**
 * Tables that are GLOBAL by design — no tenant dimension, so a blanket-true
 * read policy is the intent rather than a leak. Shrink-only: never add a table
 * that has an org_id.
 *
 * That last sentence used to be prose, which is the weakest possible place for
 * the one rule whose violation is silent: an entry here does not merely fail to
 * catch a leak, it AUTHORIZES one, and it does so in a file whose whole purpose
 * is to be trusted. It is now enforced below against the live schema.
 */
const GLOBAL_READABLE_TABLES = new Set([
  'inventory_catalog',    // 115-item platform seed catalog
  'support_kb_chunks',    // support knowledge base, same for every tenant
  // The three inspection FORM-DEFINITION tables (2026-08-22). The forms are
  // platform-owned and identical for every tenant — fixed Safety/Indoor/Outdoor
  // definitions seeded by service role, versioned, with deliberately NO write
  // policy of any kind, so an org can read a form and can never author one.
  // The tenant dimension lives one level down, on `inspections` /
  // `inspection_items`, both of which carry org_id and are scoped normally.
  'inspection_forms',
  'inspection_form_sections',
  'inspection_form_items',
])

// 11. A PERMISSIVE blanket-true policy reachable by a non-service role.
//     Permissive policies are OR-ed, so ONE of these defeats every other
//     policy on the table no matter how carefully the others are written.
const blanketTrue = policies.filter(
  (p) =>
    p.permissive === true &&
    !isServiceRoleOnly(p) &&
    String(p.qual ?? '').trim() === 'true' &&
    !GLOBAL_READABLE_TABLES.has(p.table_name),
)
if (blanketTrue.length > 0) {
  failures.push(
    `Blanket USING (true) policies reachable by a non-service role: ${
      blanketTrue.map((p) => `${p.table_name}.${p.policy_name} [${(p.roles ?? []).join(',')}]`).join(', ')
    }\n  Permissive policies are OR-ed, so one of these grants every row on the ` +
      'table regardless of what the other policies say. Scope it, or — if the ' +
      'table genuinely has no tenant dimension — add it to ' +
      'GLOBAL_READABLE_TABLES in scripts/check-db-invariants.mjs.'
  )
}

// 11a. The allowlist itself, checked against the live schema in both directions.
//
//      An allowlist that grants an exemption is the one kind whose mistakes do
//      not surface as a failure — it surfaces as SILENCE, in exactly the check
//      that was supposed to speak. So it gets its own gate.
//
//      Direction 1 — a listed table that DOES have org_id. This is the comment
//      above turned into a check. `has_org_id` comes from rls_policy_report(),
//      i.e. the live column list, not from anything a reviewer had to notice.
const orgScopedGlobals = [
  ...new Set(
    policies
      .filter((p) => p.has_org_id === true && GLOBAL_READABLE_TABLES.has(p.table_name))
      .map((p) => p.table_name),
  ),
]
if (orgScopedGlobals.length > 0) {
  failures.push(
    `GLOBAL_READABLE_TABLES entries that DO carry org_id: ${orgScopedGlobals.join(', ')}\n` +
      '  This allowlist exempts a table from the blanket-USING(true) gate on the ' +
      'grounds that it has no tenant dimension. A table with org_id has one, so ' +
      'the exemption is granting cross-tenant reads. Remove the entry and scope ' +
      'the policy.'
  )
}

//      Direction 2 — a listed table with no blanket-true policy left to exempt.
//      Shrink-only, same ratchet as SERVICE_ROLE_ONLY_BUCKETS and
//      ORG_ID_FK_EXCEPTIONS above. A dead entry is not untidiness: it is a
//      standing pre-authorization for a policy nobody has written yet, and the
//      day someone does write one this check stays quiet. maintenance_catalog_items
//      was exactly that on both projects when this was added — its only
//      blanket-true policy is service-role-only, which the gate already ignores.
const tablesWithPolicies = new Set(policies.map((p) => p.table_name))
const staleGlobalReadable = [...GLOBAL_READABLE_TABLES].filter(
  (t) =>
    tablesWithPolicies.has(t) &&
    !policies.some(
      (p) =>
        p.table_name === t &&
        p.permissive === true &&
        !isServiceRoleOnly(p) &&
        String(p.qual ?? '').trim() === 'true',
    ),
)
if (staleGlobalReadable.length > 0) {
  failures.push(
    `Stale GLOBAL_READABLE_TABLES entries (no blanket-true policy left to exempt): ${staleGlobalReadable.join(', ')}\n` +
      '  Remove them from scripts/check-db-invariants.mjs — the allowlist only ' +
      'shrinks. Left in place, the entry silently pre-approves a blanket policy ' +
      'that has not been written yet.'
  )
}

// 12. An org-scoped table whose non-service policy scopes by NOTHING.
//
//     Two shapes are legitimately not org-scoped and must not be flagged, both
//     found by running this check against production before it shipped:
//
//       - a DENY policy. `USING (false)` is the familiar form, but an INSERT
//         policy has no USING at all — it denies with `WITH CHECK (false)` and
//         a NULL qual (integration_connections_deny_insert, gc_restrict_insert).
//         Testing only `qual` reported both as unscoped.
//       - a USER-scoped policy. `auth.uid()` is STRICTER than org scoping, not
//         weaker: it admits one person, not one tenant. messages_select,
//         messages_mark_read, push_subscriptions_manage and
//         platform_admins_can_view_job_runs are all correctly scoped this way,
//         and demanding an org predicate on top would be demanding a wider one.
//
//     What remains is the real defect: a policy on an org-scoped table that
//     names neither the tenant nor the user, and does not deny.
const isDeny = (p) =>
  String(p.qual ?? '').trim() === 'false' || String(p.with_check ?? '').trim() === 'false'

const isUserScoped = (p) => expr(p).includes('auth.uid()')

const unscoped = policies.filter(
  (p) =>
    p.has_org_id === true &&
    !isServiceRoleOnly(p) &&
    !expr(p).includes('org_id') &&
    !isUserScoped(p) &&
    !isDeny(p),
)
if (unscoped.length > 0) {
  failures.push(
    `Policies on org-scoped tables with no org_id predicate: ${
      unscoped.map((p) => `${p.table_name}.${p.policy_name} (${p.cmd})`).join(', ')
    }\n  The table carries org_id but this policy scopes by neither org_id ` +
      'nor auth.uid(), and does not deny — so it is not scoped to anything. ' +
      'Add the tenant predicate.'
  )
}

// 13. UPDATE (or ALL) with USING but no WITH CHECK.
//     USING decides which rows are VISIBLE to the update; WITH CHECK decides
//     what they may be changed TO. Without it a caller can read their own row
//     and write another org's id into it — CLAUDE.md states both are required.
const noWithCheck = policies.filter(
  (p) =>
    (p.cmd === 'UPDATE' || p.cmd === 'ALL') &&
    !isServiceRoleOnly(p) &&
    p.qual !== null &&
    p.with_check === null &&
    String(p.qual ?? '').trim() !== 'false',   // a deny-all USING (false) admits no rows
)

if (noWithCheck.length > 0) {
  failures.push(
    `UPDATE/ALL policies with USING but no WITH CHECK: ${
      noWithCheck.map((p) => `${p.table_name}.${p.policy_name}`).join(', ')
    }\n  USING selects which rows may be updated; WITH CHECK constrains what ` +
      'they may be updated TO. Without it a row can be written to a value the ' +
      'policy would never have selected — including another org\'s id.'
  )
}

// 14. Every `.upsert(..., { onConflict: 'a,b' })` must name an arbiter that
//     Postgres can actually resolve.
//
//     This exists because it already shipped and cost a feature outright. On
//     2026-06-20 a migration replaced push_subscriptions' plain unique
//     constraint with two PARTIAL unique indexes. Postgres can only use a
//     partial index as an ON CONFLICT arbiter when the statement supplies the
//     matching predicate (`ON CONFLICT (cols) WHERE ...`), and Supabase JS's
//     `onConflict` takes a column list with no way to express one — so both
//     push-subscribe routes raised 42P10 on every request. push_subscriptions
//     held ZERO rows for two months: nobody, crew or PM, had ever successfully
//     subscribed to a push notification.
//
//     An EXPRESSION index (e.g. `(org_id, lower(email))`) is unnamable for the
//     same reason, which is why has_expression is checked too.
//
//     Not a text-only guardrail: the source says `onConflict: 'a,b'` and only
//     the live catalog knows whether an index matching those columns exists and
//     is plain. That split is exactly why nothing caught this in June.
const UPSERT_ARBITER_ALLOWLIST = new Set([
  // SHRINK-ONLY. EMPTY as of 2026-08-18, which makes this a hard gate: any
  // `onConflict` naming columns with no plain unique index behind them now
  // fails CI outright.
  //
  // It held two entries, both live bugs rather than exemptions, and both are
  // now fixed by 20260818012532_upsert_rpcs_for_partial_expression_indexes.sql:
  //
  //   vendors:(org_id,email) — the matching index is
  //   (org_id, lower(email)) WHERE email IS NOT NULL, an expression index AND a
  //   partial one. Now written through upsert_vendor_by_email().
  //
  //   checklist_templates:(property_id,org_id) — no unique index on that pair
  //   exists, and adding one would cap a property at a single template. The
  //   real invariant is the partial (property_id) WHERE is_default. Now written
  //   through upsert_default_checklist_template().
  //
  // Neither could be fixed by matching the code with a new plain index — see
  // that migration's header. Do not add entries here; fix the site.
])

const ONCONFLICT_RE = /onConflict:\s*'([^']+)'/g
const FROM_TABLE_RE = /\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)/g

/** Every `.tsx?` file under `dir`, recursively. */
function sourceFilesUnder(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    // A root that does not exist is not a failure — this script also runs from
    // a checkout where `components/` may be absent. Anything else here would be
    // a permissions problem the very next read would surface anyway.
    return []
  }

  return entries.flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * Blanks out WHOLE-LINE comments (and block-comment bodies), so prose that
 * quotes an `onConflict:` is not scanned as a call site.
 *
 * This is not hypothetical tidiness: the fix that emptied the allowlist above
 * documents, in a comment at each repaired call site, the exact broken spelling
 * it replaced — and that comment matched this scanner, so the check failed on
 * the very change that fixed it.
 *
 * Deliberately conservative. Only lines whose first non-space character starts
 * a comment are cleared; a trailing `//` is NOT stripped, because a string
 * literal containing one (`'https://…'`) would truncate the rest of a real line
 * and turn a live bug into a silent pass. Over-scanning is recoverable; a false
 * negative in a gate is not.
 *
 * Lines are replaced by an empty line rather than deleted so that anything
 * keyed on position still lines up.
 */
function stripCommentLines(src) {
  let inBlock = false
  return src.split('\n').map((line) => {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      return ''
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      return ''
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return ''
    return line
  }).join('\n')
}

/**
 * Each `onConflict: 'a,b'` in a file, paired with the nearest PRECEDING
 * `.from('table')` — which is how every one of these chains is written.
 */
function onConflictSitesIn(file) {
  const src = stripCommentLines(readFileSync(file, 'utf8'))
  if (!src.includes('onConflict')) return []

  return [...src.matchAll(ONCONFLICT_RE)].flatMap((match) => {
    const preceding = [...src.slice(0, match.index).matchAll(FROM_TABLE_RE)]
    const table = preceding.at(-1)?.[1]
    if (!table) return []
    return [{ file, table, columns: match[1].split(',').map((c) => c.trim()) }]
  })
}

const onConflictSites = ['app', 'lib', 'components']
  .flatMap(sourceFilesUnder)
  .flatMap(onConflictSitesIn)

const shapesRes = await rpc('unique_index_shapes')
if (shapesRes === null) {
  failures.push(
    'unique_index_shapes() RPC is missing — has ' +
      'supabase/migrations/20260817172241_push_subscriptions_plain_unique_indexes.sql ' +
      'been applied to this project?'
  )
} else {
  /**
   * Do two column lists name the same columns, order-independent?
   *
   * ON CONFLICT does not care about key order — `(a, b)` and `(b, a)` name the
   * same arbiter — so this compares as sets.
   *
   * Set membership rather than sort-and-join, which is what this was. Sorting
   * without a comparator is Sonar S2871 (a CRITICAL bug, because the default
   * sort stringifies its elements), and the usual fix of passing a comparator
   * would only be satisfying the rule: these are index key columns, so they are
   * unique by definition and there was never anything for an ORDER to mean.
   * Membership says what is actually being asked, and is O(n) rather than
   * O(n log n) besides.
   */
  const sameSet = (a, b) => {
    if (a.length !== b.length) return false
    const inA = new Set(a)
    return b.every((column) => inA.has(column))
  }

  const unnamable = []

  for (const site of onConflictSites) {
    const key = `${site.table}:${site.columns.join(',')}`
    if (UPSERT_ARBITER_ALLOWLIST.has(key)) continue

    const candidates = shapesRes.filter((s) => s.table_name === site.table)
    const usable = candidates.some(
      (s) => !s.is_partial && !s.has_expression && sameSet(s.key_columns ?? [], site.columns),
    )
    if (!usable) {
      const near = candidates
        .filter((s) => sameSet(s.key_columns ?? [], site.columns))
        .map((s) => `${s.index_name}${s.is_partial ? ' [PARTIAL]' : ''}${s.has_expression ? ' [EXPRESSION]' : ''}`)
      unnamable.push(
        `${site.file}: .from('${site.table}') onConflict '${site.columns.join(',')}'` +
          (near.length ? ` — matching index is unusable as an arbiter: ${near.join(', ')}` : ' — no unique index on those columns'),
      )
    }
  }

  if (unnamable.length > 0) {
    failures.push(
      `upsert onConflict targets with no resolvable arbiter:\n  ${unnamable.join('\n  ')}\n` +
        '  Postgres raises 42P10 at RUNTIME for each of these — the upsert never ' +
        'succeeds. A PARTIAL index needs `ON CONFLICT (cols) WHERE <predicate>`, ' +
        'and an EXPRESSION index cannot be named by a column list at all; ' +
        "Supabase JS's onConflict can express neither. Either make the unique " +
        'index plain, or move the write into an RPC that spells the predicate.'
    )
  }
}

// ── 15. Every public relation must be SELECT-able by service_role ─────────
//
//     A GRANT is checked BEFORE RLS is evaluated, and service_role's BYPASSRLS
//     does nothing about a missing one — bypassing row security is not the same
//     as being allowed to touch the object.
//
//     public.vendor_compliance_status shipped with `authenticated: SELECT` and
//     no service_role grant at all, which took vendor auto-suggestion down with
//     42501 ("permission denied for view"). Every other relation in public had
//     the grant; nothing compared them. Same class as
//     20260710200000_grant_authenticated_missing_tables, one role over.
//
//     No allowlist. service_role is the platform's own client and there is no
//     object it should be denied — an object it cannot read is a 42501 waiting
//     for the first Inngest function that touches it.
{
  const gaps = await rpc('service_role_grant_gaps')

  if (gaps === null) {
    failures.push(
      'service_role_grant_gaps() RPC is missing — has ' +
        '20260820234500_grant_service_role_vendor_compliance_status.sql been applied ' +
        'to this project?'
    )
  } else if (gaps.length > 0) {
    const lines = gaps.map(
      (g) => `${g.kind} ${g.relation}` +
        (g.has_authenticated_select
          ? ' (authenticated CAN select it — the grant was written for one role and not the other)'
          : ' (no role can select it)'),
    )
    failures.push(
      `relations service_role cannot SELECT:\n  ${lines.join('\n  ')}\n` +
        '  Postgres raises 42501 at RUNTIME for every service-role read of these, ' +
        'before RLS is even consulted. Add `GRANT SELECT ON public.<rel> TO service_role;`.'
    )
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`DB invariant check FAILED (${failures.length} finding${failures.length === 1 ? '' : 's'}):\n`)
  for (const f of failures) console.error(`✗ ${f}\n`)
  process.exit(1)
}

console.log(
  'DB invariants OK — RLS on every table, no unexpected deny-all tables, ' +
    'all FK columns indexed, zero anon grants, all dedup-key columns indexed ' +
    'unique, every member-facing policy backed by its GRANT, no memberless ' +
    'orgs, every storage policy org-scoped, every org_id column FK-backed, ' +
    'no accidental PostgREST junction tables, no blanket-true or unscoped or ' +
    'WITH CHECK-less policies, every relation readable by service_role.'
)
