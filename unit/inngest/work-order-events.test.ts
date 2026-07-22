import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { accounts: { create: vi.fn() } },
}))
vi.mock('@/emails/work-order', () => ({
  renderWorkOrderEmail: vi.fn(async () => '<html>quote-request</html>'),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails:        vi.fn(),
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>pm-alert</html>'),
}))
vi.mock('@/lib/resend/emails/vendor-connect-invite', () => ({
  renderVendorConnectInviteEmail: vi.fn(async () => '<html>invite</html>'),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/inngest/functions/work-order-events-helpers', () => ({
  loadDispatchContext:     vi.fn(),
  sendVendorDispatchEmail: vi.fn(),
  sendVendorDispatchSms:   vi.fn(),
}))

import {
  handleWorkOrderCreated,
  handleWorkOrderCompletedViaPortal,
  handleWorkOrderOverdue,
  handleWorkOrderQuoteRequested,
  handleWorkOrderQuoteSubmitted,
} from '@/lib/inngest/functions/work-order-events'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { stripe } from '@/lib/stripe/client'
import { renderWorkOrderEmail } from '@/emails/work-order'
import { getPmEmails, createPmNotification } from '@/lib/inngest/helpers'
import {
  loadDispatchContext,
  sendVendorDispatchEmail,
  sendVendorDispatchSms,
} from '@/lib/inngest/functions/work-order-events-helpers'
import { invokeHandler } from './test-helpers'

// Fixed canned response per table — mirrors the pattern in
// financial-ledger-idempotency.test.ts / work-order-crew-completed.test.ts.
// A table queried more than once in a single test (e.g. `vendors`: select
// then update) gets the same canned object back both times, which is fine
// here since the update call only ever destructures `{ error }`.
function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select      = vi.fn(() => chain)
    chain.eq          = vi.fn(() => chain)
    chain.in          = vi.fn(() => chain)
    chain.not         = vi.fn(() => chain)
    chain.limit       = vi.fn(() => chain)
    chain.update      = vi.fn(() => chain)
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

// Executes every step body and stubs sleepUntil/sendEvent — handleWorkOrderCreated's
// overdue-scheduling tail calls step.sleepUntil (not step.sleep), which the shared
// StepStub type doesn't declare, so it must be present here for those branches.
function makeStep() {
  return {
    run:        vi.fn((_name: string, cb: () => unknown) => cb()),
    sleepUntil: vi.fn(),
    sendEvent:  vi.fn(),
  }
}

