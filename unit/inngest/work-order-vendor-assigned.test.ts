import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NonRetriableError } from 'inngest'

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
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotification: vi.fn(async () => undefined),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'rendered sms body'),
}))
vi.mock('@/lib/assets/manual-lookup', () => ({
  getManualUrlForAsset: vi.fn(async () => null),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn((raw: string) => `+1${raw.replace(/\D/g, '').slice(-10)}`),
  sendSMS: vi.fn(async () => ({ sent: true })),
}))
vi.mock('@/lib/utils/timezone', () => ({
  formatPropertyTime: vi.fn(() => '11:00 AM CDT'),
}))

import { handleWorkOrderVendorAssigned } from '@/lib/inngest/functions/work-order-vendor-assigned'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { createPmNotification } from '@/lib/inngest/helpers'
import { sendSMS } from '@/lib/sms/telnyx'
import { invokeHandler } from './test-helpers'

// Bare pass-through step stub (matching on-failure.test.ts's makeStep()) — every
// dependency each step touches is mocked above, so no need to allowlist steps.
function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

// logger.warn is used by the source but is not part of test-helpers'
// HandlerContext type — declaring it on a named variable (rather than an
// inline object literal at the call site) sidesteps TS's excess-property
// check while still providing a real .warn the source can call at runtime.
function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
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
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.update = (...a: unknown[]) => record('update', a)

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

function assignedEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      workOrderId:      'wo_1',
      orgId:            'org_1',
      vendorId:         'v1',
      previousVendorId: null,
      ...overrides,
    },
  }
}

function woRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wo_1', wo_number: 'WO-1001', title: 'Fix leaking faucet', description: 'Kitchen faucet',
    nte_amount: 250, scheduled_date: null, scheduled_time: null,
    completion_token: null, completion_token_expires_at: null, portal_enabled: true,
    status: 'pending', org_id: 'org_1', property_id: 'prop_1', vendor_id: null, asset_id: null,
    ...overrides,
  }
}

function vendorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1', name: 'Ace Plumbing', email: 'vendor@example.com', phone: null, portal_enabled: true,
    ...overrides,
  }
}

describe('handleWorkOrderVendorAssigned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches email + SMS to the vendor and notifies the PM on the happy path', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: woRow({ scheduled_date: '2026-07-25', scheduled_time: '11:00:00' }), error: null }, // fetch-context
        { error: null }, // ensure-completion-token update
      ],
      vendors: [{ data: vendorRow({ phone: '512-555-1234' }), error: null }],
      properties: [{ data: { id: 'prop_1', name: 'The Lakehouse', address: '1 Lake Dr', timezone: 'America/Chicago' }, error: null }],
      organizations: [{ data: { id: 'org_1', name: 'Lake Martin Delivery' }, error: null }],
      organization_members: [{ data: [{ user_id: 'u1' }], error: null }],
      profiles: [{ data: { full_name: 'Jane PM', phone: '512-555-9999' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderVendorAssigned, {
      event:  assignedEvent(),
      step:   makeStep(),
      logger: makeLogger(),
    })

    const tokenUpdate = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
    expect(tokenUpdate?.args[0]).toMatchObject({ portal_enabled: true, status: 'assigned', vendor_id: 'v1' })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['vendor@example.com'] }),
      expect.objectContaining({ idempotencyKey: 'wo-dispatch-vendor-assigned-wo_1-v1' }),
    )
    expect(sendSMS).toHaveBeenCalledWith('+15125551234', 'rendered sms body')
    expect(createPmNotification).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ orgId: 'org_1', type: 'work_order_dispatched' })
    )

    expect(result).toEqual({ dispatched: true, woNumber: 'WO-1001', vendorEmail: 'vendor@example.com' })
  })

  it('GATE: skips dispatch entirely when the work order has portal_enabled=false', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: woRow({ portal_enabled: false }), error: null }],
      vendors:     [{ data: vendorRow(), error: null }],
      properties:  [{ data: { id: 'prop_1', name: 'The Lakehouse', address: '1 Lake Dr', timezone: 'America/Chicago' }, error: null }],
      organizations: [{ data: { id: 'org_1', name: 'Lake Martin Delivery' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const logger = makeLogger()
    const result = await invokeHandler(handleWorkOrderVendorAssigned, { event: assignedEvent(), step: makeStep(), logger })

    expect(result).toEqual({ skipped: true, reason: 'wo_portal_disabled' })
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('skips dispatch when the vendor has no email on file', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: woRow(), error: null }],
      vendors:     [{ data: vendorRow({ email: null }), error: null }],
      properties:  [{ data: { id: 'prop_1', name: 'The Lakehouse', address: '1 Lake Dr', timezone: 'America/Chicago' }, error: null }],
      organizations: [{ data: { id: 'org_1', name: 'Lake Martin Delivery' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderVendorAssigned, {
      event: assignedEvent(), step: makeStep(), logger: makeLogger(),
    })

    expect(result).toEqual({ skipped: true, reason: 'no_vendor_email' })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('idempotency: reuses an existing completion_token instead of minting a new one or re-writing the work order', async () => {
    const supabase = makeSupabase({
      work_orders: [
        { data: woRow({ completion_token: 'existing-token-123' }), error: null }, // fetch-context — no second entry needed
      ],
      vendors:       [{ data: vendorRow(), error: null }], // no phone — SMS step skipped, keeps this test focused
      properties:    [{ data: { id: 'prop_1', name: 'The Lakehouse', address: '1 Lake Dr', timezone: 'America/Chicago' }, error: null }],
      organizations: [{ data: { id: 'org_1', name: 'Lake Martin Delivery' }, error: null }],
      organization_members: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderVendorAssigned, { event: assignedEvent(), step: makeStep(), logger: makeLogger() })

    // No work_orders.update call at all — ensure-completion-token short-circuits
    // when wo.completion_token is already set.
    expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'update')).toBe(false)
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('WO-1001') }),
      expect.anything(),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sendArgs = (resend.emails.send as any).mock.calls[0][0]
    expect(sendArgs.html).toBeDefined()
  })

  it('throws a NonRetriableError when the work order or vendor cannot be found (missing referenced record)', async () => {
    const supabase = makeSupabase({
      work_orders: [{ data: null, error: null }],
      vendors:     [{ data: vendorRow(), error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleWorkOrderVendorAssigned, { event: assignedEvent(), step: makeStep(), logger: makeLogger() })
    ).rejects.toThrow(NonRetriableError)
  })
})
