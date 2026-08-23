#!/usr/bin/env node
/**
 * FieldStay — types/database.ts drift check (structural enforcement, Tier 3
 * check 4 — the enforcement leftover from PR #505's db-invariants job).
 *
 * check-db-invariants.mjs polices schema-level SECURITY invariants
 * (RLS/grants/FK indexes); this script polices SHAPE drift between the live
 * schema and the hand-maintained types/database.ts — the class of bug that
 * cost real debugging time when the E2E project's wo_status enum silently
 * lacked 'quote_requested' (present on production, never captured in a
 * tracked migration), making every /maintenance board query fail invisibly
 * there (see supabase/migrations/20260725043000_add_quote_requested_to_wo_status.sql).
 * This check makes that class of drift a CI failure instead of a mystery.
 *
 * It calls public.db_type_shape_report() (see
 * supabase/migrations/20260725200500_db_type_shape_report.sql) against the
 * E2E project and diffs it against a mechanical parse of types/database.ts.
 *
 * ── What this DOES check ─────────────────────────────────────────────────
 *   1. Enum drift: every Postgres enum type's label set vs. the matching
 *      hand-written TS union type (see ENUM_MAP below for the name
 *      mapping — Postgres snake_case type name -> TS PascalCase type name).
 *      This is the check the wo_status incident needed and didn't have.
 *   2. Table presence: every `public` BASE TABLE vs. every entry in
 *      `Database.public.Tables` in types/database.ts, both directions.
 *   3. Column presence (bonus, best-effort): for any table wired into the
 *      `Database.public.Tables` map, the columns of its `Row` interface vs.
 *      the live table's columns, both directions.
 *
 * ── What this does NOT check (explicitly out of scope) ──────────────────
 *   - Column nullability strictness, precision/scale, or exact Postgres
 *     type vs. TS type compatibility — only column PRESENCE is diffed.
 *   - Views (`vendor_compliance_status`) — db_type_shape_report() only
 *     covers BASE TABLEs; types/database.ts models views separately under
 *     `Database.public.Views`, which this script does not parse.
 *   - CHECK-constraint-based unions on plain `text` columns (e.g.
 *     `InventoryCountDraft.status`, `AutoAssignMode`) — only real Postgres
 *     `CREATE TYPE ... AS ENUM` types are compared, since those are the only
 *     ones db_type_shape_report() can see via pg_enum.
 *   - Anything about `auth`/`storage`/`vault` schemas — public schema only.
 *
 * types/database.ts is parsed with regexes, not a TS compiler — it is a
 * hand-written file with a consistent-enough shape
 * (`export type Foo = 'a' | 'b' | ...`, `export interface Foo { field: T }`,
 * `table_name: { Row: Foo; ... }`) for this to be reliable, but a
 * sufficiently unusual edit (e.g. a union spread across a `type` alias
 * built from other aliases) could parse as "field/value not found" rather
 * than a true positive — false negatives (missed real drift) are more
 * likely than false positives here, so treat a clean run as "no drift found
 * in the parseable subset," not an absolute guarantee.
 *
 * Self-disarms with a CI warning annotation when the E2E secrets are
 * absent, mirroring check-db-invariants.mjs and the e2e job.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TYPES_PATH = path.join(__dirname, '..', 'types', 'database.ts')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  // See scripts/check-db-invariants.mjs for the full reasoning: forks have no
  // secrets and must not sit on a permanently red required check, but on the
  // canonical repo a silent skip is a green check for work nobody did.
  if (process.env.DB_INVARIANTS_REQUIRE_ARMED === '1') {
    console.error(
      'Type drift gate is REQUIRED on this run but UNARMED: ' +
        'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
        'Configure the E2E secrets (docs/E2E_SETUP.md), or unset ' +
        'DB_INVARIANTS_REQUIRE_ARMED if this run genuinely cannot hold them.'
    )
    process.exit(1)
  }

  console.log(
    '::warning title=Type drift gate UNARMED::NEXT_PUBLIC_SUPABASE_URL / ' +
      'SUPABASE_SERVICE_ROLE_KEY are not configured, so types/database.ts ' +
      'was NOT diffed against the live schema. Follow docs/E2E_SETUP.md to ' +
      'arm the gate.'
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

// ── Postgres enum type name -> TS union type name ──────────────────────────
// Every enum currently in the public schema (38 as of 2026-08-22, when the
// four inspection_* enums landed with phase 1; 34 before that, verified
// against both live projects on 2026-07-25). Add the pair here the same commit a new
// `CREATE TYPE ... AS ENUM` migration ships alongside its TS union.
const ENUM_MAP = {
  asset_scan_status:    'AssetScanStatus',
  asset_type:           'AssetType',
  booking_source:       'BookingSource',
  booking_status:       'BookingStatus',
  checklist_status:     'ChecklistStatus',
  comm_channel:         'CommChannel',
  comm_recipient_type:  'CommRecipientType',
  comm_source:          'CommSource',
  compliance_doc_type:  'ComplianceDocType',
  contact_pref:         'ContactPref',
  crew_role:            'CrewRole',
  ical_source:          'IcalSource',
  inspection_action:    'InspectionAction',
  inspection_remediation: 'InspectionRemediation',
  inspection_repeat_answer: 'InspectionRepeatAnswer',
  inspection_response_type: 'InspectionResponseType',
  inspection_result:    'InspectionResult',
  inventory_category:   'InventoryCategory',
  line_item_type:       'LineItemType',
  macrs_class:          'MacrsClass',
  member_role:          'MemberRole',
  org_plan:             'OrgPlan',
  org_plan_status:      'OrgPlanStatus',
  par_mode:             'ParMode',
  par_smart_group:      'ParSmartGroup',
  po_status:            'PoStatus',
  priority_level:       'PriorityLevel',
  property_type:        'PropertyType',
  quote_request_status: 'QuoteRequestStatus',
  schedule_frequency:   'ScheduleFrequency',
  schedule_type:        'ScheduleType',
  support_category:     'SupportCategory',
  support_message_role: 'SupportMessageRole',
  sync_status:          'SyncStatus',
  turnover_status:      'TurnoverStatus',
  txn_category:         'TxnCategory',
  txn_type:             'TxnType',
  vendor_specialty:     'VendorSpecialty',
  wo_category:          'WoCategory',
  wo_source:            'WoSource',
  wo_status:            'WoStatus',
}

// ── Known, deliberate table/column mismatches ───────────────────────────────
// Shrink-only, same convention as SERVICE_ROLE_ONLY_TABLES in
// check-db-invariants.mjs — a stale entry (table/column now modeled, or
// dropped) is itself a failure this script will report.
const TABLE_ALLOWLIST = new Set([
  // Never queried via .from() anywhere in app code — read only through
  // SECURITY DEFINER RPCs (is_platform_staff_admin) or Postgres triggers
  // (next_wo_number()), so there is no typed call site that needs a Row
  // interface. See 20260622121938_observability_platform_admin_tables.sql.
  'platform_admins',
  'system_job_runs',
  // Internal sequence table for work_orders.wo_number, mutated only inside
  // the next_wo_number() Postgres function — never selected/inserted
  // directly from application code.
  'wo_number_counters',
])

// column allowlist entries are `${table}.${column}`
const COLUMN_ALLOWLIST = new Set([
  // Deprecated, superseded by assigned_crew_member_id — CLAUDE.md's
  // "Things That Will Break If You Do Them" table calls this out
  // explicitly; the column must never be reintroduced into app code, so it
  // deliberately has no place in WorkOrder.
  'work_orders.assigned_crew_id',
  // Relationship/join fields populated only by a nested Supabase select
  // (`turnovers(*, turnover_assignments(*, crew_members(...)))`), not real
  // columns on the underlying table — db_type_shape_report() only reports
  // physical columns, so these will always show as "TS-only".
  'turnovers.turnover_assignments',
  'turnover_assignments.crew_members',
])

// ── Fetch live shape ────────────────────────────────────────────────────────

const res = await fetch(new URL('/rest/v1/rpc/db_type_shape_report', url), {
  method: 'POST',
  headers: {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  },
  body: '{}',
})

if (!res.ok) {
  console.error(`db_type_shape_report RPC failed: HTTP ${res.status}`)
  console.error(
    'Has supabase/migrations/20260725200500_db_type_shape_report.sql been applied to the E2E project?'
  )
  process.exit(1)
}

const report = await res.json()
const dbTables = report.tables ?? {}
const dbEnums  = report.enums ?? {}

// ── Parse types/database.ts ─────────────────────────────────────────────────

const src = readFileSync(TYPES_PATH, 'utf8')

// 1. Union type declarations: `export type Foo = 'a' | 'b' | ...` — may span
//    multiple lines when the union is long (e.g. AssetType, WoCategory).
//    Stops at the first line that doesn't continue the union (blank line,
//    comment, or a new declaration).
function parseUnionTypes(text) {
  const unions = {}
  // `text` is always this repo's own committed types/database.ts, never
  // attacker-controlled input, so ReDoS is not a real risk here.
  const re = /^export type (\w+)\s*=\s*([\s\S]*?)(?=\n(?:export |\/\/|$))/gm // NOSONAR
  for (const m of text.matchAll(re)) {
    const [, name, body] = m
    const values = [...body.matchAll(/'([^']+)'/g)].map((v) => v[1])
    if (values.length > 0) unions[name] = values
  }
  return unions
}

// 2. `export interface Foo { field: Type | null; ... }` — one level, no
//    nested braces other than Record<string, T> etc. (which don't contain
//    a bare `{` on their own line so the naive brace-match below is fine).
function parseInterfaces(text) {
  const ifaces = {}
  const re = /^export interface (\w+)\s*\{\n([\s\S]*?)^\}/gm
  for (const m of text.matchAll(re)) {
    const [, name, body] = m
    const fields = {}
    // `line` comes from this repo's own committed types/database.ts, never
    // attacker-controlled input, so ReDoS is not a real risk here.
    for (const line of body.split('\n')) {
      const f = line.match(/^\s{2}(\w+)\??:\s*(.+?)\s*$/) // NOSONAR
      if (f) fields[f[1]] = f[2]
    }
    ifaces[name] = fields
  }
  return ifaces
}

// 3. `HandWrittenRowMap`: `table_name: InterfaceName`
//
// This used to parse `Database.public.Tables`, which carried the mapping as a
// side effect of being the postgrest schema type. When Database moved to
// types/database.generated.ts (2026-08-02) that block left this file, the
// regex matched nothing, and the gate reported all 92 tables as unmodelled —
// a 92-failure run that looked like catastrophic drift and was really a parse
// miss. It now reads a declaration whose ONLY purpose is this mapping, so it
// cannot be carried away by an unrelated refactor again.
//
// Deliberately still types/database.ts and not the generated file: the
// generated types are produced FROM the live schema, so diffing them against
// it can never fail. The hand-written interfaces are the ones that can drift.
//
// A parse that finds nothing is now a hard failure rather than 92 confusing
// ones — see the guard below.
function parseTableMap(text) {
  const blockMatch = text.match(/export interface HandWrittenRowMap \{([\s\S]*?)\n\}/)
  if (!blockMatch) return null
  const map = {}
  // `block` comes from this repo's own committed types/database.ts, never
  // attacker-controlled input, so ReDoS is not a real risk here.
  const re = /^\s+(\w+):\s*(\w+)\s*$/gm // NOSONAR
  for (const m of blockMatch[1].matchAll(re)) map[m[1]] = m[2]
  return Object.keys(map).length ? map : null
}

const tsUnions     = parseUnionTypes(src)
const tsInterfaces = parseInterfaces(src)
const tsTableMap   = parseTableMap(src)

// Fail loudly and once on a parse miss. Without this, an empty map makes every
// live table look unmodelled and the operator sees ~92 failures describing a
// problem that does not exist — which is exactly what happened when the
// Database block moved out of this file.
if (tsTableMap === null) {
  console.error(
    '::error title=Type drift check could not parse::' +
      'types/database.ts has no parseable `export interface HandWrittenRowMap { ... }` ' +
      'block. That map is what tells this gate which interface models which table. ' +
      'It was probably renamed, reformatted, or moved — restore it rather than ' +
      'treating the table findings below as real drift.'
  )
  process.exit(1)
}

// ── Compare ──────────────────────────────────────────────────────────────────

const failures = []

// 1. Enum drift
for (const [pgName, tsName] of Object.entries(ENUM_MAP)) {
  const dbValues = dbEnums[pgName]
  const tsValues = tsUnions[tsName]

  if (dbValues === undefined) {
    failures.push(`Enum '${pgName}' is in ENUM_MAP but no longer exists in the DB — remove the mapping.`)
    continue
  }
  if (tsValues === undefined) {
    failures.push(`Enum '${pgName}' -> TS union '${tsName}' not found in types/database.ts (parse miss, or the union was renamed/removed).`)
    continue
  }

  const dbSet = new Set(dbValues)
  const tsSet = new Set(tsValues)
  const dbOnly = dbValues.filter((v) => !tsSet.has(v))
  const tsOnly = tsValues.filter((v) => !dbSet.has(v))

  if (dbOnly.length > 0 || tsOnly.length > 0) {
    const parts = []
    if (dbOnly.length > 0) parts.push(`DB has, TS missing: ${dbOnly.join(', ')}`)
    if (tsOnly.length > 0) parts.push(`TS has, DB missing: ${tsOnly.join(', ')}`)
    failures.push(`Enum drift on '${pgName}' / TS '${tsName}': ${parts.join(' | ')}`)
  }
}

// Enums present in DB but never mapped at all (new enum types nobody wired up)
for (const pgName of Object.keys(dbEnums)) {
  if (!(pgName in ENUM_MAP)) {
    failures.push(`Enum '${pgName}' exists in the DB but has no entry in ENUM_MAP in scripts/check-type-drift.mjs — add the TS union mapping (or confirm it's intentionally unmodeled).`)
  }
}

// 2. Table presence, both directions
const dbTableNames = new Set(Object.keys(dbTables))
const tsTableNames = new Set(Object.keys(tsTableMap))

for (const t of dbTableNames) {
  if (!tsTableNames.has(t) && !TABLE_ALLOWLIST.has(t)) {
    failures.push(`Table '${t}' exists in the DB but has no entry in Database.public.Tables in types/database.ts (and is not in TABLE_ALLOWLIST).`)
  }
}
for (const t of tsTableNames) {
  if (!dbTableNames.has(t)) {
    failures.push(`Table '${t}' is modeled in types/database.ts's Tables map but no longer exists in the DB.`)
  }
}
// Shrink-only allowlist hygiene — same ratchet as SERVICE_ROLE_ONLY_TABLES
for (const t of TABLE_ALLOWLIST) {
  if (!dbTableNames.has(t)) {
    failures.push(`Stale TABLE_ALLOWLIST entry '${t}' — table no longer exists in the DB. Remove it from scripts/check-type-drift.mjs.`)
  } else if (tsTableNames.has(t)) {
    failures.push(`Stale TABLE_ALLOWLIST entry '${t}' — it's now modeled in Database.public.Tables. Remove it from scripts/check-type-drift.mjs.`)
  }
}

// 3. Column presence (bonus), for every table wired into the Tables map
for (const [table, ifaceName] of Object.entries(tsTableMap)) {
  const dbCols = dbTables[table]
  const tsFields = tsInterfaces[ifaceName]
  if (!dbCols || !tsFields) continue // table not in DB (already reported above), or interface parse miss

  const dbColNames = new Set(Object.keys(dbCols))
  const tsColNames = new Set(Object.keys(tsFields))

  const dbOnly = [...dbColNames].filter((c) => !tsColNames.has(c) && !COLUMN_ALLOWLIST.has(`${table}.${c}`))
  const tsOnly = [...tsColNames].filter((c) => !dbColNames.has(c) && !COLUMN_ALLOWLIST.has(`${table}.${c}`))

  if (dbOnly.length > 0) {
    failures.push(`Table '${table}': DB has column(s) not in ${ifaceName}: ${dbOnly.join(', ')}`)
  }
  if (tsOnly.length > 0) {
    failures.push(`Table '${table}': ${ifaceName} has field(s) not in the DB: ${tsOnly.join(', ')}`)
  }
}
// Column allowlist hygiene
for (const entry of COLUMN_ALLOWLIST) {
  const [table, col] = entry.split('.')
  const dbCols = dbTables[table]
  if (!dbCols) continue // table itself already reported/allowlisted above
  const inDb = col in dbCols
  const ifaceName = tsTableMap[table]
  const inTs = ifaceName && tsInterfaces[ifaceName] && col in tsInterfaces[ifaceName]
  if (!inDb && !inTs) {
    failures.push(`Stale COLUMN_ALLOWLIST entry '${entry}' — column no longer exists anywhere. Remove it from scripts/check-type-drift.mjs.`)
  } else if (inDb && inTs) {
    failures.push(`Stale COLUMN_ALLOWLIST entry '${entry}' — column is now modeled on both sides. Remove it from scripts/check-type-drift.mjs.`)
  }
}

// ── Verdict ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`Type drift check FAILED (${failures.length} finding${failures.length === 1 ? '' : 's'}):\n`)
  for (const f of failures) console.error(`✗ ${f}\n`)
  process.exit(1)
}

console.log(
  'Type drift check OK — every DB enum matches its TS union, every table is ' +
    'modeled or allowlisted, and column presence matches for every mapped table.'
)
