#!/usr/bin/env node
/**
 * FieldStay — migration ledger parity check (structural enforcement, Tier 4).
 *
 * Diffs `supabase/migrations/*.sql` against the target project's
 * `supabase_migrations.schema_migrations` ledger, via
 * public.migration_ledger_versions() (see
 * supabase/migrations/20260804040355_migration_ledger_versions.sql).
 *
 * ── The defect this encodes ───────────────────────────────────────────────
 *
 * The ledger is what `supabase db push` consults to decide what is already
 * applied. Nothing kept it honest, and the 2026-08-03 pre-launch audit (H10)
 * found production diverged in BOTH directions at once:
 *
 *   - 36 local files with NO ledger row. Written and committed, but the live
 *     history had no record of them — `db push` would replay all 36.
 *   - 35 ledger rows with NO local file. Applied through MCP apply_migration
 *     (which records live history without ever writing a file), or orphaned
 *     when a local file was renumbered at merge time and the row already
 *     recorded under the old version stayed behind.
 *
 * Both are invisible from the repo, and neither shows up in any schema-level
 * check — the SCHEMA was correct throughout. What was broken was the claim
 * that the repo could reproduce it. Two of those 35 were SECURITY DEFINER
 * functions (billing plan updates, a crew-write trigger guard) that existed in
 * production and in no file anywhere, so a fresh environment built from
 * supabase/migrations/ would silently have lacked them.
 *
 * The consequence is worse than a replay: `db push` applies pending
 * migrations in version order, and this repo contains a revoke/restore pair
 * (20260801280000 revokes a grant, 20260801290000 restores it) where a
 * partial or reordered replay breaks work-order inserts.
 *
 * ── Why a baseline, and why it is not a suppression ───────────────────────
 *
 * Production was reconciled on 2026-08-03 and is at exact 1:1 parity, so its
 * baseline below is EMPTY — this is a hard gate for prod from today.
 *
 * The E2E project is not. Its schema is current (verified by spot-check: every
 * object from the newest migrations is present), but its ledger carries a
 * large frozen divergence from the same two causes, inherited when the project
 * was branched from production in July 2026 and never repaired. Failing on all
 * of it today would just mean a permanently red required check, which is a
 * check nobody reads.
 *
 * So the divergence is FROZEN per project, shrink-only, in
 * scripts/migration-ledger-baseline.json. A version not in that frozen set
 * fails — and a NEW migration is by definition not in it, so from today
 * forward parity is mandatory in both directions on both projects. An entry
 * that reaches parity must be REMOVED from the baseline; a stale entry is
 * itself a failure, same ratchet as SERVICE_ROLE_ONLY_TABLES in
 * check-db-invariants.mjs and .semgrep/baseline-counts.json.
 *
 * Never add an entry to silence a failure. Record the migration, or write the
 * missing file. `node scripts/check-migration-ledger.mjs --update` exists to
 * lock in a burn-down, not to absorb new drift — it refuses to grow a set.
 *
 * ── Running it ────────────────────────────────────────────────────────────
 *
 *   pnpm run check:migration-ledger        # whatever NEXT_PUBLIC_SUPABASE_URL points at
 *   pnpm run check:migration-ledger:prod   # deliberate, read-only production run
 *
 * Runs in the CI `db-invariants` job, which has NO install step: Node builtins
 * and global fetch only (unit/guardrails/ci-gating.test.ts enforces that). The
 * arming/production preamble below is duplicated from check-db-invariants.mjs
 * rather than shared, because ci-gating.test.ts asserts on each script's own
 * source text — a shared import would read as an absent guard.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'scripts', 'migration-ledger-baseline.json')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')

const updating = process.argv.includes('--update')
// Seeding is a separate, deliberate act from burning down. --update is
// shrink-only by construction, so a project with no entry yet can never be
// recorded through it; --seed is that one-time path, and it refuses to touch a
// project that already has an entry. Keeping them distinct is what stops
// "absorb the new drift" from being one flag away from "lock in the burn-down".
const seeding = process.argv.includes('--seed')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  // Forks legitimately have no secrets, so warn-and-pass stays the default.
  // On the canonical repo an unarmed run is a silent skip wearing a green
  // check — DB_INVARIANTS_REQUIRE_ARMED is what separates the two.
  if (process.env.DB_INVARIANTS_REQUIRE_ARMED === '1') {
    console.error(
      'Migration ledger gate is REQUIRED on this run but UNARMED: ' +
        'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
        'Passing here would report a green check for a ledger nobody compared. ' +
        'Configure the E2E secrets (docs/E2E_SETUP.md), or unset ' +
        'DB_INVARIANTS_REQUIRE_ARMED if this run genuinely cannot hold them.'
    )
    process.exit(1)
  }

  console.log(
    '::warning title=Migration ledger gate UNARMED::NEXT_PUBLIC_SUPABASE_URL / ' +
      'SUPABASE_SERVICE_ROLE_KEY are not configured, so supabase/migrations/ was ' +
      'NOT compared against the live migration ledger. Follow docs/E2E_SETUP.md ' +
      'to arm the gate.'
  )
  process.exit(0)
}

const PROD_PROJECT_REF = 'vpmznjktllhmmbfnxuvk'
const allowProd = process.env.DB_INVARIANTS_ALLOW_PROD === '1'

if (url.includes(PROD_PROJECT_REF) && !allowProd) {
  console.error(
    'Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at the PRODUCTION ' +
      'Supabase project. CI must use the dedicated E2E project — see ' +
      'docs/E2E_SETUP.md.\n' +
      'If you MEANT to verify production (this check is read-only — ' +
      'migration_ledger_versions() performs no DDL or DML), re-run with ' +
      'DB_INVARIANTS_ALLOW_PROD=1, or use: pnpm run check:migration-ledger:prod'
  )
  process.exit(1)
}

/** `https://<ref>.supabase.co` → `<ref>`. Baselines are keyed by project. */
const projectRef = new URL(url).hostname.split('.')[0] ?? ''

