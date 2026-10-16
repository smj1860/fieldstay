import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

vi.mock('@/lib/crew-auth', () => ({
  requireCrewMember: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/turnovers/crew-checkin', () => ({
  recordCrewCheckin: vi.fn(),
}))

import { POST } from '@/app/api/crew/turnovers/[id]/start/route'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { recordCrewCheckin } from '@/lib/turnovers/crew-checkin'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

const FIX = {
  lat: 36.1, lng: -86.7, gps_accuracy_ft: 40,
  captured_at: '2026-10-10T15:00:00.000Z', device_now: '2026-10-10T15:00:01.000Z', attempt: 1,
}

function request(body: unknown = { checkin: FIX }) {
  return new NextRequest('http://localhost/api/crew/turnovers/turnover_1/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function call(turnoverId: string, body?: unknown) {
  return POST(request(body), { params: Promise.resolve({ id: turnoverId }) })
}

function authOk(supabase: unknown, crewOrgId = 'org_1') {
  vi.mocked(requireCrewMember).mockResolvedValue({
    ok: true,
    user: { id: 'user_1' },
    supabase,
    crew: { id: 'crew_1', org_id: crewOrgId },
  } as never)
}

describe('POST /api/crew/turnovers/[id]/start', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(recordCrewCheckin).mockResolvedValue(null)
  })

  it('refuses a start with no usable check-in (400, terminal for the outbox) and starts nothing', async () => {
    for (const body of [{}, { checkin: { ...FIX, lat: 123 } }, null]) {
      authOk(makeSupabase({
        turnovers:            [{ data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'assigned' }, error: null }],
        turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
      }))
      const res = await call('turnover_1', body)
      expect(res.status).toBe(400)
    }
    expect(inngest.send).not.toHaveBeenCalled()
    expect(recordCrewCheckin).not.toHaveBeenCalled()
  })

  it('still records the check-in when the turnover is already in progress (a retried start)', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'in_progress' }, error: null }],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBe(200)
    expect(inngest.send).not.toHaveBeenCalled()
    expect(recordCrewCheckin).toHaveBeenCalledWith(expect.objectContaining({
      turnover: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1' }, fix: FIX,
    }))
  })

  it('answers 500 (retryable) when the check-in could not be recorded', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'in_progress' }, error: null }],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase)
    vi.mocked(recordCrewCheckin).mockResolvedValue(NextResponse.json({ error: 'Something went wrong' }, { status: 500 }))

    const res = await call('turnover_1')

    expect(res.status).toBe(500)
  })

  it('returns the crew-auth failure response unchanged when not an active crew member', async () => {
    const unauthorized = NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    vi.mocked(requireCrewMember).mockResolvedValue({ ok: false, response: unauthorized } as never)

    const res = await call('turnover_1')

    expect(res.status).toBe(401)
  })

  it('IDOR: returns 404 for a turnover that exists but belongs to a different org than the crew member', async () => {
    const supabase = makeSupabase({ turnovers: [{ data: null, error: null }] })
    authOk(supabase, 'org_1')

    const res = await call('other-orgs-turnover')

    expect(res.status).toBe(404)
    expect(inngest.send).not.toHaveBeenCalled()

    const lookupCall = supabase.calls.find((c) => c.table === 'turnovers' && c.method === 'eq' && c.args[0] === 'org_id')
    expect(lookupCall?.args).toEqual(['org_id', 'org_1'])
  })

  it('H-7: returns 404 when the crew member has no turnover_assignments row for this turnover', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'assigned' }, error: null }],
      turnover_assignments: [{ data: null, error: null }], // not assigned
    })
    authOk(supabase)

    const res = await call('turnover_1')
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json).toEqual({ error: 'Turnover not found' })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('no-ops without re-firing the event when the turnover is not in the assigned state', async () => {
    const supabase = makeSupabase({
      turnovers:            [{ data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'in_progress' }, error: null }],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('no-ops without re-firing the event when a concurrent request already won the start claim', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'assigned' }, error: null },
        { data: null, error: null }, // claim update — lost the race
      ],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns 500 on a DB error during the start claim', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'assigned' }, error: null },
        { data: null, error: { message: 'db down' } },
      ],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBe(500)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('starts the turnover scoped to the crew member\'s own org, fires turnover/started, and logs an audit event', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', org_id: 'org_1', property_id: 'prop_1', status: 'assigned' }, error: null },
        { data: { id: 'turnover_1' }, error: null },
      ],
      turnover_assignments: [{ data: { id: 'assignment_1' }, error: null }],
    })
    authOk(supabase, 'org_1')

    const res = await call('turnover_1')
    const json = await res.json()

    expect(json).toEqual({ success: true })
    expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
      name: 'turnover/started',
      data: expect.objectContaining({
        turnover_id:         'turnover_1',
        org_id:               'org_1',
        started_by_crew_id:   'crew_1',
      }),
    }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org_1', actorId: 'user_1', action: 'turnover.started', targetId: 'turnover_1',
    }))
  })
})
