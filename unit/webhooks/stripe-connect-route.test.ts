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

function makeSupabase(
  perTable: Record<string, { data?: unknown; error?: unknown }>,
  // Result the vendors UPDATE resolves to, when it must differ from the
  // vendors SELECT (e.g. to simulate a failed write).
  vendorUpdateResult?: { data?: unknown; error?: unknown },
) {
  const updateSpy = vi.fn()
  const deleteSpy = vi.fn()
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    let resolveWith = result
    const chain: Record<string, unknown> = {}
    chain.select = vi.fn(() => chain)
    chain.insert = vi.fn(() => chain)
    chain.update = vi.fn((payload: unknown) => {
      updateSpy(table, payload)
      if (table === 'vendors' && vendorUpdateResult) resolveWith = vendorUpdateResult
      return chain
    })
    chain.delete = vi.fn(() => {
      deleteSpy(table)
      return chain
    })
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(resolveWith))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveWith).then(resolve)
    return chain
  })
  return { from, updateSpy, deleteSpy }
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

  it('M-5: rotates stripe_connect_token on the charges_enabled transition, retiring the emailed onboarding link', async () => {
    const supabase = makeSupabase({
      stripe_processed_events: { error: null },
      vendors: {
        data: { id: 'vendor_1', org_id: 'org_1', stripe_connect_charges_enabled: false },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_rotate',
      type: 'account.updated',
      data: { object: { id: 'acct_1', charges_enabled: true } },
    })

    await POST(postRequest('{}', 'valid-signature'))

    const payload = supabase.updateSpy.mock.calls
      .find(([table]) => table === 'vendors')?.[1] as Record<string, unknown>
    expect(typeof payload.stripe_connect_token).toBe('string')
    expect(payload.stripe_connect_token).not.toBe('')
  })

  it('releases the dedup claim and 500s when the vendors update fails, so Stripe retries', async () => {
    // The dedup row is written BEFORE the handler. Leaving it in place after a
    // failure means Stripe's retry hits the 23505 branch and is discarded as
    // "already processed" — permanently losing the event behind a 200.
    const supabase = makeSupabase(
      {
        stripe_processed_events: { error: null },
        vendors: {
          data: { id: 'vendor_1', org_id: 'org_1', stripe_connect_charges_enabled: false },
          error: null,
        },
      },
      { data: null, error: { message: 'write conflict' } },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_fail',
      type: 'account.updated',
      data: { object: { id: 'acct_1', charges_enabled: true } },
    })

    const res = await POST(postRequest('{}', 'valid-signature'))

    expect(res.status).toBe(500)
    expect(supabase.deleteSpy).toHaveBeenCalledWith('stripe_processed_events')
    // A failed write must NOT be audited as a successful onboarding.
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('does not swallow a failed charges-revoked update either — a vendor must never be left looking payable', async () => {
    const supabase = makeSupabase(
      {
        stripe_processed_events: { error: null },
        vendors: {
          data: { id: 'vendor_1', org_id: 'org_1', stripe_connect_charges_enabled: true },
          error: null,
        },
      },
      { data: null, error: { message: 'write conflict' } },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(stripe.webhooks.constructEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      id:   'evt_revoke_fail',
      type: 'account.updated',
      data: { object: { id: 'acct_1', charges_enabled: false } },
    })

    const res = await POST(postRequest('{}', 'valid-signature'))

    expect(res.status).toBe(500)
    expect(supabase.deleteSpy).toHaveBeenCalledWith('stripe_processed_events')
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
