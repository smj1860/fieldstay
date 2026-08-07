// unit/guardrails/redemption-dedup-pairing.test.ts
//
// guidebook_offer_redemptions has a dedup constraint and a handler branch that
// depends on it, and they live in different files with nothing tying them
// together.
//
// The row is written when a guest opens the redemption pass — the coupon they
// show at the counter — and reopening it is the normal case, so raw COUNT(*)
// overstates real redemptions by however many times the guest looked at their
// own coupon. That count is what a paying sponsor judges their slot by.
//
// Two ways the pairing silently breaks:
//
//   - the unique index goes away (migration reverted, index renamed, table
//     rebuilt) and the route's 23505 branch becomes dead code. Nothing errors;
//     the counts just quietly inflate again.
//   - the route stops handling 23505 and every reopen becomes a reported
//     error instead — the noise moves from the sponsor's number into Sentry,
//     which is not an improvement.
//
// Neither shows up as a test failure anywhere else: no unit test exercises the
// real database, and the sponsor-facing report that would surface a wrong
// number does not exist yet. This asserts the two halves stay together.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT           = join(__dirname, '..', '..')
const ROUTE          = 'app/api/guidebook/redeem/route.ts'
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const INDEX_NAME     = 'uniq_guidebook_offer_redemptions_sponsor_booking_day'

function migrationSources(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

describe('guidebook redemption dedup — constraint and handler stay paired', () => {
  it('a migration creates the unique index the handler relies on', () => {
    const sql = migrationSources()
    const createsIt = new RegExp(
      `CREATE\\s+UNIQUE\\s+INDEX(\\s+IF\\s+NOT\\s+EXISTS)?\\s+${INDEX_NAME}\\b`,
      'i',
    )
    expect(sql).toMatch(createsIt)
  })

  it('the index is partial on booking_id, so anonymous redemptions are not collapsed together', () => {
    const sql = migrationSources()
    const stmt = sql.slice(sql.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}`))
    // Without the WHERE clause, every anonymous redemption (booking_id NULL,
    // from the property-level /g/[slug] guidebook) would still be distinct in
    // Postgres — NULLs never collide — but a later change to NULLS NOT
    // DISTINCT would merge DIFFERENT guests into one row. The predicate makes
    // the intent explicit rather than resting on NULL semantics.
    expect(stmt.slice(0, 400)).toMatch(/WHERE\s+booking_id\s+IS\s+NOT\s+NULL/i)
  })

  it('the route treats 23505 as success rather than reporting it', () => {
    const src = readFileSync(join(ROOT, ROUTE), 'utf8')
    expect(src).toContain('23505')
    // The 23505 check must come BEFORE the generic reportError branch, or a
    // duplicate still gets reported.
    expect(src.indexOf("'23505'")).toBeLessThan(src.indexOf('route.guidebook.redeem.insert'))
  })

  it('the route names the index it depends on, so a grep for the index finds its consumer', () => {
    const src = readFileSync(join(ROOT, ROUTE), 'utf8')
    expect(src).toContain(INDEX_NAME)
  })
})
