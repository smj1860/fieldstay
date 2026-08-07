import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn().mockResolvedValue('rendered cancellation body'),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn(),
  sendSMS:              vi.fn(),
}))
vi.mock('@/lib/push/client', () => ({
  sendPushToCrewMember: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { handleCrewTurnoverCancelled } from '@/lib/inngest/functions/crew-turnover-cancelled'
import { createServiceClient } from '@/lib/supabase/server'
import { renderSmsBody } from '@/lib/sms/templates'
import { normalizePhoneToE164, sendSMS } from '@/lib/sms/telnyx'
import { sendPushToCrewMember } from '@/lib/push/client'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same pattern as crew-assignment.test.ts.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = () => chain
    chain.select = record
    chain.eq     = record
    chain.limit  = record

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const BASE_EVENT = {
  data: {
    crew_member_id: 'crew_1',
    turnover_ids:   ['to_1'],
    org_id:         'org_1',
  },
}

describe('handleCrewTurnoverCancelled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pushes and texts a crew member with a phone on file', async () => {
    const supabase = makeSupabase({
      crew_members:       [{ data: { id: 'crew_1', phone: '5551234567' }, error: null }],
      organizations:      [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      push_subscriptions: [{ data: [{ endpoint: 'ep', p256dh: 'p', auth: 'a' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(normalizePhoneToE164 as ReturnType<typeof vi.fn>).mockReturnValue('+15551234567')
    ;(sendSMS as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const result = await invokeHandler(handleCrewTurnoverCancelled, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, crew_member_id: 'crew_1', count: 1 })

    expect(sendPushToCrewMember).toHaveBeenCalledWith(
      [{ endpoint: 'ep', p256dh: 'p', auth: 'a' }],
      expect.objectContaining({ title: 'Turnover cancelled', url: '/crew' }),
    )

    expect(renderSmsBody).toHaveBeenCalledWith(
      'org_1',
      'crew_turnover_cancelled',
      { org_name: 'Lake Martin Delivery', count: '1' },
      [],
    )
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered cancellation body', { orgId: 'org_1' })
  })

  it('uses plural wording and pushes only (no phone on file)', async () => {
    const supabase = makeSupabase({
      crew_members:       [{ data: { id: 'crew_1', phone: null }, error: null }],
      organizations:      [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      push_subscriptions: [{ data: [{ endpoint: 'ep', p256dh: 'p', auth: 'a' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const event = { data: { ...BASE_EVENT.data, turnover_ids: ['to_1', 'to_2'] } }
    const result = await invokeHandler(handleCrewTurnoverCancelled, { event, step: runAllStep() })

    expect(result).toEqual({ notified: true, crew_member_id: 'crew_1', count: 2 })
    expect(sendPushToCrewMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: '2 turnovers cancelled' }),
    )
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('queries push_subscriptions by crew_member_id, not user_id — crew subs are keyed by crew_member_id', async () => {
    const supabase = makeSupabase({
      crew_members:       [{ data: { id: 'crew_1', phone: null }, error: null }],
      organizations:      [{ data: { name: 'Org' }, error: null }],
      push_subscriptions: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleCrewTurnoverCancelled, { event: BASE_EVENT, step: runAllStep() })

    expect(sendPushToCrewMember).not.toHaveBeenCalled()
  })

  it('skips when the crew member is not found', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleCrewTurnoverCancelled, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ skipped: true, reason: 'crew-not-found' })
    expect(sendPushToCrewMember).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('SMS failure is reported and non-fatal — the crew member is still reported as notified', async () => {
    const supabase = makeSupabase({
      crew_members:       [{ data: { id: 'crew_1', phone: '5551234567' }, error: null }],
      organizations:      [{ data: { name: 'Org' }, error: null }],
      push_subscriptions: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(normalizePhoneToE164 as ReturnType<typeof vi.fn>).mockReturnValue('+15551234567')
    ;(sendSMS as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Telnyx 500'))

    const result = await invokeHandler(handleCrewTurnoverCancelled, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, crew_member_id: 'crew_1', count: 1 })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.crew-turnover-cancelled.sms', orgId: 'org_1' }),
    )
  })
})
