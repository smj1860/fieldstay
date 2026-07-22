import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    accounts:     { create: vi.fn() },
    accountLinks: { create: vi.fn() },
  },
}))
vi.mock('@/lib/rate-limit', () => ({
  vendorConnectRatelimit: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/integrations/webhook-verification', () => ({
  extractClientIp: vi.fn(() => '203.0.113.5'),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { GET } from '@/app/api/vendor-connect/[token]/onboard/route'
import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { vendorConnectRatelimit } from '@/lib/rate-limit'
import { logAuditEvent } from '@/lib/audit'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'neq', 'in']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ table, method: m, args })
        return chain
      })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

function getRequest(token: string) {
  return new NextRequest(`http://localhost/api/vendor-connect/${token}/onboard`)
}

function call(token: string) {
  return GET(getRequest(token), { params: Promise.resolve({ token }) })
}

const VALID_TOKEN = 'vendor-token-1234567890'

function baseVendor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id:     'vendor_1',
    org_id: 'org_1',
    email:  'vendor@example.com',
    name:   'Ace Plumbing',
    stripe_connect_account_id:       null,
    stripe_connect_charges_enabled:  false,
    ...overrides,
  }
}

describe('GET /api/vendor-connect/[token]/onboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
    vi.mocked(vendorConnectRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  it('rejects a token shorter than 10 chars before any rate-limit check or DB call', async () => {
    const res = await call('short')

    expect(res.status).toBe(400)
    expect(vendorConnectRatelimit.limit).not.toHaveBeenCalled()
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('returns 429 and never touches the DB when the IP rate limit is exceeded', async () => {
    vi.mocked(vendorConnectRatelimit.limit).mockResolvedValue({ success: false } as never)

    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(429)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('fails open and still serves the request when the rate limiter itself throws', async () => {
    vi.mocked(vendorConnectRatelimit.limit).mockRejectedValue(new Error('redis down'))
    const supabase = makeSupabase({ vendors: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await call(VALID_TOKEN)

    // Falls through to the normal "not found" path rather than blocking the vendor
    expect(res.status).toBe(404)
  })

  it('returns 404 for a nonexistent/invalid token before any mutation', async () => {
    const supabase = makeSupabase({ vendors: [{ data: null, error: null }] })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(404)
    expect(stripe.accounts.create).not.toHaveBeenCalled()
  })

  it('redirects to the return page when the vendor is already fully onboarded', async () => {
    const supabase = makeSupabase({
      vendors: [{ data: baseVendor({ stripe_connect_charges_enabled: true }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(
      `https://app.fieldstay.test/api/vendor-connect/${VALID_TOKEN}/return?already_onboarded=true`
    )
    expect(stripe.accounts.create).not.toHaveBeenCalled()
  })

  it('creates a Stripe account for a first-time vendor, logs an audit event, and redirects to the account link', async () => {
    const supabase = makeSupabase({
      vendors: [
        { data: baseVendor(), error: null },                 // initial lookup
        { data: { id: 'vendor_1' }, error: null },            // claim update
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(stripe.accounts.create).mockResolvedValue({ id: 'acct_new' } as never)
    vi.mocked(stripe.accountLinks.create).mockResolvedValue({ url: 'https://connect.stripe.com/setup/abc' } as never)

    const res = await call(VALID_TOKEN)

    expect(stripe.accounts.create).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { vendor_id: 'vendor_1', org_id: 'org_1' },
    }))
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId:  'org_1',
      action: 'vendor.stripe_connect.account_created',
      targetId: 'vendor_1',
    }))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://connect.stripe.com/setup/abc')
  })

  it('redirects to the status page instead of double-creating an account when a concurrent request already claimed it', async () => {
    const supabase = makeSupabase({
      vendors: [
        { data: baseVendor(), error: null }, // initial lookup: account_id still null
        { data: null, error: null },         // claim update: lost the race, no row matched
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe(`https://app.fieldstay.test/vendor-connect/${VALID_TOKEN}/status`)
    expect(stripe.accounts.create).not.toHaveBeenCalled()
  })

  it('skips account creation and just refreshes the account link when the vendor already has a real Stripe account', async () => {
    const supabase = makeSupabase({
      vendors: [{ data: baseVendor({ stripe_connect_account_id: 'acct_existing' }), error: null }],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(stripe.accountLinks.create).mockResolvedValue({ url: 'https://connect.stripe.com/setup/xyz' } as never)

    const res = await call(VALID_TOKEN)

    expect(stripe.accounts.create).not.toHaveBeenCalled()
    expect(stripe.accountLinks.create).toHaveBeenCalledWith(expect.objectContaining({ account: 'acct_existing' }))
    expect(res.headers.get('location')).toBe('https://connect.stripe.com/setup/xyz')
  })

  it('returns 500 and clears the pending sentinel when Stripe errors after claiming', async () => {
    const supabase = makeSupabase({
      vendors: [
        { data: baseVendor(), error: null },      // initial lookup
        { data: { id: 'vendor_1' }, error: null }, // claim update succeeds
      ],
    })
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)
    vi.mocked(stripe.accounts.create).mockRejectedValue(new Error('stripe down'))

    const res = await call(VALID_TOKEN)

    expect(res.status).toBe(500)
    const cleanupCall = supabase.calls.find(
      (c) => c.table === 'vendors' && c.method === 'update' && (c.args[0] as Record<string, unknown>)?.stripe_connect_account_id === null
    )
    expect(cleanupCall).toBeDefined()
  })
})
