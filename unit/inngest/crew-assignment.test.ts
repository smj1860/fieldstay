import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn().mockResolvedValue({ data: { id: 'email_1' }, error: null }) } },
  FROM:   'FieldStay <notify@fieldstay.app>',
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn().mockResolvedValue('Your turnovers: rendered body'),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn(),
  sendSMS:              vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { handleCrewAssigned } from '@/lib/inngest/functions/crew-assignment'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderSmsBody } from '@/lib/sms/templates'
import { normalizePhoneToE164, sendSMS } from '@/lib/sms/telnyx'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — see checklist-broadcast.test.ts for the
// reference pattern.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
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

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
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

const oneTurnover = [
  {
    id:                'to_1',
    checkout_datetime: '2026-07-25T16:00:00.000Z',
    checkin_datetime:  '2026-07-25T21:00:00.000Z',
    window_minutes:    300,
    priority:          'high',
    properties:        { name: 'Lake House', timezone: 'America/Chicago' },
  },
]

describe('handleCrewAssigned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.app'
  })

  it('emails and texts a crew member with both an email and a phone on file', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: { id: 'crew_1', name: 'Crew One', email: 'crew1@test.com', phone: '5551234567' }, error: null }],
      turnovers:    [{ data: oneTurnover, error: null }],
      organizations: [{ data: { name: 'Lake Martin Delivery' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(normalizePhoneToE164 as ReturnType<typeof vi.fn>).mockReturnValue('+15551234567')
    ;(sendSMS as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const result = await invokeHandler(handleCrewAssigned, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, crew_member_id: 'crew_1', count: 1 })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'crew1@test.com',
        subject: expect.stringContaining('Lake House'),
      }),
      { idempotencyKey: 'crew-assigned-crew_1-to_1' },
    )

    expect(normalizePhoneToE164).toHaveBeenCalledWith('5551234567')
    expect(renderSmsBody).toHaveBeenCalledWith(
      'org_1',
      'crew_turnover_assigned',
      expect.objectContaining({ org_name: 'Lake Martin Delivery' }),
      [{ propertyName: 'Lake House', checkoutDatetime: '2026-07-25T16:00:00.000Z', windowMinutes: 300 }],
    )
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'Your turnovers: rendered body')
  })

  it('skips both channels when the crew member has no email and no phone', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: { id: 'crew_1', name: 'Crew One', email: null, phone: null }, error: null }],
      turnovers:    [{ data: oneTurnover, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleCrewAssigned, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ skipped: true, reason: 'no-contact-info' })
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('skips when the crew member is not found', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: null, error: null }],
      turnovers:    [{ data: oneTurnover, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleCrewAssigned, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ skipped: true, reason: 'crew-not-found' })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('skips when none of the requested turnover ids resolve for this org', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: { id: 'crew_1', name: 'Crew One', email: 'crew1@test.com', phone: null }, error: null }],
      turnovers:    [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleCrewAssigned, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ skipped: true, reason: 'no-turnovers' })
  })

  it('SMS failure is reported and non-fatal — the function still reports the crew as notified', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: { id: 'crew_1', name: 'Crew One', email: null, phone: '5551234567' }, error: null }],
      turnovers:    [{ data: oneTurnover, error: null }],
      organizations: [{ data: { name: 'Lake Martin Delivery' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(normalizePhoneToE164 as ReturnType<typeof vi.fn>).mockReturnValue('+15551234567')
    ;(sendSMS as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Telnyx 500'))

    const result = await invokeHandler(handleCrewAssigned, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, crew_member_id: 'crew_1', count: 1 })
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.crew-assigned.sms', orgId: 'org_1' }),
    )
  })

  it('skips the SMS step entirely when the phone fails E.164 normalization', async () => {
    const supabase = makeSupabase({
      crew_members: [{ data: { id: 'crew_1', name: 'Crew One', email: null, phone: 'not-a-phone' }, error: null }],
      turnovers:    [{ data: oneTurnover, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(normalizePhoneToE164 as ReturnType<typeof vi.fn>).mockReturnValue(null)

    const result = await invokeHandler(handleCrewAssigned, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, crew_member_id: 'crew_1', count: 1 })
    expect(sendSMS).not.toHaveBeenCalled()
  })
})
