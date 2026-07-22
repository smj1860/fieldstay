import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/stripe/vendor-connect-invite', () => ({
  ensureVendorConnectInvited: vi.fn(),
}))

import { vendorConnectOnboardingCron } from '@/lib/inngest/functions/cron/vendor-connect-onboarding'
import { createServiceClient } from '@/lib/supabase/server'
import { ensureVendorConnectInvited } from '@/lib/stripe/vendor-connect-invite'
import { invokeHandler } from './test-helpers'

// This cron delegates the actual Stripe-account-creation + email-send work
// to ensureVendorConnectInvited() (shared with the work-order-dispatch
// handler) — mocking that module boundary directly, rather than the
// Stripe/Resend clients it wraps, keeps this test focused on the cron's own
// logic: which vendors it fetches, how it batches them, and how it handles
// a per-vendor failure without aborting the whole run.

interface Vendor {
  id: string
  org_id: string
  name: string
  email: string
  stripe_connect_token: string
  stripe_connect_account_id: string | null
  stripe_connect_invite_sent_at: string | null
  organizations: { name: string } | null
}

function makeVendor(overrides: Partial<Vendor> & { id: string }): Vendor {
  return {
    org_id:                         'org_1',
    name:                           'Acme Plumbing',
    email:                          'vendor@example.com',
    stripe_connect_token:           `tok_${overrides.id}`,
    stripe_connect_account_id:      null,
    stripe_connect_invite_sent_at:  null,
    organizations:                  { name: 'Lake Martin PM' },
    ...overrides,
  }
}

function makeSupabase(vendorsResult: { data: Vendor[] | null; error: { message: string } | null }) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.not    = vi.fn(() => chain)
    chain.is     = vi.fn(() => chain)
    chain.gte    = vi.fn(() => chain)
    chain.then   = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (table !== 'vendors') return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      return Promise.resolve(vendorsResult).then(resolve, reject)
    }
    return chain
  })
  return { from }
}

function makeStep() {
  return {
    run:   vi.fn((_name: string, cb: () => unknown) => cb()),
    sleep: vi.fn(async (..._args: unknown[]) => undefined),
  }
}

const logger = { info: vi.fn(), error: vi.fn() }

describe('vendorConnectOnboardingCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('invites every uninvited vendor and reports the total', async () => {
    const vendors = [makeVendor({ id: 'v1' }), makeVendor({ id: 'v2', email: 'v2@example.com' })]
    const supabase = makeSupabase({ data: vendors, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(ensureVendorConnectInvited as ReturnType<typeof vi.fn>).mockResolvedValue({ invited: true })

    const result = await invokeHandler(vendorConnectOnboardingCron, {
      event:  {},
      step:   makeStep(),
      logger,
    })

    expect(result).toEqual({ invited: 2, total: 2 })
    expect(ensureVendorConnectInvited).toHaveBeenCalledTimes(2)
    expect(ensureVendorConnectInvited).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorId:           'v1',
        orgId:              'org_1',
        vendorEmail:        'vendor@example.com',
        vendorConnectToken: 'tok_v1',
        orgName:            'Lake Martin PM',
      }),
    )
  })

  it('is a no-op when there are no uninvited vendors', async () => {
    const supabase = makeSupabase({ data: [], error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(vendorConnectOnboardingCron, {
      event:  {},
      step:   makeStep(),
      logger,
    })

    expect(result).toEqual({ invited: 0 })
    expect(ensureVendorConnectInvited).not.toHaveBeenCalled()
  })

  it('throws when the vendor fetch query itself errors', async () => {
    const supabase = makeSupabase({ data: null, error: { message: 'connection reset' } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(vendorConnectOnboardingCron, { event: {}, step: makeStep(), logger }),
    ).rejects.toThrow(/connection reset/)
  })

  it('logs and continues past a single vendor failure without aborting the batch, and never logs the vendor email', async () => {
    const vendors = [makeVendor({ id: 'v1' }), makeVendor({ id: 'v2' })]
    const supabase = makeSupabase({ data: vendors, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(ensureVendorConnectInvited as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Stripe account creation failed'))
      .mockResolvedValueOnce({ invited: true })

    const errorLog = vi.fn()
    const result = await invokeHandler(vendorConnectOnboardingCron, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: errorLog },
    })

    expect(result).toEqual({ invited: 1, total: 2 })
    expect(errorLog).toHaveBeenCalledWith(
      '[vendor-connect-cron] failed to onboard vendor',
      expect.objectContaining({ vendorId: 'v1', orgId: 'org_1', error: 'Stripe account creation failed' }),
    )
    const [, metadata] = errorLog.mock.calls[0] as [string, Record<string, unknown>]
    expect(JSON.stringify(metadata)).not.toContain('vendor@example.com')
  })

  it('paces batches of 25 with a top-level sleep between them, never inside step.run', async () => {
    const vendors = Array.from({ length: 26 }, (_, i) => makeVendor({ id: `v${i}` }))
    const supabase = makeSupabase({ data: vendors, error: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(ensureVendorConnectInvited as ReturnType<typeof vi.fn>).mockResolvedValue({ invited: true })

    const step = makeStep()
    const result = await invokeHandler(vendorConnectOnboardingCron, { event: {}, step, logger })

    expect(result).toEqual({ invited: 26, total: 26 })
    // 26 vendors / batch size 25 => 2 batches => exactly 1 pacing sleep between them.
    expect(step.sleep).toHaveBeenCalledTimes(1)
    expect(step.run).toHaveBeenCalledWith('process-batch-0', expect.any(Function))
    expect(step.run).toHaveBeenCalledWith('process-batch-1', expect.any(Function))
  })
})
