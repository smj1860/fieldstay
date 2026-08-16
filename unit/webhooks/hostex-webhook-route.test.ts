import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Hostex inbound webhook route.
//
// Two properties carry the security of this endpoint, and both are unusual
// enough to be worth pinning:
//
//   1. TENANT RESOLUTION IS THE URL. Hostex's payload carries only a
//      property_id, so resolving an org from it would mean trusting that
//      provider-side ids never collide across accounts. The per-connection
//      token in the path makes it structural instead.
//
//   2. AUTHENTICATION IS TRUST-ON-FIRST-USE, because Hostex returns the
//      webhook secret from no API at all. The first delivery's secret is
//      claimed atomically; every later one must match it. The claim's
//      `is(webhook_secret_hash, null)` filter is what makes two simultaneous
//      first deliveries settle rather than race.
//
// Plus the budget constraint: Hostex allows 3 seconds and NEVER retries, so
// the route must enqueue and return — never do the work inline.
// ============================================================================

const sendMock = vi.fn()
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => sendMock(...a) } }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))

import { POST } from '@/app/api/webhooks/hostex/[token]/route'
import { createServiceClient } from '@/lib/supabase/server'
import { createHash } from 'crypto'

const TOKEN  = 'a'.repeat(64)
const SECRET = 'hostex-secret-value'
const HASH   = createHash('sha256').update(SECRET).digest('hex')

const ACTIVE = { user_id: 'u1', org_id: 'org1', status: 'active', webhook_secret_hash: HASH }

/**
 * Minimal PostgREST double. `claimResult` is what the atomic
 * secret-claim UPDATE resolves to — null models "someone else claimed first".
 */
function stubSupabase(opts: {
  connection: Record<string, unknown> | null
  claimResult?: Record<string, unknown> | null
  recheck?: Record<string, unknown> | null
}) {
  const updates: Array<Record<string, unknown>> = []
  let selectCount = 0

  const chain: Record<string, unknown> = {}
  const self = () => chain

  Object.assign(chain, {
    select: () => { selectCount++; return chain },
    update: (p: Record<string, unknown>) => { updates.push(p); chain.__isUpdate = true; return chain },
    eq: self,
    is: self,
    maybeSingle: async () => {
      if (chain.__isUpdate) return { data: opts.claimResult ?? null, error: null }
      // First select = the connection read; a later one = the post-race recheck.
      if (selectCount > 1) return { data: opts.recheck ?? null, error: null }
      return { data: opts.connection, error: null }
    },
  })

  // A fresh builder per .from(), as PostgREST does — otherwise the update
  // flag leaks into the next query and the recheck reads the claim's result.
  vi.mocked(createServiceClient).mockReturnValue({
    from: () => { chain.__isUpdate = false; return chain },
  } as never)
  return { updates }
}

function req(body: unknown, secret: string | null = SECRET) {
  return new Request('https://app.fieldstay.app/api/webhooks/hostex/' + TOKEN, {
    method:  'POST',
    headers: secret ? { 'Hostex-Webhook-Secret-Token': secret } : {},
    body:    JSON.stringify(body),
  }) as never
}

const params = Promise.resolve({ token: TOKEN })
const RESERVATION_EVENT = { event: 'reservation_created', reservation_code: 'HX-1', property_id: 4242 }

beforeEach(() => vi.clearAllMocks())

describe('authentication', () => {
  it('rejects a delivery with no secret header', async () => {
    stubSupabase({ connection: ACTIVE })
    const res = await POST(req(RESERVATION_EVENT, null), { params })
    expect(res.status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rejects an unknown token', async () => {
    stubSupabase({ connection: null })
    expect((await POST(req(RESERVATION_EVENT), { params })).status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rejects a revoked connection — deliveries outlive a disconnect', async () => {
    stubSupabase({ connection: { ...ACTIVE, status: 'revoked' } })
    expect((await POST(req(RESERVATION_EVENT), { params })).status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('rejects a wrong secret', async () => {
    stubSupabase({ connection: ACTIVE })
    expect((await POST(req(RESERVATION_EVENT, 'not-the-secret'), { params })).status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('accepts and CLAIMS the secret on the very first delivery (TOFU)', async () => {
    // Hostex returns this value from no API, so the first delivery is the only
    // place it can ever be learned.
    const { updates } = stubSupabase({
      connection:  { ...ACTIVE, webhook_secret_hash: null },
      claimResult: { user_id: 'u1' },
    })

    const res = await POST(req(RESERVATION_EVENT), { params })

    expect(res.status).toBe(200)
    expect(updates).toEqual([expect.objectContaining({ webhook_secret_hash: HASH })])
    // The HASH, never the secret itself.
    expect(JSON.stringify(updates)).not.toContain(SECRET)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('re-verifies rather than trusting itself when it loses the claim race', async () => {
    // Two simultaneous first deliveries: the loser's UPDATE matches no row.
    // It must then compare against what the winner stored, not assume it won.
    const { updates } = stubSupabase({
      connection:  { ...ACTIVE, webhook_secret_hash: null },
      claimResult: null,
      recheck:     { webhook_secret_hash: HASH },
    })

    expect((await POST(req(RESERVATION_EVENT), { params })).status).toBe(200)
    expect(updates).toHaveLength(1)
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('rejects the claim-race loser whose secret disagrees with the winner', async () => {
    stubSupabase({
      connection:  { ...ACTIVE, webhook_secret_hash: null },
      claimResult: null,
      recheck:     { webhook_secret_hash: createHash('sha256').update('other').digest('hex') },
    })

    expect((await POST(req(RESERVATION_EVENT), { params })).status).toBe(401)
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('dispatch', () => {
  it('enqueues an Inngest event and returns immediately — never works inline', async () => {
    // The 3-second, zero-retry budget: a slow ack is a LOST event.
    stubSupabase({ connection: ACTIVE })

    const res = await POST(req(RESERVATION_EVENT), { params })

    expect(res.status).toBe(200)
    expect(sendMock).toHaveBeenCalledWith({
      name: 'integration/hostex.webhook.received',
      data: {
        user_id:          'u1',
        org_id:           'org1',
        event:            'reservation_created',
        reservation_code: 'HX-1',
        property_id:      '4242',
      },
    })
  })

  it('stringifies property_id so it matches the property map key', async () => {
    stubSupabase({ connection: ACTIVE })
    await POST(req({ ...RESERVATION_EVENT, property_id: 99 }), { params })
    expect(sendMock.mock.calls[0]![0].data.property_id).toBe('99')
  })

  it('acknowledges an unhandled event without enqueuing', async () => {
    // Hostex explicitly requires consumers to ignore unexpected parameters
    // rather than reject the notification — so a 200, not a 400.
    stubSupabase({ connection: ACTIVE })
    const res = await POST(req({ event: 'message_created' }), { params })
    expect(res.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('acknowledges an actionable event missing its reservation_code', async () => {
    stubSupabase({ connection: ACTIVE })
    const res = await POST(req({ event: 'reservation_updated' }), { params })
    expect(res.status).toBe(200)
    expect(sendMock).not.toHaveBeenCalled()
  })
})
