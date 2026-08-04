import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SUPABASE_MAX_ROWS, DEFAULT_PAGE_SIZE } from '../../lib/inngest/paginate'

// ============================================================================
// A `.range()` drain's ONLY termination signal is `page.length < pageSize`.
// That signal is trustworthy in exactly one condition: pageSize is strictly
// below the server's max_rows cap, so a full page proves the server did not
// clamp.
//
// If pageSize were >= max_rows, the very first response would come back
// clamped to max_rows, `max_rows < pageSize` would read as "no more rows", and
// the drain would return a TRUNCATED set as though it were complete — a 200,
// no error, no signal. That is bit-for-bit the defect fetchAllRows exists to
// prevent, produced by fetchAllRows itself.
//
// It nearly shipped that way: DEFAULT_PAGE_SIZE was `SUPABASE_MAX_ROWS`
// exactly, and the equality was held together by a comment. This ties both
// constants to the real max_rows in supabase/config.toml so a change to any
// one of the three fails here instead of silently truncating in production.
// ============================================================================

const ROOT = join(__dirname, '..', '..')

function configuredMaxRows(): number {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8')
  const match = /^\s*max_rows\s*=\s*(\d+)\s*$/m.exec(toml)
  expect(match, 'could not find `max_rows = <n>` in supabase/config.toml — has the key moved?').not.toBeNull()
  return Number(match![1])
}

describe('guardrail: paginated drains cannot mistake a clamped page for the last page', () => {
  it('SUPABASE_MAX_ROWS matches the max_rows actually configured', () => {
    expect(
      SUPABASE_MAX_ROWS,
      'lib/inngest/paginate.ts hardcodes the PostgREST cap. supabase/config.toml now ' +
      'declares a different one, so every drain is reasoning about the wrong ceiling.',
    ).toBe(configuredMaxRows())
  })

  it('DEFAULT_PAGE_SIZE is STRICTLY below the cap, so a full page proves no clamping', () => {
    expect(
      DEFAULT_PAGE_SIZE,
      'DEFAULT_PAGE_SIZE must be < max_rows. At or above it, the first response is ' +
      'clamped, the short page reads as "done", and the drain silently returns a ' +
      'truncated result — the exact bug fetchAllRows exists to prevent.',
    ).toBeLessThan(configuredMaxRows())
  })

  it('the page size is not so small that ordinary scans pay for it', () => {
    // Guards the other direction: someone "fixing" the above by dropping to a
    // tiny page turns a one-request read into hundreds of round trips.
    expect(DEFAULT_PAGE_SIZE).toBeGreaterThanOrEqual(Math.floor(configuredMaxRows() / 2))
  })
})

// ============================================================================
// `.range()` is OFFSET pagination: page 2 asks for "rows N..M OF THIS
// ORDERING", so the ordering must be TOTAL or the two pages answer different
// questions. Postgres may break ties differently in two separately-planned
// queries, which returns some rows twice and others never.
//
// The turnovers board shipped exactly that: ordered by checkout_datetime
// alone, on a table where short-term rentals share a standard checkout hour,
// so ties are the common case rather than the edge. `id` last makes the sort
// total.
//
// Scoped to this one file deliberately. A repo-wide version is warranted — 51
// of 130 `.range()` call sites do not currently end in a unique key — but that
// needs a ratchet with a reviewed baseline, not a blanket assertion bolted on
// here. See the follow-up note in this PR.
// ============================================================================
describe('guardrail: the turnovers board pages over a TOTAL ordering', () => {
  const PAGE = 'app/(dashboard)/turnovers/page.tsx'
  const raw = readFileSync(join(ROOT, PAGE), 'utf8')
  // Comments in this file legitimately DISCUSS .range() and .order() — strip
  // them, or the guardrail counts its own documentation as call sites.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('every .range() is immediately preceded by .order(\'id\')', () => {
    const ranges = [...src.matchAll(/\.range\(/g)]
    expect(ranges.length, 'no .range() found — has the page stopped paginating?').toBeGreaterThan(0)

    const totalOrdered = [...src.matchAll(/\.order\(\s*'id'[^)]*\)\s*\n?\s*\.range\(/g)]

    expect(
      totalOrdered.length,
      `${PAGE} has ${ranges.length} .range() call(s) but only ${totalOrdered.length} ` +
      "end in .order('id'). An offset page boundary on a non-unique sort key " +
      'duplicates and drops rows across pages, silently.',
    ).toBe(ranges.length)
  })

  it('does not hand-roll a drain loop when fetchAllRows exists', () => {
    // The first version of this fix wrote its own `for (;;)` with no maxRows
    // ceiling — the guard fetchAllRows carries and the reason it exists.
    expect(raw).toContain('fetchAllRows')
    expect(
      /for\s*\(\s*let\s+from\s*=\s*0\s*;\s*;/.test(src),
      'a hand-rolled unbounded drain loop is back in the turnovers page',
    ).toBe(false)
  })
})
