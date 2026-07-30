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
 * (docs/E2E_SETUP.md) — never production; CI must not hold prod credentials.
 * Both projects receive every migration, so schema-level invariants verified
 * on the E2E project hold for production by construction. Grant state is the
 * one exception (it isn't purely migration-driven — Supabase default
 * privileges differ per project), which is why check 4 demands ZERO rather
 * than diffing a baseline.
 *
 * Self-disarms with a CI warning annotation when the E2E secrets are absent,
 * mirroring the e2e job's gate.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.log(
    '::warning title=DB invariant gate UNARMED::NEXT_PUBLIC_SUPABASE_URL / ' +
      'SUPABASE_SERVICE_ROLE_KEY are not configured, so database invariants ' +
      '(RLS on every table, FK indexes, anon-grant hygiene) were NOT checked. ' +
      'Follow docs/E2E_SETUP.md to arm the gate.'
  )
  process.exit(0)
}

const PROD_PROJECT_REF = 'vpmznjktllhmmbfnxuvk'
if (url.includes(PROD_PROJECT_REF)) {
  console.error(
    'Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION ' +
      'Supabase project. CI must use the dedicated E2E project — see ' +
      'docs/E2E_SETUP.md.'
  )
  process.exit(1)
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
  'storage_buckets_without_policies',
  'org_id_columns_without_fk',
]
const missingSections = REQUIRED_SECTIONS.filter((k) => !Array.isArray(report?.[k]))
if (missingSections.length > 0) {
  console.error(
    `db_invariant_report() is missing section(s): ${missingSections.join(', ')}\n` +
      'The target project is running an older version of the function. Apply ' +
      'supabase/migrations/20260730110000_db_invariant_report_security_sections.sql.'
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
const staleBucketAllowlist = [...SERVICE_ROLE_ONLY_BUCKETS].filter(
  (b) => !report.storage_buckets_without_policies.includes(b)
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
    `Stale SERVICE_ROLE_ONLY_BUCKETS entries (bucket now has policies, or was dropped): ${staleBucketAllowlist.join(', ')}\n` +
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
    'orgs, every storage policy org-scoped, every org_id column FK-backed.'
)
