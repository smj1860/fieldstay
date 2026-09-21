import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Lodgify inbound webhook route.
//
// This endpoint is the weakest-authenticated surface of any provider here, and
// deliberately so: Lodgify documents NO webhook signature, NO shared secret,
// and NO verification header anywhere reachable, so the route is written for
// the assumption that a delivery is an unauthenticated HTTP request from
// whoever learns the URL.
//
// Three properties make that safe, and this file exists to pin all three
// before a real Lodgify account can confirm anything:
//
//   1. THE URL IS THE CREDENTIAL. A 32-byte token minted by us, uniquely
//      indexed, that only ever travelled to Lodgify — and it is also the
//      tenant boundary, so a delivery cannot name someone else's org.
//   2. THE BODY IS NEVER TRUSTED FOR FACTS. At most an id crosses into the
//      handler; every fact is re-read from Lodgify with our own key. A forged
//      delivery can at worst cause a redundant re-read.
//   3. AN UNREADABLE DELIVERY IS STILL A SIGNAL. Unparseable, oversized, or
//      an id field spelled differently than we guess → a window sweep, never
//      a drop. This is what makes a WRONG shape guess cost extra work rather
//      than a lost booking.
// ============================================================================

const sendMock = vi.fn()
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => sendMock(...a) } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))

import { POST } from '@/app/api/webhooks/lodgify/[token]/route'
import { createServiceClient } from '@/lib/supabase/server'

const TOKEN = 'b'.repeat(64)
const ACTIVE = { user_id: 'u1', org_id: 'org1', status: 'active' }

/** Minimal PostgREST double — one connection read is all this route makes. */
function stubSupabase(connection: Record<string, unknown> | null) {
  const chain: Record<string, unknown> = {}
  const self = () => chain

  Object.assign(chain, {
    select:      self,
    eq:          self,
    maybeSingle: async () => ({ data: connection, error: null }),
  })

  vi.mocked(createServiceClient).mockReturnValue({ from: () => chain } as never)
}

function req(body: string) {
  return new Request(`https://app.fieldstay.app/api/webhooks/lodgify/${TOKEN}`, {
    method: 'POST',
    body,
  }) as never
}

const params = Promise.resolve({ token: TOKEN })

/** The event payload the route enqueued, for assertions. */
function sentData(): Record<string, unknown> {
  return (sendMock.mock.calls.at(-1)?.[0] as { data: Record<string, unknown> }).data
}

beforeEach(() => vi.clearAllMocks())

describe('authentication is the URL token', () => {
  it('rejects a token matching no connection', async () => {
    stubSupabase(null)
    const res = await POST(req('{}'), { params })
    expect(res.status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rejects a revoked connection', async () => {
    stubSupabase({ ...ACTIVE, status: 'revoked' })
    expect((await POST(req('{}'), { params })).status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('ACCEPTS a connection in error status', async () => {
    // 'error' means the last SYNC failed — an expired key, a 5xx — and says
    // nothing about whether this delivery is genuine. Rejecting on it stops
    // deliveries during exactly the window they matter most, while the daily
    // reconcile keeps the integration looking healthy.
    stubSupabase({ ...ACTIVE, status: 'error' })
    expect((await POST(req('{}'), { params })).status).toBe(200)
    expect(sendMock).toHaveBeenCalled()
  })

  it('rejects a connection with no org', async () => {
    stubSupabase({ ...ACTIVE, org_id: null })
    expect((await POST(req('{}'), { params })).status).toBe(401)
  })

  it('answers every rejection identically, so neither half can be probed', async () => {
    stubSupabase(null)
    const missing = await POST(req('{}'), { params })

    stubSupabase({ ...ACTIVE, status: 'revoked' })
    const revoked = await POST(req('{}'), { params })

    expect(missing.status).toBe(revoked.status)
    expect(await missing.json()).toEqual(await revoked.json())
  })
})

describe('the body is a ping, not a record', () => {
  beforeEach(() => stubSupabase(ACTIVE))

  it('enqueues ONLY ids — never the payload, never the token', async () => {
    await POST(req(JSON.stringify({
      event:      'booking_change',
      booking_id: 9001,
      // Everything below is the kind of thing a forged delivery would want us
      // to believe. None of it may cross the boundary.
      status:     'Booked',
      total_amount: 99999,
      guest:      { name: 'Mallory', email: 'm@example.com' },
      org_id:     'someone-elses-org',
    })), { params })

    expect(sentData()).toEqual({
      user_id:    'u1',
      org_id:     'org1',
      event:      'booking_change',
      booking_id: '9001',
    })
  })

  it('takes the org from the CONNECTION, never from the payload', async () => {
    await POST(req(JSON.stringify({ booking_id: 1, org_id: 'attacker-org', user_id: 'attacker' })), { params })
    expect(sentData().org_id).toBe('org1')
    expect(sentData().user_id).toBe('u1')
  })

  it('accepts a numeric id in any of the plausible spellings', async () => {
    for (const body of [
      { booking_id: 9001 },
      { id: 9001 },
      { booking: { id: 9001 } },
      { booking_id: '9001' },
    ]) {
      sendMock.mockClear()
      await POST(req(JSON.stringify(body)), { params })
      expect(sentData().booking_id).toBe('9001')
    }
  })

  it('refuses a non-numeric id rather than letting it steer an API path', async () => {
    // extractBookingId is digits-only on purpose: this value is interpolated
    // into the path of the call the handler then makes with our own key.
    await POST(req(JSON.stringify({ booking_id: '../../account' })), { params })
    expect(sentData().booking_id).toBeNull()
  })
})

describe('an unreadable delivery still means something changed', () => {
  beforeEach(() => stubSupabase(ACTIVE))

  it('sweeps rather than drops when the body will not parse', async () => {
    const res = await POST(req('not json at all'), { params })
    expect(res.status).toBe(200)
    expect(sentData().booking_id).toBeNull()
  })

  it('sweeps rather than drops when no id field is recognisable', async () => {
    // The most likely real failure: lodgify.types.ts guessed the field name
    // wrong, because it was written from docs rather than a live payload.
    await POST(req(JSON.stringify({ event: 'booking_change', reservation: { ref: 'X' } })), { params })
    expect(sentData().booking_id).toBeNull()
  })

  it('refuses to parse an oversized body, but still sweeps', async () => {
    const huge = JSON.stringify({ booking_id: 1, padding: 'x'.repeat(70 * 1024) })
    const res  = await POST(req(huge), { params })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ignored: 'oversized_body' })
    expect(sentData().booking_id).toBeNull()
  })
})

describe('events with no consumer', () => {
  beforeEach(() => stubSupabase(ACTIVE))

  it('acknowledges and drops a rate change without enqueueing work', async () => {
    const res = await POST(req(JSON.stringify({ event: 'rate_change' })), { params })
    expect(res.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('still processes an event name it does not recognise', async () => {
    // Lodgify's exact event strings are unverified. An unknown one takes the
    // booking path, which costs one re-read and is harmless — far better than
    // dropping a real change because the name differed.
    await POST(req(JSON.stringify({ event: 'booking_brand_new_thing', booking_id: 5 })), { params })
    expect(sendMock).toHaveBeenCalled()
  })
})
