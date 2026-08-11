// unit/guardrails/redemption-dedup-pairing.test.ts
//
// guidebook_offer_redemptions carries TWO sponsor-facing numbers out of one
// row — COUNT(*) is redemptions, SUM(open_count) is engagement — and both
// depend on a unique index, an insert-or-increment function, and a route that
// calls it, spread across three files with nothing tying them together.
//
// The row is written when a guest opens the redemption pass, the coupon they
// show at the counter. Reopening it is the normal case (look at the offer,
// close it, walk over, open it again for staff), which is precisely why the
// two numbers differ and why a sponsor wants both.
//
// Every way this breaks is silent, and none of them shows up as a test failure
// anywhere else — no unit test touches the real database, and the sponsor
// report that would surface a wrong number does not exist yet:
//
//   - the unique index goes away (migration reverted, renamed, table rebuilt):
//     redemptions quietly re-inflate to one row per tap.
//   - the function's ON CONFLICT arbiter stops matching the index expression:
//     same inflation, one layer down, where the index still looks present.
//   - the route swaps the RPC for a plain .insert(): rows stay deduped, but
//     open_count sticks at 1 and engagement silently flatlines.
//   - the function keeps Postgres's default EXECUTE-to-PUBLIC grant: anon can
//     write rows to a tenant table over /rest/v1/rpc/ with no session at all.
//
// This asserts all four stay closed.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT           = join(__dirname, '..', '..')
const ROUTE          = 'app/api/guidebook/redeem/route.ts'
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const INDEX_NAME     = 'uniq_guidebook_offer_redemptions_sponsor_booking_day'
const RPC_NAME       = 'record_guidebook_offer_open'

function migrationSources(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

/**
 * The body of ONE function, bounded to the migration that defines it.
 *
 * The function-scoped assertions below used to slice migrationSources() from
 * the function name to the end of the whole concatenation, which meant they
 * were really reading every migration that sorts after the defining one. That
 * is wrong in both directions: a later migration granting EXECUTE to
 * authenticated for a DIFFERENT function failed the anon-grant assertion (a
 * false positive — this is what 20260811080000 tripped), and a later migration
 * happening to contain the right ON CONFLICT text would have satisfied the
 * arbiter assertions for free (a false pass). Neither depended on the function
 * this file is about.
 *
 * Bounding to the defining file keeps the assertions about the function they
 * name. Throws rather than returning '' if the function is gone, so deleting
 * it fails loudly instead of vacuously passing every `not.toMatch`.
 */
function functionSource(name: string): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    const at = sql.indexOf(`FUNCTION public.${name}`)
    if (at !== -1) return sql.slice(at)
  }
  throw new Error(`No migration defines FUNCTION public.${name}`)
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

  it('a migration defines the insert-or-increment function against that same index', () => {
    const sql = migrationSources()
    expect(sql).toContain(`FUNCTION public.${RPC_NAME}`)
    // The ON CONFLICT arbiter must match the index expression, or the function
    // silently loses its conflict target and every open inserts a new row —
    // the exact inflation the index exists to prevent, reintroduced one layer
    // down where the index still looks present.
    const fn = functionSource(RPC_NAME)
    expect(fn).toMatch(/ON CONFLICT[\s\S]{0,200}opened_at AT TIME ZONE 'UTC'/i)
    expect(fn).toMatch(/DO UPDATE SET open_count = [\s\S]{0,80}open_count \+ 1/i)
  })

  it('the function is not executable by anon or authenticated', () => {
    const fn = functionSource(RPC_NAME)
    // Postgres grants EXECUTE to PUBLIC by default, which on Supabase means
    // anon can call it over /rest/v1/rpc/ with the publishable key — writing
    // rows to a tenant table with no session at all. Every anon TABLE grant
    // was revoked on 2026-07-24; a function is the same exposure via a
    // different door.
    expect(fn).toMatch(/REVOKE ALL ON FUNCTION[\s\S]{0,200}FROM PUBLIC/i)
    expect(fn).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]{0,200}TO service_role/i)
    expect(fn).not.toMatch(/GRANT EXECUTE[\s\S]{0,200}TO (anon|authenticated)/i)
  })

  it('the route writes through the function, not a bare insert it could drift from', () => {
    const src = readFileSync(join(ROOT, ROUTE), 'utf8')
    expect(src).toContain(RPC_NAME)
    // A plain .insert() here would bypass the increment entirely: the row
    // would still be deduped by the index, but open_count would stay 1 forever
    // and the engagement number would silently flatline.
    expect(src).not.toMatch(/\.from\(\s*['"]guidebook_offer_redemptions['"]\s*\)\s*\.insert/)
  })

  it('the route names the index it depends on, so a grep for the index finds its consumer', () => {
    const src = readFileSync(join(ROOT, ROUTE), 'utf8')
    expect(src).toContain(INDEX_NAME)
  })
})
