import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/weather/tomorrow', () => ({
  getWeatherForLocation: vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  sendSMS:          vi.fn(async () => ({ sent: true })),
  buildSponsorLine: vi.fn(() => 'Try The Grill House — a local favorite.'),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'rendered sms body'),
}))
vi.mock('@/lib/sms/optin-claim', () => ({
  claimDailySmsSlot:   vi.fn(async () => true),
  releaseDailySmsSlot: vi.fn(async () => undefined),
}))

import { guidebookSmsEveningCron } from '@/lib/inngest/functions/guidebook-sms-evening-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import { sendSMS } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { claimDailySmsSlot, releaseDailySmsSlot } from '@/lib/sms/optin-claim'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as the morning-cron test
// and cron-vendor-compliance-grace-check.
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

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const optinRow = (overrides: Record<string, unknown> = {}) => ({
  id:                     'optin_1',
  org_id:                 'org_1',
  property_id:            'prop_1',
  phone_e164:             '+15551234567',
  last_evening_sms_date:  null,
  bookings:               [{ checkin_date: '2026-07-20', checkout_date: '2026-07-25' }],
  ...overrides,
})

const propertyRow = { id: 'prop_1', name: 'Lake House', lat: 32.5, lng: -85.9 }

const sponsorRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'sp_1', org_id: 'org_1', business_name: 'The Grill House',
  offer_type: 'none', offer_value: null, offer_item: null, custom_offer_text: null,
  lat: 32.5, lng: -85.91, slot_type: 'dinner_pints',
  ...overrides,
})

const clearWeather = { temperature: 78, temperatureApparent: 78, precipitationProbability: 5, weatherCode: 1000, weatherLabel: 'Clear', isRainy: false, isSnowy: false, isHot: false, isCold: false, fetchedAt: '2026-07-22T22:00:00.000Z' }
const rainyWeather  = { ...clearWeather, precipitationProbability: 85, isRainy: true, weatherCode: 4001, weatherLabel: 'Rain' }

describe('guidebookSmsEveningCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 22:00 UTC = 6:00 PM America/New_York (EDT) — inside the [17,21) evening window.
    vi.setSystemTime(new Date('2026-07-22T22:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the evening nudge SMS to an eligible in-stay guest (not checking out today) and claims the daily slot', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [optinRow()], error: null }],
      properties:                 [{ data: [propertyRow], error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 1, candidates: 1 })
    expect(claimDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_evening_sms_date', '2026-07-22')
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', {
      property_name: 'Lake House',
      offer_line:    'Try The Grill House — a local favorite.',
    })
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered sms body')
    expect(releaseDailySmsSlot).not.toHaveBeenCalled()
  })

  it('excludes a guest checking out today (no dinner nudge on checkout day)', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{
        data: [optinRow({ bookings: [{ checkin_date: '2026-07-18', checkout_date: '2026-07-22' }] })],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0, candidates: 0 })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('is a no-op when there are no eligible opt-ins', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0, candidates: 0 })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('skips entirely outside the evening send window without querying the database', async () => {
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z')) // 10:00 AM ET — before the window opens
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ skipped: 'outside evening window' })
    expect(supabase.from).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('idempotency: skips the send when another concurrent run already claimed the daily slot', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [optinRow()], error: null }],
      properties:                 [{ data: [propertyRow], error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(claimDailySmsSlot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0, candidates: 1 })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('falls back to rainy_day/general when it is raining and sends a rain_alert', async () => {
    const rainySponsor = sponsorRow({ id: 'sp_rain', business_name: 'The Cozy Cafe', slot_type: 'rainy_day' })
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [optinRow()], error: null }],
      properties:                 [{ data: [propertyRow], error: null }],
      guidebook_sponsors:         [{ data: [rainySponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(rainyWeather)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 1, candidates: 1 })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'rain_alert', expect.objectContaining({
      property_name: 'Lake House',
    }))
  })

  it('rolls back the claimed slot when the SMS send fails so a retry can attempt again', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [optinRow()], error: null }],
      properties:                 [{ data: [propertyRow], error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(sendSMS as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sent: false, reason: 'SMS_ENABLED is not true' })

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ sent: 0, candidates: 1 })
    expect(releaseDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_evening_sms_date')
  })
})
