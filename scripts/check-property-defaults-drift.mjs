#!/usr/bin/env node
/**
 * FieldStay — lib/properties/defaults.ts drift check (structural
 * enforcement, DB invariant gate sibling to check-type-drift.mjs).
 *
 * withPropertyDefaults() hand-copies ten `properties` column DEFAULTs as JS
 * literals, justified by its own header comment as "Verified against
 * information_schema.columns.column_default" — a point-in-time manual check
 * that nothing re-ran. A future migration changing one of those DEFAULTs
 * would leave that file silently returning the OLD value for any row
 * genuinely written with NULL by a non-app path (a backfill, an integration
 * sync, the Supabase dashboard), with nothing anywhere signalling the two
 * had diverged.
 *
 * This calls public.property_defaults_report() (see supabase/migrations/
 * 20260915210000_property_defaults_report.sql) against the E2E project,
 * which EVALUATES each column's default expression and returns the actual
 * value it produces — sidestepping the need to parse `column_default`'s raw,
 * shape-varying text (`1`, `1.0`, `'15:00:00'::time without time zone`,
 * `'house'::property_type`) — and diffs each one against the JS literal
 * mechanically parsed out of withPropertyDefaults().
 *
 * `avg_nightly_rate` is deliberately out of scope: its DEFAULT is NULL,
 * matching withPropertyDefaults()'s own comment that it is left unresolved.
 *
 * Self-disarms with a CI warning annotation when the E2E secrets are absent,
 * mirroring check-type-drift.mjs and check-db-invariants.mjs.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULTS_PATH = path.join(__dirname, '..', 'lib', 'properties', 'defaults.ts')

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  if (process.env.DB_INVARIANTS_REQUIRE_ARMED === '1') {
    console.error(
      'Property-defaults drift gate is REQUIRED on this run but UNARMED: ' +
        'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. ' +
        'Configure the E2E secrets (docs/E2E_SETUP.md), or unset ' +
        'DB_INVARIANTS_REQUIRE_ARMED if this run genuinely cannot hold them.'
    )
    process.exit(1)
  }

  console.log(
    '::warning title=Property-defaults drift gate UNARMED::NEXT_PUBLIC_SUPABASE_URL / ' +
      'SUPABASE_SERVICE_ROLE_KEY are not configured, so lib/properties/defaults.ts ' +
      'was NOT diffed against the live schema. Follow docs/E2E_SETUP.md to arm the gate.'
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

// ── Fetch the live defaults ─────────────────────────────────────────────────

const res = await fetch(new URL('/rest/v1/rpc/property_defaults_report', url), {
  method: 'POST',
  headers: {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
  },
  body: '{}',
})

if (!res.ok) {
  console.error(`property_defaults_report RPC failed: HTTP ${res.status}`)
  console.error(
    'Has supabase/migrations/20260915210000_property_defaults_report.sql been applied to the E2E project?'
  )
  process.exit(1)
}

const live = await res.json()

// ── Parse withPropertyDefaults()'s literals ─────────────────────────────────
//
// Mechanical, not a TS compiler — a hand-written file with a consistent-
// enough shape (`col: row.col ?? <literal>,` inside the return object) for
// this to be reliable, same tradeoff check-type-drift.mjs makes about
// types/database.ts. A false negative (a literal this can't parse) means the
// column is silently skipped rather than falsely flagged.

const src = readFileSync(DEFAULTS_PATH, 'utf8')

/** `columnName: row.columnName ?? <literal>,` -> { columnName, literal } */
function parseHardcodedDefaults(text) {
  const parsed = {}
  const re = /(\w+):\s*row\.\w+\s*\?\?\s*('[^']*'|[-\d.]+),/g
  for (const m of text.matchAll(re)) {
    const [, name, rawLiteral] = m
    parsed[name] = rawLiteral.startsWith("'")
      ? rawLiteral.slice(1, -1)
      : Number(rawLiteral)
  }
  return parsed
}

const hardcoded = parseHardcodedDefaults(src)

// ── Diff ─────────────────────────────────────────────────────────────────

const mismatches = []
for (const [column, liveValue] of Object.entries(live)) {
  const jsLiteral = hardcoded[column]
  if (jsLiteral === undefined) {
    mismatches.push(
      `${column}: live DEFAULT is ${JSON.stringify(liveValue)}, but lib/properties/defaults.ts ` +
      `has no parseable \`${column}: row.${column} ?? <literal>\` line (new column, or the parser missed it)`
    )
    continue
  }
  // Numeric DEFAULTs may be stored with trailing precision (25 vs 25.0) that
  // JSON round-trips away, so a loose numeric equality is correct here — the
  // live value and the JS literal are compared as the same real number.
  const matches = typeof jsLiteral === 'number' && typeof liveValue === 'number'
    ? jsLiteral === liveValue
    : String(jsLiteral) === String(liveValue)
  if (!matches) {
    mismatches.push(
      `${column}: live column DEFAULT resolves to ${JSON.stringify(liveValue)}, but ` +
      `lib/properties/defaults.ts hardcodes ${JSON.stringify(jsLiteral)}`
    )
  }
}

if (mismatches.length > 0) {
  console.error('Property defaults have drifted from the live schema:\n')
  for (const m of mismatches) console.error(`  - ${m}`)
  console.error(
    '\nUpdate the literal(s) in lib/properties/defaults.ts\'s withPropertyDefaults() to match, ' +
    'or if the drift is intentional, confirm the migration that changed the column DEFAULT was ' +
    'deliberate.'
  )
  process.exit(1)
}

console.log(`Property defaults check OK — ${Object.keys(live).length} column(s) match the live schema.`)
