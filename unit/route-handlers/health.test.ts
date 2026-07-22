import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

import { GET } from '@/app/api/health/route'
import { createClient } from '@/lib/supabase/server'

function makeSupabase(error: unknown = null) {
  const chain: Record<string, unknown> = {}
  chain.select      = vi.fn(() => chain)
  chain.limit       = vi.fn(() => chain)
  chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error }))
  return { from: vi.fn(() => chain) }
}

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 ok when the DB round-trip succeeds', async () => {
    vi.mocked(createClient).mockResolvedValue(makeSupabase(null) as never)

    const res = await GET()

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('returns 503 degraded when the DB round-trip errors', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeSupabase({ message: 'connection refused' }) as never,
    )

    const res = await GET()

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('degraded')
  })

  it('returns 503 error when createClient itself throws', async () => {
    vi.mocked(createClient).mockRejectedValue(new Error('boom'))

    const res = await GET()

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('error')
  })
})
