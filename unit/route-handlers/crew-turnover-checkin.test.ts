import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

vi.mock('@/lib/turnovers/crew-route-context', () => ({ loadCrewTurnoverContext: vi.fn() }))
vi.mock('@/lib/turnovers/crew-checkin', () => ({ recordCrewCheckin: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  checkLimit: vi.fn(), retryAfterSeconds: vi.fn(() => 5), evidenceSealRatelimit: {},
}))

import { POST } from '@/app/api/crew/turnovers/[id]/checkin/route'
import { loadCrewTurnoverContext } from '@/lib/turnovers/crew-route-context'
import { recordCrewCheckin } from '@/lib/turnovers/crew-checkin'
import { checkLimit } from '@/lib/rate-limit'

const FIX = {
  lat: 36.1, lng: -86.7, gps_accuracy_ft: 40,
  captured_at: '2026-10-10T15:00:00.000Z', device_now: '2026-10-10T15:00:01.000Z', attempt: 2,
}

function call(body: unknown = { checkin: FIX }) {
  const req = new NextRequest('http://localhost/api/crew/turnovers/t1/checkin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ id: 't1' }) })
}

function ctx(status: string) {
  vi.mocked(loadCrewTurnoverContext).mockResolvedValue({
    ok: true,
    auth: { user: { id: 'u1' }, supabase: {}, crew: { id: 'c1', org_id: 'o1' } },
    turnover: { id: 't1', org_id: 'o1', property_id: 'p1', status },
  } as never)
}

describe('POST /api/crew/turnovers/[id]/checkin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(checkLimit).mockResolvedValue({ allowed: true } as never)
    vi.mocked(recordCrewCheckin).mockResolvedValue(null)
  })

  it('returns the context failure unchanged (unauthenticated, unassigned, unknown)', async () => {
    vi.mocked(loadCrewTurnoverContext).mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 404 }) } as never)
    expect((await call()).status).toBe(404)
  })

  it('400s a body with no valid fix, without recording anything', async () => {
    ctx('in_progress')
    expect((await call({ checkin: { ...FIX, attempt: 0 } })).status).toBe(400)
    expect(recordCrewCheckin).not.toHaveBeenCalled()
  })

  it('409s a turnover that is not in progress', async () => {
    ctx('assigned')
    expect((await call()).status).toBe(409)
    expect(recordCrewCheckin).not.toHaveBeenCalled()
  })

  it('429s when rate limited', async () => {
    ctx('in_progress')
    vi.mocked(checkLimit).mockResolvedValue({ allowed: false } as never)
    expect((await call()).status).toBe(429)
  })

  it('records the check-in for an in-progress turnover', async () => {
    ctx('in_progress')
    const res = await call()
    expect(res.status).toBe(200)
    expect(recordCrewCheckin).toHaveBeenCalledWith(expect.objectContaining({
      turnover: { id: 't1', org_id: 'o1', property_id: 'p1' }, fix: FIX,
    }))
  })
})
