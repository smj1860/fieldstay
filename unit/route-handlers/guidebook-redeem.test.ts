import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', () => ({
  guidebookRedeemLimiter: { limit: vi.fn(async () => ({ success: true })) },
}))

import { POST } from '@/app/api/guidebook/redeem/route'
import { createServiceClient } from '@/lib/supabase/server'
import { guidebookRedeemLimiter } from '@/lib/rate-limit'

const SPONSOR_ID = 'sponsor_1'
const ORG_ID     = 'org_1'
const OTHER_ORG  = 'org_2'

function makeServiceClient(opts: {
  sponsorResult?: { data: unknown; error?: unknown }
  bookingResult?: { data: unknown; error?: unknown }
  insertResult?:  { error: unknown }
} = {}) {
  const insertMock = vi.fn(() => Promise.resolve(opts.insertResult ?? { error: null }))

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn(() => chain)
    chain.maybeSingle = vi.fn(() => {
      if (table === 'guidebook_sponsors') {
        return Promise.resolve(
          opts.sponsorResult ?? { data: { id: SPONSOR_ID, org_id: ORG_ID, status: 'active' }, error: null },
        )
      }
      if (table === 'bookings') {
        return Promise.resolve(opts.bookingResult ?? { data: null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })
    chain.insert = insertMock
    return chain
  })

  return { from, insertMock }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/guidebook/redeem', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/guidebook/redeem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(guidebookRedeemLimiter.limit).mockResolvedValue({ success: true } as never)
  })

  it('returns 400 when sponsorId is missing, without touching the database', async () => {
    const res = await POST(postRequest({}))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 400 when sponsorId is not a string', async () => {
    const res = await POST(postRequest({ sponsorId: 12345 }))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 429 when the per-IP rate limit is exceeded, without querying the database', async () => {
    vi.mocked(guidebookRedeemLimiter.limit).mockResolvedValue({ success: false } as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID }))

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns ok:true without inserting when the sponsor does not exist — no information disclosure', async () => {
    const service = makeServiceClient({ sponsorResult: { data: null, error: null } })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: 'nonexistent' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(service.insertMock).not.toHaveBeenCalled()
  })

  it('returns ok:true without inserting when the sponsor is not active', async () => {
    const service = makeServiceClient({
      sponsorResult: { data: { id: SPONSOR_ID, org_id: ORG_ID, status: 'cancelled' }, error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(service.insertMock).not.toHaveBeenCalled()
  })

  it('logs the redemption without a booking_id when no bookingToken is supplied', async () => {
    const service = makeServiceClient()
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID }))

    expect(res.status).toBe(200)
    expect(service.insertMock).toHaveBeenCalledWith({
      org_id:     ORG_ID,
      sponsor_id: SPONSOR_ID,
      booking_id: null,
    })
  })

  it('attaches the booking_id when the booking token resolves to a booking in the sponsor\'s own org', async () => {
    const service = makeServiceClient({
      bookingResult: { data: { id: 'booking_1', org_id: ORG_ID }, error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID, bookingToken: 'tok_abc' }))

    expect(res.status).toBe(200)
    expect(service.insertMock).toHaveBeenCalledWith({
      org_id:     ORG_ID,
      sponsor_id: SPONSOR_ID,
      booking_id: 'booking_1',
    })
  })

  it('logs anonymously (booking_id: null) when the booking token belongs to a different org — tenant isolation', async () => {
    const service = makeServiceClient({
      bookingResult: { data: { id: 'booking_1', org_id: OTHER_ORG }, error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID, bookingToken: 'tok_cross_org' }))

    expect(res.status).toBe(200)
    expect(service.insertMock).toHaveBeenCalledWith({
      org_id:     ORG_ID,
      sponsor_id: SPONSOR_ID,
      booking_id: null,
    })
  })

  it('returns ok:true even when the insert fails (table not yet migrated) — never fails the guest UX', async () => {
    const service = makeServiceClient({ insertResult: { error: { message: 'relation does not exist' } } })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
  })

  it('returns ok:true even when an unexpected error is thrown', async () => {
    vi.mocked(createServiceClient).mockImplementation(() => {
      throw new Error('unexpected failure')
    })

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
  })
})
