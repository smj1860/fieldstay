import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/weather/tomorrow', () => ({
  getWeatherForLocation: vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  sendSMS:          vi.fn(async () => ({ sent: true })),
  buildSponsorLine: vi.fn(() => 'Try Joe\'s Coffee — a local favorite.'),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'rendered sms body'),
}))
vi.mock('@/lib/sms/optin-claim', () => ({
  claimDailySmsSlot:   vi.fn(async () => true),
  releaseDailySmsSlot: vi.fn(async () => undefined),
}))

import { guidebookSmsMorningCron, guidebookSmsMorningSend } from '@/lib/inngest/functions/guidebook-sms-morning-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { sendSMS } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { claimDailySmsSlot, releaseDailySmsSlot } from '@/lib/sms/optin-claim'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check: each `.from(table)` call consumes
// the next queued response for that table, in call order. `guidebook_sponsors`
// is queried on the rain-alert path AND the normal path, so a fixed
// per-table response isn't enough — order matters.
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
    chain.or     = (...a: unknown[]) => record('or', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(async () => ({ ids: [] })),
  }
}

const optinListRow = (overrides: Record<string, unknown> = {}) => ({
  id:                     'optin_1',
  org_id:                 'org_1',
  property_id:            'prop_1',
  last_morning_sms_date:  null,
  bookings:               [{ checkin_date: '2026-07-20', checkout_date: '2026-07-25' }],
  ...overrides,
})

// The send handler refetches the opt-in row by id (phone deliberately never
// travels in the event payload).
const optinDetailRow = (overrides: Record<string, unknown> = {}) => ({
  id:         'optin_1',
  phone_e164: '+15551234567',
  is_active:  true,
  ...overrides,
})

const propertyRow = { id: 'prop_1', name: 'Lake House', lat: 32.5, lng: -85.9 }

const sponsorRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sp_1', org_id: 'org_1', business_name: "Joe's Coffee",
  offer_type: 'none', offer_value: null, offer_item: null, custom_offer_text: null,
  lat: 32.5, lng: -85.91, slot_type: 'morning_brew',
  ...overrides,
})

const clearWeather = { temperature: 75, temperatureApparent: 75, precipitationProbability: 10, weatherCode: 1000, weatherLabel: 'Clear', isRainy: false, isSnowy: false, isHot: false, isCold: false, fetchedAt: '2026-07-22T13:00:00.000Z' }
const rainyWeather  = { ...clearWeather, precipitationProbability: 80, isRainy: true, weatherCode: 4001, weatherLabel: 'Rain' }

const sendEvent = { data: { optin_id: 'optin_1', org_id: 'org_1', property_id: 'prop_1', today_date: '2026-07-22' } }

describe('guidebookSmsMorningCron (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 13:00 UTC = 9:00 AM America/New_York (EDT) — inside the [7,11) morning window.
    vi.setSystemTime(new Date('2026-07-22T13:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('dispatches one send event per eligible in-stay opt-in, without the phone number', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [optinListRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookSmsMorningCron, { event: {}, step })

    expect(result).toEqual({ dispatched: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-morning-sms', [
      {
        name: 'guidebook/sms_morning.requested',
        data: { optin_id: 'optin_1', org_id: 'org_1', property_id: 'prop_1', today_date: '2026-07-22' },
      },
    ])
    // The dispatcher never sends SMS itself
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('is a no-op when there are no eligible opt-ins', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookSmsMorningCron, { event: {}, step })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('excludes guests whose stay does not cover today', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{
        data: [optinListRow({ bookings: [{ checkin_date: '2026-07-23', checkout_date: '2026-07-28' }] })],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookSmsMorningCron, { event: {}, step })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips entirely outside the morning send window without querying the database', async () => {
    vi.setSystemTime(new Date('2026-07-22T09:00:00.000Z')) // 5:00 AM ET — before the window opens
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsMorningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ skipped: 'outside morning window' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('guidebookSmsMorningSend (per-guest handler)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends the morning nudge SMS under the nudge budget category and claims the daily slot', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)

    const result = await invokeHandler(guidebookSmsMorningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(claimDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_morning_sms_date', '2026-07-22')
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'morning_nudge', {
      property_name: 'Lake House',
      temperature:   75,
      offer_line:    "Try Joe's Coffee — a local favorite.",
    })
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered sms body', { category: 'nudge' })
    expect(releaseDailySmsSlot).not.toHaveBeenCalled()
  })

  it('never texts a guest who opted out (STOP) between dispatch and send', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow({ is_active: false }), error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsMorningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(sendSMS).not.toHaveBeenCalled()
    expect(claimDailySmsSlot).not.toHaveBeenCalled()
  })

  it('idempotency: skips the send when another concurrent run already claimed the daily slot', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(claimDailySmsSlot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

    const result = await invokeHandler(guidebookSmsMorningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('prefers a rainy-day sponsor and sends a rain_alert when precipitation probability is >= 60', async () => {
    const rainySponsor = sponsorRow({ id: 'sp_rain', business_name: 'The Cozy Cafe', slot_type: 'rainy_day' })
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [
        { data: [rainySponsor], error: null },   // rainy_day lookup runs first on this path
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(rainyWeather)

    const result = await invokeHandler(guidebookSmsMorningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'rain_alert', expect.objectContaining({
      property_name: 'Lake House',
    }))
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered sms body', { category: 'nudge' })
  })

  it('rolls back the claimed slot when the SMS send fails so a retry can attempt again', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(sendSMS as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sent: false, reason: 'SMS_ENABLED is not true' })

    const result = await invokeHandler(guidebookSmsMorningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(releaseDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_morning_sms_date')
  })
})
