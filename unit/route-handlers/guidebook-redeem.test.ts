import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/rate-limit', async () => {
  // checkLimit() is now the only sanctioned way to consult a limiter
  // (lib/rate-limit.ts). The stub delegates to the limiter doubles below
  // so existing `.limit` assertions and fail-policy tests still apply.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    guidebookRedeemLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:         checkLimitStub(),
    retryAfterSeconds:  retryAfterSecondsStub,
  }
})

import { POST } from '@/app/api/guidebook/redeem/route'
import { createServiceClient } from '@/lib/supabase/server'
import { guidebookRedeemLimiter } from '@/lib/rate-limit'

// Real UUIDs, because every one of these ids is a Postgres `uuid` column and
// the route now shape-checks before querying. The previous fixtures
// ('sponsor_1', 'tok_abc') could not have existed in production — against the
// live schema they are error 22P02, not a miss, so the suite was green on
// inputs the database would have rejected outright.
const SPONSOR_ID   = '11111111-1111-4111-8111-111111111111'
const ORG_ID       = '22222222-2222-4222-8222-222222222222'
const OTHER_ORG    = '33333333-3333-4333-8333-333333333333'
const BOOKING_ID   = '44444444-4444-4444-8444-444444444444'
const BOOKING_TOK  = '55555555-5555-4555-8555-555555555555'

/** Columns the live schema declares as `uuid` — see the mock's 22P02 branch. */
const UUID_COLUMNS = new Set(['id', 'guidebook_token'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function makeServiceClient(opts: {
  sponsorResult?: { data: unknown; error?: unknown }
  bookingResult?: { data: unknown; error?: unknown }
  insertResult?:  { error: unknown }
} = {}) {
  const insertMock = vi.fn(() => Promise.resolve(opts.insertResult ?? { error: null }))

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const eqArgs: [string, unknown][] = []
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn((col: string, val: unknown) => { eqArgs.push([col, val]); return chain })
    chain.maybeSingle = vi.fn(() => {
      // The double answers 22P02 for a non-UUID filtered against a `uuid`
      // column, because that is what Postgres does — it does NOT return zero
      // rows. Without this the mock silently accepts ids the real database
      // rejects, and any test about malformed-input handling passes whether
      // the handling exists or not.
      const badUuid = eqArgs.find(
        ([col, val]) => UUID_COLUMNS.has(col) && !UUID_RE.test(String(val)),
      )
      if (badUuid) {
        return Promise.resolve({
          data:  null,
          error: {
            code:    '22P02',
            message: `invalid input syntax for type uuid: "${String(badUuid[1])}"`,
          },
        })
      }

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

  it('returns 400 for a malformed sponsorId rather than letting Postgres 22P02 become a Sentry report', async () => {
    const res = await POST(postRequest({ sponsorId: 'sponsor_1' }))

    // A well-formed string that is not a UUID used to sail past the
    // `typeof === 'string'` check straight into `.eq('id', …)` on a uuid
    // column. Postgres answers 22P02, unwrap() throws, and the catch returns
    // {ok:true} PLUS a reportError — so on a public unauthenticated endpoint
    // anyone could burn the Sentry quota, and this route's genuine DB failures
    // would be buried in that noise.
    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('still logs the redemption — anonymously — when the bookingToken is malformed', async () => {
    const service = makeServiceClient()
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID, bookingToken: 'tok_abc' }))

    // bookings.guidebook_token is a uuid too. A malformed one threw 22P02 out
    // of unwrap(), escaped the try block entirely, and hit the outer catch —
    // so the insert never ran and the redemption was DISCARDED, not just left
    // unattributed, while the guest still saw {ok:true}. The route's own
    // stated fallback is an anonymous redemption; this is it.
    expect(res.status).toBe(200)
    expect(service.insertMock).toHaveBeenCalledWith({
      org_id:     ORG_ID,
      sponsor_id: SPONSOR_ID,
      booking_id: null,
    })
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

    const res = await POST(postRequest({ sponsorId: '99999999-9999-4999-8999-999999999999' }))
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
      bookingResult: { data: { id: BOOKING_ID, org_id: ORG_ID }, error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID, bookingToken: BOOKING_TOK }))

    expect(res.status).toBe(200)
    expect(service.insertMock).toHaveBeenCalledWith({
      org_id:     ORG_ID,
      sponsor_id: SPONSOR_ID,
      booking_id: BOOKING_ID,
    })
  })

  it('logs anonymously (booking_id: null) when the booking token belongs to a different org — tenant isolation', async () => {
    const service = makeServiceClient({
      bookingResult: { data: { id: BOOKING_ID, org_id: OTHER_ORG }, error: null },
    })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ sponsorId: SPONSOR_ID, bookingToken: BOOKING_TOK }))

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
