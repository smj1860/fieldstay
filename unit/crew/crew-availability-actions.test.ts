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

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/crew-auth', () => ({ requireCrewMember: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireCrewMember } from '@/lib/crew-auth'
import { saveCrewAvailability } from '@/app/crew/availability/actions'

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
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('saveCrewAvailability', () => {
  it('upserts a new day on the (crew_member_id, available_date) constraint', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    authAs(supabase)

    const result = await saveCrewAvailability({
      date: '2026-08-10', isAvailable: false, notes: 'family thing',
    })

    expect(result).toEqual({})
    const upsert = supabase.calls.find((c) => c.method === 'upsert')
    expect(upsert?.args[0]).toMatchObject({
      org_id:         'org_1',
      crew_member_id: 'crew_1',
      available_date: '2026-08-10',
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

    await saveCrewAvailability({ date: '2026-08-10', isAvailable: true, notes: null })

    const payload = supabase.calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(payload.org_id).toBe(CREW.org_id)
    expect(payload.crew_member_id).toBe(CREW.id)
  })

  it('scopes an update to the calling crew member own row', async () => {
    const supabase = makeSupabase()
    authAs(supabase)

    await saveCrewAvailability({ id: 'avail_1', date: '2026-08-10', isAvailable: true, notes: null })

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
      id: 'someone_elses_row', date: '2026-08-10', isAvailable: true, notes: null,
    })

    expect(result.error).toBeTruthy()
  })

  it('normalizes a blank note to null instead of storing whitespace', async () => {
    const supabase = makeSupabase({ data: null, error: null })
    authAs(supabase)

    await saveCrewAvailability({ date: '2026-08-10', isAvailable: false, notes: '   ' })

    const payload = supabase.calls.find((c) => c.method === 'upsert')?.args[0] as Record<string, unknown>
    expect(payload.notes).toBeNull()
  })

  it('surfaces a message rather than throwing when the write fails', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection lost' } })
    authAs(supabase)

    const result = await saveCrewAvailability({ date: '2026-08-10', isAvailable: false, notes: null })

    expect(result.error).toBeTruthy()
  })

  it('refuses when the crew profile cannot be verified', async () => {
    vi.mocked(requireCrewMember).mockResolvedValue({ ok: false, response: new Response(null) } as never)

    const result = await saveCrewAvailability({ date: '2026-08-10', isAvailable: false, notes: null })

    expect(result.error).toBeTruthy()
  })
})
