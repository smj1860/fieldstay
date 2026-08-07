import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// saveCrewAvailability wrote its client-supplied `date` straight through to
// crew_availability.available_date, and its `notes` with no length bound.
//
// A malformed date only earned a Postgres 22007 rendered as the generic
// catch-all message. A well-formed but absurd one — the year 3000 — was
// ACCEPTED and stored, in a row no screen will ever show again: the crew page
// reads a bounded window, and the PM's time-off check on assignCrew reads the
// dates of the turnovers being assigned. Invisible to everyone, forever.
//
// CLAUDE.md's standing checklist calls for validating and normalising input at
// the boundary (the Server Action), rather than trusting it to be clean by the
// time it reaches a DB write. This is that.
// ============================================================================

const requireCrewMember = vi.fn()
vi.mock('@/lib/crew-auth', () => ({ requireCrewMember: () => requireCrewMember() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { saveCrewAvailability } from '@/app/crew/availability/actions'
import { LOOKBACK_DAYS, LOOKAHEAD_DAYS } from '@/app/crew/availability/window'

function makeSupabase() {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'update', 'upsert', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: { id: 'a_1' }, error: null }))
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve)
    return chain
  })
  return { from, calls }
}

/** A date `offsetDays` from today, in the YYYY-MM-DD form the client sends. */
function dateOffset(offsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

let supabase: ReturnType<typeof makeSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  supabase = makeSupabase()
  requireCrewMember.mockResolvedValue({
    ok: true, supabase, crew: { id: 'crew_1', org_id: 'org_1' }, user: { id: 'user_1' },
  })
})

describe('saveCrewAvailability — input is validated at the boundary', () => {
  it.each([
    ['not a date at all',      'tomorrow'],
    ['wrong separator',        '2026/08/10'],
    ['no zero padding',        '2026-8-10'],
    ['a timestamp',            '2026-08-10T00:00:00Z'],
    ['empty',                  ''],
  ])('rejects %s without touching the database', async (_label, date) => {
    const result = await saveCrewAvailability({ date, isAvailable: false, notes: null })

    expect(result.error).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // `2026-02-31` passes a regex and Date silently rolls it over to March 3,
  // so the round-trip check is the only thing that catches it.
  it('rejects a well-formed date that does not exist', async () => {
    const result = await saveCrewAvailability({ date: '2026-02-31', isAvailable: false, notes: null })

    expect(result.error).toBeTruthy()
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each([
    ['far past',   -LOOKBACK_DAYS - 5],
    ['far future',  LOOKAHEAD_DAYS + 5],
    ['year 3000',   400_000],
  ])('rejects a date outside the requestable window (%s)', async (_label, offset) => {
    const result = await saveCrewAvailability({ date: dateOffset(offset), isAvailable: false, notes: null })

    expect(result.error).toMatch(/outside the window/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it.each([
    ['tomorrow',                 1],
    ['the far edge of the window', LOOKAHEAD_DAYS - 1],
    ['inside the lookback',      -1],
  ])('accepts a date inside the window (%s)', async (_label, offset) => {
    const result = await saveCrewAvailability({ date: dateOffset(offset), isAvailable: false, notes: null })

    expect(result.error).toBeUndefined()
    expect(supabase.from).toHaveBeenCalledWith('crew_availability')
  })

  it('rejects an oversized note without writing', async () => {
    const result = await saveCrewAvailability({
      date: dateOffset(1), isAvailable: false, notes: 'x'.repeat(501),
    })

    expect(result.error).toMatch(/under 500 characters/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('accepts a note at exactly the limit, trimmed', async () => {
    const result = await saveCrewAvailability({
      date: dateOffset(1), isAvailable: false, notes: `  ${'x'.repeat(500)}  `,
    })

    expect(result.error).toBeUndefined()
    const written = supabase.calls.find((c) => c.method === 'upsert')
    expect((written?.args[0] as { notes: string }).notes).toBe('x'.repeat(500))
  })

  // The window the page SHOWS and the window the action ACCEPTS are the same
  // two constants — the page imports them from here. If they drift, the screen
  // either offers days the action rejects or accepts days it never shows back.
  it('exports the window constants the page renders from', () => {
    expect(LOOKBACK_DAYS).toBeGreaterThan(0)
    expect(LOOKAHEAD_DAYS).toBeGreaterThan(0)
  })
})
