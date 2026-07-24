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
  'stripe_processed_events',
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
  console.error(`db_invariant_report RPC failed: HTTP ${res.status} — ${await res.text()}`)
  console.error(
    'Has supabase/migrations/20260724131000_db_invariant_report.sql been applied to the E2E project?'
  )
  process.exit(1)
}

const report = await res.json()
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

// ── Verdict ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`DB invariant check FAILED (${failures.length} finding${failures.length === 1 ? '' : 's'}):\n`)
  for (const f of failures) console.error(`✗ ${f}\n`)
  process.exit(1)
}

console.log(
  'DB invariants OK — RLS on every table, no unexpected deny-all tables, ' +
    'all FK columns indexed, zero anon grants.'
)
