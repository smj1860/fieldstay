import { describe, it, expect, vi } from 'vitest'
import { NextResponse, type NextRequest } from 'next/server'

const parse = vi.fn()
vi.mock('@/lib/crew-auth', () => ({
  requireCrewMember: vi.fn(async () => ({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })),
}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ checkLimit: vi.fn(), retryAfterSeconds: vi.fn(), evidenceSealRatelimit: {} }))
vi.mock('@/lib/evidence/seal', () => ({ sealPhoto: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { POST } from '@/app/api/crew/evidence/seal/route'

describe('POST /api/crew/evidence/seal', () => {
  it('rejects an unauthenticated caller with 401 before it reads or validates the body', async () => {
    const json = vi.fn(async () => { parse(); return {} })
    const res = await POST({ json } as unknown as NextRequest)
    expect(res.status).toBe(401)
    expect(json).not.toHaveBeenCalled()
  })
})
