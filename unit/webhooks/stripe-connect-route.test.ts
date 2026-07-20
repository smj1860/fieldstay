import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/stripe/client', () => ({
  stripe: { webhooks: { constructEvent: vi.fn() } },
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { POST } from '@/app/api/webhooks/stripe-connect/route'
import { stripe } from '@/lib/stripe/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const updateSpy = vi.fn()
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.insert = vi.fn(() => chain)
    chain.update = vi.fn((payload: unknown) => {
      updateSpy(table, payload)
      return chain
    })
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, updateSpy }
}

function postRequest(body: string, signature: string | null) {
  const headers: HeadersInit = signature ? { 'stripe-signature': signature } : {}
  return new NextRequest('http://localhost/api/webhooks/stripe-connect', {
    method: 'POST',
    headers,
    body,
  })
}

describe('POST /api/webhooks/stripe-connect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a request with no stripe-signature header before touching the DB', async () => {
    const res = await POST(postRequest('{}', null))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a request with an invalid signature before touching the DB', async () => {
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('signature mismatch')
    })

    const res = await POST(postRequest('{}', 'bad-signature'))

    expect(res.status).toBe(400)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('short-circuits on a duplicate delivery without querying vendors', async () => {
    const supabase = makeSupabase({ stripe_processed_events: { error: { code: '23505' } } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_dup',
      type: 'account.updated',
      data: { object: { id: 'acct_1', charges_enabled: true } },
    })

    const res = await POST(postRequest('{}', 'valid-signature'))

    expect(res.status).toBe(200)
    expect(supabase.from).not.toHaveBeenCalledWith('vendors')
  })

  it('marks a vendor onboarded and audits when charges_enabled flips true', async () => {
    const supabase = makeSupabase({
      stripe_processed_events: { error: null },
      vendors: {
        data: { id: 'vendor_1', org_id: 'org_1', stripe_connect_charges_enabled: false },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_1',
      type: 'account.updated',
      data: { object: { id: 'acct_1', charges_enabled: true } },
    })

    await POST(postRequest('{}', 'valid-signature'))

    expect(supabase.updateSpy).toHaveBeenCalledWith(
      'vendors',
      expect.objectContaining({ stripe_connect_charges_enabled: true }),
    )
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'vendor.stripe_connect.onboarded' }),
    )
  })

  it('ignores account.updated for an account with no matching vendor', async () => {
    const supabase = makeSupabase({
      stripe_processed_events: { error: null },
      vendors: { data: null, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_2',
      type: 'account.updated',
      data: { object: { id: 'acct_unknown', charges_enabled: true } },
    })

    const res = await POST(postRequest('{}', 'valid-signature'))

    expect(res.status).toBe(200)
    expect(supabase.updateSpy).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
