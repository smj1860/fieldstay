import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  sendSMS:               vi.fn(async () => ({ sent: true })),
  normalizePhoneToE164:  vi.fn((raw: string) => `+1${raw.replace(/\D/g, '').slice(-10)}`),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'rendered stay extension sms'),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails:  vi.fn(async () => []),
  getPmMembers: vi.fn(async () => []),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>pm alert</html>'),
}))

import { guidebookStayExtensionHandler } from '@/lib/inngest/functions/guidebook-stay-extension-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS, normalizePhoneToE164 } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { getPmEmails, getPmMembers } from '@/lib/inngest/helpers'
import { resend } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check. `stay_extension_requests` can be
// hit twice in a single run (the guest-SMS atomic claim, then the PM-notify
// claim/update), so a fixed per-table response isn't enough — order matters.
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
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function requestEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      requestId:          'req_1',
      orgId:              'org_1',
      bookingId:          'bk_1',
      propertyId:         'prop_1',
      gapDays:            4,
      discountPct:        15,
      contactMethod:      'email',
      ownerRezUrl:        null,
      guestPhoneE164:     '+15551234567',
      nextBookingCheckin: '2026-07-29',
      ...overrides,
    },
  }
}

const propertyRow = { name: 'Lake House' }
const bookingRow   = { guidebook_token: 'tok_abc123', checkout_date: '2026-07-25' }

describe('guidebookStayExtensionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('texts the still-opted-in guest and emails the PM (contactMethod=email) on the happy path', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
      guidebook_guest_sms_optins: [{ data: { is_active: true }, error: null }],
      stay_extension_requests: [
        { data: { id: 'req_1' }, error: null }, // guest-sms claim succeeds
        { data: null, error: null },            // pm_notified_at update (no destructure)
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    const result = await invokeHandler(guidebookStayExtensionHandler, { event: requestEvent(), step: makeStep() })

    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'stay_extension', expect.objectContaining({
      property_name: 'Lake House',
      checkout_date: '2026-07-25',
      portal_url:    expect.stringContaining('/g/b/tok_abc123'),
    }))
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered stay extension sms')

    expect(renderPmAlert).toHaveBeenCalledWith(expect.objectContaining({ heading: 'Stay Extension Opportunity' }))
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'pm@example.com', subject: expect.stringContaining('Lake House') }),
      { idempotencyKey: 'stay-extension-pm-req_1' },
    )

    const pmUpdateCall = supabase.calls.find(
      (c) => c.table === 'stay_extension_requests' && c.method === 'update' && 'pm_notified_at' in (c.args[0] as object),
    )
    expect(pmUpdateCall?.args[0]).toMatchObject({ pm_notified_at: expect.any(String) })

    expect(result).toEqual({ requestId: 'req_1', smsSent: true, pmNotified: true })
  })

  it('does neither a guest SMS nor a PM notification when there is no guest phone and contactMethod is ownerrez_url', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookStayExtensionHandler, {
      event: requestEvent({ guestPhoneE164: null, contactMethod: 'ownerrez_url' }),
      step:  makeStep(),
    })

    expect(sendSMS).not.toHaveBeenCalled()
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(getPmEmails).not.toHaveBeenCalled()
    expect(result).toEqual({ requestId: 'req_1', smsSent: false, pmNotified: false })
  })

  it('guest-consent: re-checks opt-in at send time and skips the guest SMS if the guest has opted out since the cron ran (PM email still sent)', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
      guidebook_guest_sms_optins: [{ data: { is_active: false }, error: null }], // opted out since dispatch
      stay_extension_requests: [
        { data: null, error: null }, // pm_notified_at update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    await invokeHandler(guidebookStayExtensionHandler, { event: requestEvent(), step: makeStep() })

    expect(sendSMS).not.toHaveBeenCalled()
    expect(renderSmsBody).not.toHaveBeenCalled()
    // The guest-SMS claim update never runs since the opt-in check short-circuits first.
    expect(supabase.calls.filter((c) => c.table === 'stay_extension_requests' && c.method === 'update')).toHaveLength(1)
    expect(resend.emails.send).toHaveBeenCalled()
  })

  it('idempotency: does not re-text a guest whose extension SMS was already claimed by a prior run', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
      guidebook_guest_sms_optins: [{ data: { is_active: true }, error: null }],
      stay_extension_requests: [
        { data: null, error: null }, // claim UPDATE ... WHERE sms_sent_at IS NULL matched 0 rows
        { data: null, error: null }, // pm_notified_at update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@example.com'])

    await invokeHandler(guidebookStayExtensionHandler, { event: requestEvent(), step: makeStep() })

    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('notifies the PM by SMS (not email) when contactMethod=sms, texting the PM\'s own normalized phone number', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
      profiles: [{ data: { phone: '512-555-9999' }, error: null }],
      stay_extension_requests: [
        { data: { id: 'req_1' }, error: null }, // pm-sms claim succeeds
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([{ userId: 'u1', email: 'pm@example.com', role: 'owner' }])

    const result = await invokeHandler(guidebookStayExtensionHandler, {
      event: requestEvent({ guestPhoneE164: null, contactMethod: 'sms' }),
      step:  makeStep(),
    })

    expect(normalizePhoneToE164).toHaveBeenCalledWith('512-555-9999')
    expect(sendSMS).toHaveBeenCalledWith('+15125559999', expect.stringContaining('Lake House'))
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(result).toEqual({ requestId: 'req_1', smsSent: false, pmNotified: true })
  })

  it('skips PM SMS notification (without throwing) when the org has no PM member on file', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([])

    await invokeHandler(guidebookStayExtensionHandler, {
      event: requestEvent({ guestPhoneE164: null, contactMethod: 'sms' }),
      step:  makeStep(),
    })

    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('idempotency: does not re-notify the PM by SMS when a prior run already claimed pm_notified_at', async () => {
    const supabase = makeSupabase({
      properties: [{ data: propertyRow, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
      profiles: [{ data: { phone: '512-555-9999' }, error: null }],
      stay_extension_requests: [
        { data: null, error: null }, // claim UPDATE ... WHERE pm_notified_at IS NULL matched 0 rows
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmMembers as ReturnType<typeof vi.fn>).mockResolvedValue([{ userId: 'u1', email: 'pm@example.com', role: 'owner' }])

    await invokeHandler(guidebookStayExtensionHandler, {
      event: requestEvent({ guestPhoneE164: null, contactMethod: 'sms' }),
      step:  makeStep(),
    })

    expect(sendSMS).not.toHaveBeenCalled()
  })
})