// ── Local files ───────────────────────────────────────────────────────────
// migration-hygiene.test.ts already enforces the YYYYMMDDHHMMSS_name.sql shape
// and version uniqueness, so a plain 14-char slice is safe here.
const localFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
const localVersions = new Set(localFiles.map((f) => f.slice(0, 14)))

// ── Live ledger ───────────────────────────────────────────────────────────
// An unreachable host (bad URL, DNS, network) otherwise surfaces as an
// unhandled rejection and a raw undici stack trace in the CI log. It still
// fails closed, but the message has to say which check broke and why.
let res
try {
  res = await fetch(new URL('/rest/v1/rpc/migration_ledger_versions', url), {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  })
} catch (err) {
  // Cause only — the message can carry the resolved host, and NEXT_PUBLIC_
  // SUPABASE_URL is not something to echo into a log verbatim.
  console.error(
    `Could not reach the Supabase REST API to read the migration ledger: ${
      err instanceof Error ? err.constructor.name : 'unknown error'
    }. Check NEXT_PUBLIC_SUPABASE_URL and network access.`
  )
  process.exit(1)
}

if (!res.ok) {
  // Status only — the response body is network-controlled data and doesn't
  // belong in CI logs (Sonar S5145 log-injection rule).
  console.error(`migration_ledger_versions RPC failed: HTTP ${res.status}`)
  console.error(
    'Has supabase/migrations/20260804040355_migration_ledger_versions.sql been ' +
      'applied to this project?'
  )
  process.exit(1)
}

const ledger = await res.json()
if (!Array.isArray(ledger)) {
  console.error('migration_ledger_versions() did not return an array of versions.')
  process.exit(1)
}
const ledgerVersions = new Set(ledger.map(String))

// ── Divergence ────────────────────────────────────────────────────────────
const sorted = (s) => [...s].sort((a, b) => a.localeCompare(b))
const localOnly = sorted(new Set([...localVersions].filter((v) => !ledgerVersions.has(v))))
const ledgerOnly = sorted(new Set([...ledgerVersions].filter((v) => !localVersions.has(v))))

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
// An unknown project gets NO grandfathering — strict parity is the right
// default for a project this repo has never made an exception for.
const recorded = baseline.projects?.[projectRef]
const frozen = recorded ?? { label: projectRef, localOnly: [], ledgerOnly: [] }
const frozenLocalOnly = new Set(frozen.localOnly ?? [])
const frozenLedgerOnly = new Set(frozen.ledgerOnly ?? [])

if (seeding) {
  if (recorded) {
    console.error(
      `${projectRef} already has a baseline entry. --seed only records a project ` +
        'for the first time; use --update to lock in a burn-down, or fix the drift.'
    )
    process.exit(1)
  }
  baseline.projects ??= {}
  baseline.projects[projectRef] = { label: projectRef, localOnly, ledgerOnly }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(
    `Seeded baseline for ${projectRef}: ${localOnly.length} local-only, ` +
      `${ledgerOnly.length} ledger-only. Review this diff — every entry is a ` +
      'real divergence being grandfathered, not a clean slate.'
  )
  process.exit(0)
}

