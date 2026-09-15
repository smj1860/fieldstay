import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// Guardrail: check-property-defaults-drift.mjs's parser must stay parseable.
//
// The DB-side half of that gate (property_defaults_report(), in
// supabase/migrations/20260915210000_property_defaults_report.sql) can only
// run against the live E2E database, which the always-on `checks` job never
// has credentials for — the db-invariants job SELF-DISARMS without them (a
// fork PR, a local run with no .env). This test runs the JS-SIDE regex parser
// against the real lib/properties/defaults.ts with no database at all, so a
// refactor that breaks the parse (a reformat, a renamed field, a literal
// moved onto its own line) is caught on the PR rather than silently turning
// the DB-side gate into a no-op that reports "0 columns checked, all clear".
//
// Deliberately duplicates the script's regex, same convention as
// type-drift-map-parses.test.ts — the duplication is the point: it is what
// makes a silent divergence between the two fail.
// ============================================================================

const DEFAULTS_SRC = readFileSync(join(process.cwd(), 'lib', 'properties', 'defaults.ts'), 'utf8')
const SCRIPT_SRC = readFileSync(join(process.cwd(), 'scripts', 'check-property-defaults-drift.mjs'), 'utf8')

function parseHardcodedDefaults(text: string): Record<string, string | number> {
  const parsed: Record<string, string | number> = {}
  const re = /(\w+):\s*row\.\w+\s*\?\?\s*('[^']*'|[-\d.]+),/g
  for (const m of text.matchAll(re)) {
    const [, name, rawLiteral] = m
    parsed[name!] = rawLiteral!.startsWith("'") ? rawLiteral!.slice(1, -1) : Number(rawLiteral)
  }
  return parsed
}

describe('guardrail: check-property-defaults-drift.mjs can still parse the defaults', () => {
  const parsed = parseHardcodedDefaults(DEFAULTS_SRC)

  // The exact 9 columns property_defaults_report() evaluates — see both that
  // migration and this list in the script itself. avg_nightly_rate is
  // deliberately excluded (its DEFAULT is NULL by design).
  const EXPECTED_COLUMNS = [
    'property_type', 'bedrooms', 'bathrooms', 'max_guests', 'avg_stay_length',
    'avg_turnovers_per_month', 'checkin_time', 'checkout_time', 'same_day_premium_pct',
  ]

  it('parses all 9 defaultable columns, not a partial or empty set', () => {
    // A regex that half-matches (e.g. stops at the first multi-word literal)
    // is as misleading as one that matches nothing — the failure mode this
    // guards against is the drift check silently checking fewer columns than
    // it claims to, reporting "OK" on a smaller and smaller set over time.
    const missing = EXPECTED_COLUMNS.filter((c) => !(c in parsed))
    expect(missing, `Failed to parse a literal for: ${missing.join(', ')}`).toEqual([])
  })

  it('parses the exact values currently hardcoded, as a canary against a silent regex change', () => {
    expect(parsed).toMatchObject({
      property_type: 'house',
      bedrooms: 1,
      bathrooms: 1,
      max_guests: 2,
      avg_stay_length: 3,
      avg_turnovers_per_month: 4,
      checkin_time: '15:00:00',
      checkout_time: '11:00:00',
      same_day_premium_pct: 25,
    })
  })

  it('the script still calls property_defaults_report(), not a renamed RPC', () => {
    expect(
      SCRIPT_SRC.includes('property_defaults_report'),
      'check-property-defaults-drift.mjs no longer references property_defaults_report() — ' +
      'if the RPC was renamed, this guardrail and the migration comment should say so too.',
    ).toBe(true)
  })
})
