import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@react-email/render', () => ({
  render: vi.fn(async () => '<html>work order dispatch</html>'),
}))
vi.mock('@/emails/WorkOrderDispatch', () => ({
  default: vi.fn((props: unknown) => props),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/stripe/vendor-connect-invite', () => ({
  ensureVendorConnectInvited: vi.fn(async () => ({ invited: true })),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmMembers:        vi.fn(async () => []),
  createPmNotification: vi.fn(async () => undefined),
}))

import { workOrderDispatch, workOrderSignedOff } from '@/lib/inngest/functions/work-order-dispatch'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { ensureVendorConnectInvited } from '@/lib/stripe/vendor-connect-invite'
import { getPmMembers, createPmNotification } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

// Both handlers here have no branching inside step.run bodies that depends on
// step-level retries/memoization — a bare pass-through step stub (matching
// on-failure.test.ts's makeStep()) is enough to exercise the real logic.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

interface QueuedByTable {
  [table: string]: unknown[]
}

// Queue-based `.from(table)` mock — see unit/owner-portal/load-owner-portal-data.test.ts.
function makeSupabase(queued: QueuedByTable) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.insert = (...a: unknown[]) => record('insert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function dispatchEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      workOrderId:     'wo_1',
      woNumber:        'WO-1001',
      token:           'tok_abc',
      publicUrl:       'https://app.fieldstay.app/work-orders/tok_abc',
      vendorEmail:     'vendor@example.com',
      vendorName:      'Ace Plumbing',
      propertyName:    'The Lakehouse',
      propertyAddress: '1 Lake Dr, Austin, TX',
      title:           'Fix leaking faucet',
      description:     'Kitchen faucet is dripping',
      nteAmount:       250,
      dispatcherName:  'Jane PM',
      dispatcherOrg:   'Lake Martin Delivery',
      dispatcherPhone: '+15125551234',
      manualUrl:       null,
      ...overrides,
    },
  }
}

describe('workOrderDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emails the vendor, logs the comms record, and invites an un-onboarded vendor to Stripe Connect', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: { id: 'wo_1', org_id: 'org_1', vendor_id: 'v1', property_id: 'prop_1' }, error: null }, // log-to-comms
        { data: { org_id: 'org_1', vendor_id: 'v1', wo_number: 'WO-1001' }, error: null },               // invite step
      ],
      communication_logs: [{ error: null }],
      vendors: [{
        data: { id: 'v1', name: 'Ace Plumbing', email: 'vendor@example.com', stripe_connect_account_id: null, stripe_connect_invite_sent_at: null, stripe_connect_token: 'vct_1' },
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(workOrderDispatch, { event: dispatchEvent(), step: makeStep() })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['vendor@example.com'], subject: 'Work Order WO-1001 — The Lakehouse' }),
      { idempotencyKey: 'work-order-dispatch-wo_1-vendor@example.com' },
    )

    const commsInsert = supabase.calls.find((c) => c.table === 'communication_logs' && c.method === 'insert')
    expect(commsInsert?.args[0]).toMatchObject({ dedup_key: 'wo-dispatch:wo_1', vendor_id: 'v1' })

    expect(ensureVendorConnectInvited).toHaveBeenCalledWith(
      expect.objectContaining({ vendorId: 'v1', vendorEmail: 'vendor@example.com', vendorConnectToken: 'vct_1' })
    )
    expect(result).toEqual({ dispatched: true, vendorEmail: 'vendor@example.com', woNumber: 'WO-1001' })
  })

  it('a redelivered event (duplicate comms log) does not throw — the unique-violation is treated as already logged', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: { id: 'wo_1', org_id: 'org_1', vendor_id: 'v1', property_id: 'prop_1' }, error: null },
        { data: { org_id: 'org_1', vendor_id: 'v1', wo_number: 'WO-1001' }, error: null },
      ],
      communication_logs: [{ error: { code: '23505', message: 'duplicate key' } }],
      vendors: [{
        data: { id: 'v1', name: 'Ace Plumbing', email: 'vendor@example.com', stripe_connect_account_id: null, stripe_connect_invite_sent_at: null, stripe_connect_token: 'vct_1' },
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(workOrderDispatch, { event: dispatchEvent(), step: makeStep() })

    expect(result).toEqual({ dispatched: true, vendorEmail: 'vendor@example.com', woNumber: 'WO-1001' })
  })

  it('idempotency: skips the Connect invite when the vendor already has a Stripe account or a prior invite', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: { id: 'wo_1', org_id: 'org_1', vendor_id: 'v1', property_id: 'prop_1' }, error: null },
        { data: { org_id: 'org_1', vendor_id: 'v1', wo_number: 'WO-1001' }, error: null },
      ],
      communication_logs: [{ error: null }],
      vendors: [{
        data: { id: 'v1', name: 'Ace Plumbing', email: 'vendor@example.com', stripe_connect_account_id: 'acct_already_onboarded', stripe_connect_invite_sent_at: null, stripe_connect_token: 'vct_1' },
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(workOrderDispatch, { event: dispatchEvent(), step: makeStep() })

    expect(ensureVendorConnectInvited).not.toHaveBeenCalled()
  })
})

function signedOffEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      workOrderId:     'wo_1',
      woNumber:        'WO-1001',
      title:           'Fix leaking faucet',
      signOffNotes:    'All done, replaced washer',
      signedOffAt:     '2026-07-20T15:00:00.000Z',
      propertyName:    'The Lakehouse',
      propertyAddress: '1 Lake Dr, Austin, TX',
      orgId:           'org_1',
      orgName:         'Lake Martin Delivery',
      vendorEmail:     'vendor@example.com',
      ...overrides,
    },
  }
}

describe('workOrderSignedOff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('notifies the PM and logs the sign-off when a PM is found', async () => {
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { userId: 'u1', email: 'pm@example.com', role: 'owner' },
    ])

    const supabase = makeSupabase({
      profiles:    [{ data: { full_name: 'Jane PM' }, error: null }],
      work_orders: [{ data: { org_id: 'org_1', vendor_id: 'v1', property_id: 'prop_1' }, error: null }],
      communication_logs: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(workOrderSignedOff, { event: signedOffEvent(), step: makeStep() })

    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        orgId: 'org_1',
        type:  'work_order_complete',
        dedupeKey: 'work-order-signed-off-pm-wo_1',
      })
    )

    const signoffInsert = supabase.calls.find((c) => c.table === 'communication_logs' && c.method === 'insert')
    expect(signoffInsert?.args[0]).toMatchObject({ dedup_key: 'wo-signoff:wo_1' })

    expect(result).toEqual({ notified: true, pmEmail: 'pm@example.com', woNumber: 'WO-1001' })
  })

  it('skips notification entirely when no PM email can be found for the org', async () => {
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(workOrderSignedOff, { event: signedOffEvent(), step: makeStep() })

    expect(result).toEqual({ skipped: 'No PM email address found' })
    expect(createPmNotification).not.toHaveBeenCalled()
  })
})