if (updating) {
  const grew = [
    ...localOnly.filter((v) => !frozenLocalOnly.has(v)),
    ...ledgerOnly.filter((v) => !frozenLedgerOnly.has(v)),
  ]
  if (grew.length > 0) {
    console.error(
      `--update refuses to GROW the frozen set for ${projectRef}. New divergence:\n` +
        grew.map((v) => `  ${v}`).join('\n') +
        '\n  This mode exists to lock in a burn-down, not to absorb new drift. ' +
        'Record the migration in the ledger, or write the missing local file.'
    )
    process.exit(1)
  }
  baseline.projects ??= {}
  baseline.projects[projectRef] = { label: frozen.label ?? projectRef, localOnly, ledgerOnly }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(
    `Baseline updated for ${projectRef}: ${localOnly.length} local-only, ${ledgerOnly.length} ledger-only.`
  )
  process.exit(0)
}

const failures = []

const newLocalOnly = localOnly.filter((v) => !frozenLocalOnly.has(v))
const newLedgerOnly = ledgerOnly.filter((v) => !frozenLedgerOnly.has(v))
const staleLocalOnly = [...frozenLocalOnly].filter((v) => !localOnly.includes(v)).sort()
const staleLedgerOnly = [...frozenLedgerOnly].filter((v) => !ledgerOnly.includes(v)).sort()

// Built once, not re-read per offending version — 70 findings would otherwise
// be 70 directory scans.
const fileByVersion = new Map(localFiles.map((f) => [f.slice(0, 14), f]))
const fileFor = (version) => fileByVersion.get(version) ?? `${version}_*.sql`

if (newLocalOnly.length > 0) {
  failures.push(
    `Local migration files with NO row in the live ledger (${projectRef}):\n` +
      newLocalOnly.map((v) => `  ${fileFor(v)}`).join('\n') +
      '\n  `supabase db push` believes these are pending and will REPLAY them. ' +
      'Either apply them for real, or — if the schema change is already live and ' +
      'only the bookkeeping is missing — record them:\n' +
      `    supabase migration repair --status applied ${newLocalOnly[0]}\n` +
      '  Applying schema through MCP apply_migration without committing the ' +
      'matching file is what produces the mirror-image half of this.'
  )
}

if (newLedgerOnly.length > 0) {
  failures.push(
    `Ledger rows with NO local migration file (${projectRef}):\n` +
      newLedgerOnly.map((v) => `  ${v}`).join('\n') +
      '\n  The repo cannot reproduce this database: a fresh environment built ' +
      'from supabase/migrations/ would be missing whatever these applied. Two ' +
      'causes, two different fixes:\n' +
      '    - Applied via MCP apply_migration with no file written → recover the ' +
      'SQL from supabase_migrations.schema_migrations.statements and commit it ' +
      'as a real migration file at that version.\n' +
      '    - A local file was renumbered after being applied → the row is an ' +
      'orphan of the old version, so drop it:\n' +
      `        supabase migration repair --status reverted ${newLedgerOnly[0]}`
  )
}

if (staleLocalOnly.length > 0 || staleLedgerOnly.length > 0) {
  failures.push(
    `Stale entries in scripts/migration-ledger-baseline.json for ${projectRef} ` +
      '(these versions are now at parity):\n' +
      [...staleLocalOnly, ...staleLedgerOnly].map((v) => `  ${v}`).join('\n') +
      '\n  Remove them — the frozen set only shrinks. Lock the burn-down in with:\n' +
      '    node scripts/check-migration-ledger.mjs --update'
  )
}

if (failures.length > 0) {
  console.error(
    `Migration ledger check FAILED (${failures.length} finding${failures.length === 1 ? '' : 's'}):\n`
  )
  for (const f of failures) console.error(`✗ ${f}\n`)
  process.exit(1)
}

const frozenTotal = frozenLocalOnly.size + frozenLedgerOnly.size
console.log(
  `Migration ledger OK for ${frozen.label ?? projectRef} — ${localVersions.size} local files, ` +
    `${ledgerVersions.size} ledger rows` +
    (frozenTotal > 0
      ? `, ${frozenTotal} frozen pre-existing divergence${frozenTotal === 1 ? '' : 's'} unchanged.`
      : ', exact 1:1 parity.')
)