// Several handlers destructure `logger` from the Inngest context unconditionally
// (even on paths that never call it) — always supply one so `logger.info(...)`
// on a happy path never throws on an undefined `logger`.
const defaultLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('handleWorkOrderCreated', () => {
  it('is a no-op when the portal is disabled and there is no vendor to check for overdue', async () => {
    const result = await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_1', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: null, portal_enabled: false,
        },
      },
      step: makeStep(),
    })

    expect(createServiceClient).not.toHaveBeenCalled()
    expect(loadDispatchContext).not.toHaveBeenCalled()
    expect(result).toEqual({ work_order_id: 'wo_1' })
  })

  it('dispatches the vendor by email and SMS, and notifies the PM, when portal dispatch succeeds', async () => {
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({}))
    ;(loadDispatchContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      dispatched: true, vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
      woNumber: 'WO-1', propertyName: 'The Lakehouse',
    })

    const result = await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_1', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: null, portal_enabled: true,
        },
      },
      step: makeStep(),
      logger: defaultLogger,
    })

    expect(sendVendorDispatchEmail).toHaveBeenCalledTimes(1)
    expect(sendVendorDispatchSms).toHaveBeenCalledTimes(1)
    expect(createPmNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId:     'org_1',
        type:      'work_order_dispatched',
        severity:  'green',
        dedupeKey: 'wo-pm-notified-created-wo_1',
      }),
    )
    // vendor_id is null so the Stripe Connect onboarding step never runs
    expect(stripe.accounts.create).not.toHaveBeenCalled()
    expect(result).toEqual({ work_order_id: 'wo_1' })
  })

  it('skips vendor email/SMS and the PM alert when dispatch fails (no vendor email on file)', async () => {
    ;(loadDispatchContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      dispatched: false, reason: 'no_vendor_email', vendorName: 'Ace Plumbing',
    })

    await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_2', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: null, portal_enabled: true,
        },
      },
      step: makeStep(),
    })

    expect(sendVendorDispatchEmail).not.toHaveBeenCalled()
    expect(sendVendorDispatchSms).not.toHaveBeenCalled()
    expect(createPmNotification).not.toHaveBeenCalled()
  })

  it('skips the Stripe Connect invite (dedup) when the vendor already has an invite sent or an account', async () => {
    const supabase = makeSupabase({
      vendors: {
        data: {
          id: 'vendor_1', name: 'Ace Plumbing', email: 'ace@example.com', org_id: 'org_1',
          stripe_connect_token: 'tok_abc', stripe_connect_account_id: null,
          stripe_connect_invite_sent_at: '2026-07-01T00:00:00Z',
        },
        error: null,
      },
      work_orders: { data: { scheduled_date: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(loadDispatchContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      dispatched: true, vendorEmail: 'ace@example.com', vendorName: 'Ace Plumbing',
      woNumber: 'WO-3', propertyName: 'The Lakehouse',
    })

    await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_3', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: 'vendor_1', portal_enabled: true,
        },
      },
      step: makeStep(),
      logger: defaultLogger,
    })

    expect(stripe.accounts.create).not.toHaveBeenCalled()
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('creates a Stripe Express account and sends the Connect invite for a fresh vendor', async () => {
    const supabase = makeSupabase({
      vendors: {
        data: {
          id: 'vendor_2', name: 'Ace Plumbing', email: 'ace@example.com', org_id: 'org_1',
          stripe_connect_token: 'tok_abc', stripe_connect_account_id: null,
          stripe_connect_invite_sent_at: null,
        },
        error: null,
      },
      organization_members: { data: [], error: null },
      organizations:         { data: { name: 'Lakehouse Properties' }, error: null },
      work_orders:           { data: { scheduled_date: null }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(loadDispatchContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      dispatched: true, vendorEmail: 'ace@example.com', vendorName: 'Ace Plumbing',
      woNumber: 'WO-4', propertyName: 'The Lakehouse',
    })
    ;(stripe.accounts.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'acct_123' })
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValue({ error: null })

    await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_4', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: 'vendor_2', portal_enabled: true,
        },
      },
      step: makeStep(),
      logger: defaultLogger,
    })

    expect(stripe.accounts.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'express', email: 'ace@example.com' }),
      { idempotencyKey: 'vendor-connect-create-vendor_2' },
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ace@example.com' }),
      { idempotencyKey: 'vendor-connect-invite-wo-vendor_2' },
    )
  })

  it('schedules and sends a work-order/overdue event when the WO is still open past the threshold', async () => {
    const supabase = makeSupabase({
      work_orders: { data: { scheduled_date: '2026-07-01', status: 'assigned' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const step = makeStep()

    await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_5', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: 'vendor_1', portal_enabled: false,
        },
      },
      step,
    })

    expect(step.sleepUntil).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith('schedule-overdue-check', {
      name: 'work-order/overdue',
      data: {
        work_order_id:  'wo_5',
        property_id:    'prop_1',
        org_id:         'org_1',
        scheduled_date: '2026-07-01',
        days_overdue:   3,
      },
    })
  })

  it('does not schedule an overdue event when the WO is already completed by the check date', async () => {
    const supabase = makeSupabase({
      work_orders: { data: { scheduled_date: '2026-07-01', status: 'completed' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const step = makeStep()

    await invokeHandler(handleWorkOrderCreated, {
      event: {
        data: {
          work_order_id: 'wo_6', property_id: 'prop_1', org_id: 'org_1',
          vendor_id: 'vendor_1', portal_enabled: false,
        },
      },
      step,
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})

describe('handleWorkOrderCompletedViaPortal', () => {
  it('notifies the PM with a pluralized photo count when the WO is found', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: {
          id: 'wo_1', title: 'Fix the deck', completion_notes: 'All good', actual_cost: 200,
          org_id: 'org_1',
          vendors:    [{ name: 'Ace Plumbing' }],
          properties: [{ id: 'prop_1', name: 'The Lakehouse' }],
          work_order_photos: [{ storage_path: 'a.jpg' }, { storage_path: 'b.jpg' }],
        },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderCompletedViaPortal, {
      event: { data: { work_order_id: 'wo_1', completion_token: 'tok', notes: null, photo_paths: [] } },
      step:  makeStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'work_order_complete',
      title:     '✓ Work Complete — Fix the deck at The Lakehouse',
      subtitle:  'Ace Plumbing completed this job (2 photos attached)',
      href:      '/maintenance/wo_1',
      severity:  'green',
      dedupeKey: 'wo-completed-via-portal-wo_1',
    })
    expect(result).toEqual({ work_order_id: 'wo_1', notified: true })
  })

  it('uses singular phrasing for exactly one photo', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: {
          id: 'wo_2', title: 'Fix the fence', completion_notes: null, actual_cost: null,
          org_id: 'org_1',
          vendors:    [{ name: 'Ace Plumbing' }],
          properties: [{ id: 'prop_1', name: 'The Lakehouse' }],
          work_order_photos: [{ storage_path: 'a.jpg' }],
        },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderCompletedViaPortal, {
      event: { data: { work_order_id: 'wo_2', completion_token: 'tok', notes: null, photo_paths: [] } },
      step:  makeStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, expect.objectContaining({
      subtitle: 'Ace Plumbing completed this job (1 photo attached)',
    }))
  })

  it('still returns notified:true even when the work order lookup finds nothing (no PM notification sent)', async () => {
    const supabase = makeSupabase({ work_orders: { data: null, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderCompletedViaPortal, {
      event: { data: { work_order_id: 'wo_missing', completion_token: 'tok', notes: null, photo_paths: [] } },
      step:  makeStep(),
    })

    expect(createPmNotification).not.toHaveBeenCalled()
    expect(result).toEqual({ work_order_id: 'wo_missing', notified: true })
  })
})

describe('handleWorkOrderOverdue', () => {
  it('emails the PM an overdue alert with the vendor name and idempotency key', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: {
          id: 'wo_1', title: 'Fix AC', status: 'assigned', scheduled_date: '2026-07-01',
          vendors: [{ name: 'Ace HVAC' }], properties: [{ name: 'The Lakehouse' }],
        },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    await invokeHandler(handleWorkOrderOverdue, {
      event: { data: { work_order_id: 'wo_1', org_id: 'org_1', property_id: 'prop_1', scheduled_date: '2026-07-01', days_overdue: 3 } },
      step:  makeStep(),
    })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'pm@example.com',
        subject: expect.stringContaining('Fix AC'),
      }),
      { idempotencyKey: 'wo-overdue-wo_1' },
    )
  })

  it('skips the alert entirely when the work order is already completed', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: { id: 'wo_2', title: 'Fix AC', status: 'completed', scheduled_date: '2026-07-01', vendors: null, properties: null },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderOverdue, {
      event: { data: { work_order_id: 'wo_2', org_id: 'org_1', property_id: 'prop_1', scheduled_date: '2026-07-01', days_overdue: 3 } },
      step:  makeStep(),
    })

    expect(getPmEmails).not.toHaveBeenCalled()
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('logs a warning and skips the email when there is no PM email on file', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: { id: 'wo_3', title: 'Fix AC', status: 'assigned', scheduled_date: '2026-07-01', vendors: null, properties: null },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }

    await invokeHandler(handleWorkOrderOverdue, {
      event: { data: { work_order_id: 'wo_3', org_id: 'org_1', property_id: 'prop_1', scheduled_date: '2026-07-01', days_overdue: 3 } },
      step:  makeStep(),
      logger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('handleWorkOrderQuoteRequested', () => {
  const baseQuoteRequest = {
    id: 'qr_1', quote_token: 'tok_1', status: 'pending',
    work_orders: [{
      id: 'wo_1', title: 'Fix Sink', description: 'Leaky faucet', wo_number: 'WO-5',
      category: 'plumbing', priority: 'high', scheduled_date: '2026-08-01',
      estimated_cost: 100, nte_amount: 150,
      properties: [{ name: 'The Lakehouse', address: '1 Lake Dr', city: 'Austin', state: 'TX', zip: '78701' }],
    }],
    vendors: [{ name: 'Ace Plumbing', email: 'ace@example.com' }],
  }

  it('renders and sends the vendor quote-request email with an idempotency key', async () => {
    const supabase = makeSupabase({ quote_requests: { data: baseQuoteRequest, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderQuoteRequested, {
      event: { data: { work_order_id: 'wo_1', quote_request_id: 'qr_1', property_id: 'prop_1', org_id: 'org_1', vendor_id: 'vendor_1', quote_token: 'tok_1' } },
      step:  makeStep(),
      logger: defaultLogger,
    })

    expect(renderWorkOrderEmail).toHaveBeenCalledWith(expect.objectContaining({
      vendorName: 'Ace Plumbing', jobTitle: 'Fix Sink', propertyName: 'The Lakehouse',
    }))
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ace@example.com', subject: expect.stringContaining('Fix Sink') }),
      { idempotencyKey: 'wo-quote-requested-qr_1' },
    )
  })

  it('skips sending when the quote request has no quote token yet', async () => {
    const supabase = makeSupabase({ quote_requests: { data: { ...baseQuoteRequest, quote_token: null }, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderQuoteRequested, {
      event: { data: { work_order_id: 'wo_1', quote_request_id: 'qr_1', property_id: 'prop_1', org_id: 'org_1', vendor_id: 'vendor_1', quote_token: 'tok_1' } },
      step:  makeStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('logs a warning and skips sending when the vendor has no email on file', async () => {
    const supabase = makeSupabase({
      quote_requests: { data: { ...baseQuoteRequest, vendors: [{ name: 'Ace Plumbing', email: null }] }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() }

    await invokeHandler(handleWorkOrderQuoteRequested, {
      event: { data: { work_order_id: 'wo_1', quote_request_id: 'qr_1', property_id: 'prop_1', org_id: 'org_1', vendor_id: 'vendor_1', quote_token: 'tok_1' } },
      step:  makeStep(),
      logger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})

describe('handleWorkOrderQuoteSubmitted', () => {
  it('notifies the PM with the quoted amount and notes appended to the subtitle', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: { id: 'wo_1', title: 'Fix Sink', vendors: [{ name: 'Ace Plumbing' }], properties: [{ name: 'The Lakehouse' }] },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderQuoteSubmitted, {
      event: { data: { work_order_id: 'wo_1', quote_request_id: 'qr_1', org_id: 'org_1', quoted_amount: 450, quote_notes: 'Includes parts' } },
      step:  makeStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, {
      orgId:     'org_1',
      type:      'work_order_quote_received',
      title:     '💬 Quote received — Fix Sink at The Lakehouse',
      subtitle:  'Ace Plumbing quoted $450.00 — Includes parts',
      href:      '/maintenance/wo_1',
      severity:  'amber',
      dedupeKey: 'wo-quote-submitted-qr_1',
    })
  })

  it('omits the trailing notes segment when quote_notes is null', async () => {
    const supabase = makeSupabase({
      work_orders: {
        data: { id: 'wo_2', title: 'Fix Sink', vendors: [{ name: 'Ace Plumbing' }], properties: [{ name: 'The Lakehouse' }] },
        error: null,
      },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderQuoteSubmitted, {
      event: { data: { work_order_id: 'wo_2', quote_request_id: 'qr_2', org_id: 'org_1', quoted_amount: 100, quote_notes: null } },
      step:  makeStep(),
    })

    expect(createPmNotification).toHaveBeenCalledWith(supabase, expect.objectContaining({
      subtitle: 'Ace Plumbing quoted $100.00',
    }))
  })

  it('skips notifying the PM when the work order is not found', async () => {
    const supabase = makeSupabase({ work_orders: { data: null, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleWorkOrderQuoteSubmitted, {
      event: { data: { work_order_id: 'wo_3', quote_request_id: 'qr_3', org_id: 'org_1', quoted_amount: 100, quote_notes: null } },
      step:  makeStep(),
    })

    expect(createPmNotification).not.toHaveBeenCalled()
  })
})
