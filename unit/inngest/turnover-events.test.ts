import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails:          vi.fn(),
  createPmNotification: vi.fn(),
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>pm-alert</html>'),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/observability/metrics', () => ({
  incrementCounter: vi.fn(),
}))

import { handleTurnoverCreated } from '@/lib/inngest/functions/turnover-events'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { invokeHandler } from './test-helpers'

// Fixed canned response per table — turnovers and properties are each
// fetched exactly once (inside a single Promise.all), so no queueing is
// needed here, matching the pattern in work-order-crew-completed.test.ts.
function makeSupabase(perTable: Record<string, { data?: unknown; error?: unknown }>) {
  const from = vi.fn((table: string) => {
    const result = perTable[table] ?? { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => Promise.resolve(result))
    return chain
  })
  return { from }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const baseEvent = {
  turnover_id:       'to_1',
  property_id:       'prop_1',
  org_id:            'org_1',
  checkout_datetime: '2026-07-25T16:00:00Z',
  checkin_datetime:  '2026-07-25T20:00:00Z',
  window_minutes:    240,
}

const baseProperty = { name: 'The Lakehouse', city: 'Austin', state: 'TX', timezone: 'America/Chicago' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.test'
})

describe('handleTurnoverCreated', () => {
  it('returns warned:false and sends no email when no crew is assigned yet', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: {
          id: 'to_1', checkout_datetime: baseEvent.checkout_datetime, checkin_datetime: baseEvent.checkin_datetime,
          window_minutes: 240, status: 'pending_assignment', priority: 'medium',
          turnover_assignments: [],
        },
        error: null,
      },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ turnover_id: 'to_1', warned: false })
  })

  it('emails each assigned crew member with an idempotency key and reports crewNotified', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: {
          id: 'to_1', checkout_datetime: baseEvent.checkout_datetime, checkin_datetime: baseEvent.checkin_datetime,
          window_minutes: 240, status: 'assigned', priority: 'high',
          turnover_assignments: [
            { crew_member_id: 'crew_1', crew_members: { name: 'Maria', email: 'maria@example.com', phone: '555-1111', preferred_contact: 'email' } },
          ],
        },
        error: null,
      },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'maria@example.com' }),
      { idempotencyKey: 'turnover-assigned-to_1-crew_1' },
    )
    expect(result).toEqual({ turnover_id: 'to_1', crewNotified: 1 })
  })

  it('skips the email for an assigned crew member with no email on file, but still counts them as notified', async () => {
    const supabase = makeSupabase({
      turnovers: {
        data: {
          id: 'to_1', checkout_datetime: baseEvent.checkout_datetime, checkin_datetime: baseEvent.checkin_datetime,
          window_minutes: 240, status: 'assigned', priority: 'medium',
          turnover_assignments: [
            { crew_member_id: 'crew_2', crew_members: { name: 'Bob', email: null, phone: '555-2222', preferred_contact: 'sms' } },
          ],
        },
        error: null,
      },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ turnover_id: 'to_1', crewNotified: 1 })
  })

  it('returns undefined and sends nothing when the turnover or property lookup misses', async () => {
    const supabase = makeSupabase({
      turnovers:  { data: null, error: null },
      properties: { data: baseProperty, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleTurnoverCreated, {
      event: { data: baseEvent },
      step:  runAllStep(),
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toBeUndefined()
  })
})
