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

import { POST } from '@/app/api/crew/turnovers/[id]/start/route'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'

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

function request() {
  return new NextRequest('http://localhost/api/crew/turnovers/turnover_1/start', { method: 'POST' })
}

function call(turnoverId: string) {
  return POST(request(), { params: Promise.resolve({ id: turnoverId }) })
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

  it('no-ops without re-firing the event when the turnover is not in the assigned state', async () => {
    const supabase = makeSupabase({
      turnovers: [{ data: { id: 'turnover_1', org_id: 'org_1', status: 'in_progress' }, error: null }],
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
        { data: { id: 'turnover_1', org_id: 'org_1', status: 'assigned' }, error: null },
        { data: null, error: null }, // claim update — lost the race
      ],
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
        { data: { id: 'turnover_1', org_id: 'org_1', status: 'assigned' }, error: null },
        { data: null, error: { message: 'db down' } },
      ],
    })
    authOk(supabase)

    const res = await call('turnover_1')

    expect(res.status).toBe(500)
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('starts the turnover scoped to the crew member\'s own org, fires turnover/started, and logs an audit event', async () => {
    const supabase = makeSupabase({
      turnovers: [
        { data: { id: 'turnover_1', org_id: 'org_1', status: 'assigned' }, error: null },
        { data: { id: 'turnover_1' }, error: null },
      ],
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
