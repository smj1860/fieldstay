// Time off moved out of the offline sync layer: it is now a Server Action
// against Supabase rather than a Dexie write plus an outbox mutation.
//
// The properties that matter after that move:
//
//  - org_id and crew_member_id come from the AUTHENTICATED crew context. The
//    Dexie helper this replaces took both as arguments the client supplied
//    (TimeOffRequest received them as props and passed them straight through
//    to the outbox payload), so the client named the org it was writing to.
//  - An update is scoped to the caller's own row. An availability row id from
//    the client proves nothing on its own.
//  - A new day upserts on (crew_member_id, available_date) — the real unique
//    constraint — not on a client-generated primary key, so two devices
//    toggling the same day cannot produce duplicate rows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/crew-auth', () => ({ requireCrewMember: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireCrewMember } from '@/lib/crew-auth'
import { saveCrewAvailability } from '@/app/crew/availability/actions'
import { LOOKBACK_DAYS, LOOKAHEAD_DAYS } from '@/app/crew/availability/window'

// ── Why the clock is frozen ────────────────────────────────────────────────
//
// saveCrewAvailability validates the requested date against a window measured
// from `new Date()` — LOOKBACK_DAYS back, LOOKAHEAD_DAYS forward. Every case
// below used one hardcoded date against that real clock, which is a time bomb
// rather than a test: it passed for a month and then began failing on
// 2026-09-10, the day TEST_DATE fell more than LOOKBACK_DAYS behind the real
// "today". No code and no test had changed. Four cases went red at once, and
// the failure reads as a broken action rather than an expired fixture.
//
// Freezing the clock — rather than deriving TEST_DATE from `new Date()` —
// fixes it in the direction that keeps the fixture readable AND makes the
// window a property of the test instead of the day it happens to run on.
// A derived date would go green again but leave the boundary untested, which
// is what let this sit here in the first place.
//
// Only Date is faked. Faking the whole timer set would stall the awaited
// promises these cases depend on.
const NOW       = new Date('2026-08-15T12:00:00Z')
const TEST_DATE = '2026-08-10'

/** `offsetDays` from the frozen NOW, as a YYYY-MM-DD string. */
function dateOffsetFromNow(offsetDays: number): string {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() + offsetDays)
  return d.toISOString().slice(0, 10)
}

type Resp = { data?: unknown; error?: unknown }

interface Call { method: string; args: unknown[] }

function makeSupabase(result: Resp = { data: { id: 'avail_1' }, error: null }) {
  const calls: Call[] = []
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'update', 'upsert', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
    }
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const CREW = { id: 'crew_1', org_id: 'org_1' }

function authAs(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireCrewMember).mockResolvedValue({
    ok: true, supabase, crew: CREW, user: { id: 'user_1' },
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('saveCrewAvailability', () => {
  it('upserts a new day on the (crew_member_id, available_date) constraint', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    authAs(supabase)

    const result = await saveCrewAvailability({
      date: TEST_DATE, isAvailable: false, notes: 'family thing',
    })

    expect(result).toEqual({})
    const upsert = supabase.calls.find((c) => c.method === 'upsert')
    expect(upsert?.args[0]).toMatchObject({
      org_id:         'org_1',
      crew_member_id: 'crew_1',
      available_date: TEST_DATE,
      is_available:   false,
      notes:          'family thing',
    })
    expect(
      upsert?.args[1],
      'conflicting on the PK instead would let two devices create duplicate rows for one day',
    ).toEqual({ onConflict: 'crew_member_id,available_date' })
  })

  it('never takes org_id or crew_member_id from the caller', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    authAs(supabase)

    await saveCrewAvailability({ date: TEST_DATE, isAvailable: true, notes: null })

    const payload = supabase.calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(payload.org_id).toBe(CREW.org_id)
    expect(payload.crew_member_id).toBe(CREW.id)
  })

  it('scopes an update to the calling crew member own row', async () => {
    const supabase = makeSupabase()
    authAs(supabase)

    await saveCrewAvailability({ id: 'avail_1', date: TEST_DATE, isAvailable: true, notes: null })

    const eqs = supabase.calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqs).toContainEqual(['id', 'avail_1'])
    expect(
      eqs,
      'an id from the client is not proof of ownership on its own',
    ).toContainEqual(['crew_member_id', 'crew_1'])
  })

  it('reports a stale id rather than silently doing nothing', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    authAs(supabase)

    const result = await saveCrewAvailability({
      id: 'someone_elses_row', date: TEST_DATE, isAvailable: true, notes: null,
    })

    expect(result.error).toBeTruthy()
  })

  it('normalizes a blank note to null instead of storing whitespace', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    authAs(supabase)

    await saveCrewAvailability({ date: TEST_DATE, isAvailable: false, notes: '   ' })

    const payload = supabase.calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(payload.notes).toBeNull()
  })

  it('surfaces a message rather than throwing when the write fails', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection lost' } })
    authAs(supabase)

    const result = await saveCrewAvailability({ date: TEST_DATE, isAvailable: false, notes: null })

    expect(result.error).toBeTruthy()
  })

  it('refuses when the crew profile cannot be verified', async () => {
    vi.mocked(requireCrewMember).mockResolvedValue({ ok: false, response: new Response(null) } as never)

    const result = await saveCrewAvailability({ date: TEST_DATE, isAvailable: false, notes: null })

    expect(result.error).toBeTruthy()
  })

  // ── The window itself ────────────────────────────────────────────────────
  //
  // Added after the frozen-clock fix above. The window had NO direct coverage:
  // every case simply used a date that happened to sit inside it, so the only
  // thing that ever exercised the boundary was the calendar rolling forward —
  // which is how it came to be discovered as four unrelated-looking failures
  // rather than one clear one. These pin both edges against the real
  // constants, so a change to either is a deliberate act with a test to match.

  it('accepts a date at the far edges of the window', async () => {
    // The TRUE edges — exactly the range app/crew/availability/page.tsx
    // renders. Asserting -(LOOKBACK_DAYS - 1) here instead would have written
    // the off-by-one this found straight into the test: the earliest day the
    // calendar offers was being refused. See the UTC-midnight note in
    // actions.ts.
    for (const offset of [-LOOKBACK_DAYS, 0, LOOKAHEAD_DAYS]) {
      const supabase = makeSupabase({ data: null, error: null })
      authAs(supabase)

      const result = await saveCrewAvailability({
        date: dateOffsetFromNow(offset), isAvailable: false, notes: null,
      })

      expect(result, `offset ${offset} should be inside the window`).toEqual({})
    }
  })

  it('refuses a date beyond either edge, and never writes', async () => {
    for (const offset of [-(LOOKBACK_DAYS + 1), LOOKAHEAD_DAYS + 1]) {
      const supabase = makeSupabase({ data: null, error: null })
      authAs(supabase)

      const result = await saveCrewAvailability({
        date: dateOffsetFromNow(offset), isAvailable: false, notes: null,
      })

      expect(result.error, `offset ${offset} should be rejected`).toBeTruthy()
      expect(
        supabase.calls.filter((c) => c.method === 'upsert'),
        'a rejected date must not reach the database',
      ).toEqual([])
    }
  })
})
