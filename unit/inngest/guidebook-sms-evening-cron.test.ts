import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/weather/tomorrow', () => ({
  getWeatherForLocation:           vi.fn(),
  getTomorrowForecastForLocation:  vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  sendSMS:          vi.fn(async () => ({ sent: true })),
  buildSponsorLine: vi.fn(() => 'Try The Grill House — a local favorite.'),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'rendered sms body'),
}))
// sendClaimedDailySms is stubbed with a faithful delegating implementation
// rather than a bare vi.fn(): every assertion in this file is about WHICH slot
// gets claimed and whether it is released, and those calls now happen inside
// the helper. Delegating keeps them observable here. The helper's own
// release-on-throw contract is tested directly in unit/sms/optin-claim.test.ts
// — the crons must not be the only place it is covered.
vi.mock('@/lib/sms/optin-claim', () => {
  const claimDailySmsSlot   = vi.fn(async () => true)
  const releaseDailySmsSlot = vi.fn(async () => undefined)
  return {
    claimDailySmsSlot,
    releaseDailySmsSlot,
    sendClaimedDailySms: vi.fn(async (
      supabase: unknown,
      optinId: string,
      dateColumn: string,
      todayDate: string,
      send: () => Promise<{ sent: boolean }>,
    ) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const claimed = await (claimDailySmsSlot as any)(supabase, optinId, dateColumn, todayDate)
      if (!claimed) return false
      let res: { sent: boolean }
      try {
        res = await send()
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (releaseDailySmsSlot as any)(supabase, optinId, dateColumn)
        throw err
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!res.sent) await (releaseDailySmsSlot as any)(supabase, optinId, dateColumn)
      return res.sent
    }),
  }
})

import {
  guidebookSmsEveningCron,
  guidebookSmsEveningSend,
  nextCalendarDate,
  pickEveningSlot,
  pickEveningTemplateKey,
} from '@/lib/inngest/functions/guidebook-sms-evening-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { getWeatherForLocation, getTomorrowForecastForLocation } from '@/lib/weather/tomorrow'
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
    // These reads paginate via fetchAllRows(), which drains .order().range().
    chain.order  = (...a: unknown[]) => record('order', a)
    chain.range  = (...a: unknown[]) => record('range', a)
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
  last_evening_sms_date:  null,
  bookings:               [{ checkin_date: '2026-07-20', checkout_date: '2026-07-25' }],
  ...overrides,
})

const optinDetailRow = (overrides: Record<string, unknown> = {}) => ({
  id:         'optin_1',
  phone_e164: '+15551234567',
  is_active:  true,
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

const clearForecast  = { precipitationProbability: 5,  temperatureMax: 81, weatherCode: 1000, weatherLabel: 'Clear',      isClear: true,  fetchedAt: '2026-07-22T22:00:00.000Z' }
const wetForecast    = { precipitationProbability: 70, temperatureMax: 66, weatherCode: 4001, weatherLabel: 'Rain',       isClear: false, fetchedAt: '2026-07-22T22:00:00.000Z' }

const outdoorSponsor = sponsorRow({ id: 'sp_out', business_name: 'Ridge Kayak Co.', slot_type: 'outdoor_adventure' })

const sendEvent = { data: { optin_id: 'optin_1', org_id: 'org_1', property_id: 'prop_1', today_date: '2026-07-22', checkin_date: '2026-07-20' } }

describe('guidebookSmsEveningCron (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // 22:00 UTC = 6:00 PM America/New_York (EDT) — inside the [17,21) evening window.
    vi.setSystemTime(new Date('2026-07-22T22:00:00.000Z'))
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
    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step })

    expect(result).toEqual({ dispatched: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('fan-out-evening-sms', [
      {
        name: 'guidebook/sms_evening.requested',
        data: { optin_id: 'optin_1', org_id: 'org_1', property_id: 'prop_1', today_date: '2026-07-22', checkin_date: '2026-07-20' },
      },
    ])
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('excludes a guest checking out today (no dinner nudge on checkout day)', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{
        data: [optinListRow({ bookings: [{ checkin_date: '2026-07-18', checkout_date: '2026-07-22' }] })],
        error: null,
      }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('is a no-op when there are no eligible opt-ins', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step })

    expect(result).toEqual({ dispatched: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('skips entirely outside the evening send window without querying the database', async () => {
    vi.setSystemTime(new Date('2026-07-22T14:00:00.000Z')) // 10:00 AM ET — before the window opens
    const supabase = makeSupabase({})
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsEveningCron, { event: {}, step: makeStep() })

    expect(result).toEqual({ skipped: 'outside evening window' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('guidebookSmsEveningSend (per-guest handler)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(wetForecast)
  })

  it('sends the evening nudge SMS under the nudge budget category and claims the daily slot', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(claimDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_evening_sms_date', '2026-07-22')
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', {
      property_name: 'Lake House',
      offer_line:    'Try The Grill House — a local favorite.',
    })
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered sms body', { category: 'nudge', orgId: 'org_1' })
    expect(releaseDailySmsSlot).not.toHaveBeenCalled()
  })

  it('sends using only the featured amenity note when the property has no active sponsor', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: { ...propertyRow, amenities: { 'Fire Pit': true } }, error: null }],
      guidebook_property_configs: [{
        data: { featured_amenities: ['Fire Pit'], featured_amenity_notes: 'Starter logs on back porch.' },
        error: null,
      }],
      guidebook_sponsors: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', {
      property_name: 'Lake House',
      offer_line:    'Starter logs on back porch.',
    })
  })

  it('combines the featured amenity line and the sponsor line when both exist', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: { ...propertyRow, amenities: { 'Fire Pit': true } }, error: null }],
      guidebook_property_configs: [{
        data: { featured_amenities: ['Fire Pit'], featured_amenity_notes: 'Starter logs on back porch.' },
        error: null,
      }],
      guidebook_sponsors: [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', {
      property_name: 'Lake House',
      offer_line:    "Starter logs on back porch. Try The Grill House — a local favorite.",
    })
  })

  it('does not send when there is neither a sponsor nor a featured amenity', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(sendSMS).not.toHaveBeenCalled()
    expect(claimDailySmsSlot).not.toHaveBeenCalled()
  })

  it('never texts a guest who opted out (STOP) between dispatch and send', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow({ is_active: false }), error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

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

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('falls back to rainy_day/general when it is raining and sends a rain_alert', async () => {
    const rainySponsor = sponsorRow({ id: 'sp_rain', business_name: 'The Cozy Cafe', slot_type: 'rainy_day' })
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [rainySponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(rainyWeather)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'rain_alert', expect.objectContaining({
      property_name: 'Lake House',
    }))
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

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(releaseDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_evening_sms_date')
  })
})

// ============================================================================
// outdoor_adventure — the slot the media kit sells and neither cron ever
// selected. It fires from the EVENING cron on TOMORROW's forecast: the morning
// message is claimed once per day via last_morning_sms_date, so adding it
// there would cost the coffee shop its placement on exactly the clear mornings
// it most wants one.
// ============================================================================

describe('nextCalendarDate', () => {
  it('advances one day', () => {
    expect(nextCalendarDate('2026-07-22')).toBe('2026-07-23')
  })

  it('rolls over a month boundary', () => {
    expect(nextCalendarDate('2026-07-31')).toBe('2026-08-01')
  })

  it('rolls over a year boundary', () => {
    expect(nextCalendarDate('2026-12-31')).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(nextCalendarDate('2028-02-28')).toBe('2028-02-29')
  })
})

describe('pickEveningSlot', () => {
  it('picks outdoor_adventure when tomorrow is clear and the org has that sponsor', () => {
    expect(pickEveningSlot(false, true, true)).toBe('outdoor_adventure')
  })

  it('picks dinner_pints when tomorrow is clear but no outdoor sponsor exists', () => {
    expect(pickEveningSlot(false, true, false)).toBe('dinner_pints')
  })

  it('lets tonight\'s rain win over a clear forecast for tomorrow', () => {
    expect(pickEveningSlot(true, true, true)).toBe('rainy_day')
  })

  it('picks dinner_pints when it is neither raining nor clear tomorrow', () => {
    expect(pickEveningSlot(false, false, true)).toBe('dinner_pints')
  })
})

describe('pickEveningTemplateKey', () => {
  it('maps each slot to its template when the primary pool has a sponsor', () => {
    expect(pickEveningTemplateKey('rainy_day', true)).toBe('rain_alert')
    expect(pickEveningTemplateKey('outdoor_adventure', true)).toBe('tomorrow_outdoor')
    expect(pickEveningTemplateKey('dinner_pints', true)).toBe('evening_nudge')
  })

  it('falls back to the neutral evening nudge when the primary pool is empty', () => {
    // The pool falls back to `general`, and a general sponsor under "tomorrow
    // looks clear" reads as a claim that sponsor never made.
    expect(pickEveningTemplateKey('outdoor_adventure', false)).toBe('evening_nudge')
    expect(pickEveningTemplateKey('rainy_day', false)).toBe('evening_nudge')
  })
})

describe('guidebookSmsEveningSend — outdoor_adventure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('picks the outdoor sponsor and the tomorrow_outdoor template when tomorrow is clear', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow(), outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'tomorrow_outdoor', expect.objectContaining({
      property_name: 'Lake House',
    }))
  })

  it('asks for TOMORROW\'s forecast, not today\'s', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    // sendEvent's today_date is 2026-07-22.
    expect(getTomorrowForecastForLocation).toHaveBeenCalledWith(32.5, -85.9, '2026-07-23')
  })

  it('falls through to dinner_pints when tomorrow is clear but no outdoor sponsor exists', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', expect.objectContaining({
      property_name: 'Lake House',
    }))
  })

  it('falls through to the general pool when tomorrow is clear and the only sponsor is general', async () => {
    const generalSponsor = sponsorRow({ id: 'sp_gen', business_name: 'Main St. Mercantile', slot_type: 'general' })
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [generalSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', expect.objectContaining({
      property_name: 'Lake House',
    }))
  })

  it('sends the rain alert when it is storming tonight even though tomorrow is clear', async () => {
    const rainySponsor = sponsorRow({ id: 'sp_rain', business_name: 'The Cozy Cafe', slot_type: 'rainy_day' })
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [rainySponsor, outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(rainyWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'rain_alert', expect.objectContaining({
      property_name: 'Lake House',
    }))
  })

  it('degrades to the dinner recommendation — never to no SMS — when the forecast call throws', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow(), outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('Tomorrow.io forecast request timed out after 8000ms'))

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: true })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'evening_nudge', expect.objectContaining({
      property_name: 'Lake House',
    }))
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })

  it('still claims the daily slot exactly once on the outdoor path — no double-send', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(claimDailySmsSlot).toHaveBeenCalledTimes(1)
    expect(claimDailySmsSlot).toHaveBeenCalledWith(supabase, 'optin_1', 'last_evening_sms_date', '2026-07-22')
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(releaseDailySmsSlot).not.toHaveBeenCalled()
  })

  it('sends nothing extra when the slot is already claimed on the outdoor path', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)
    ;(claimDailySmsSlot as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)

    const result = await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    expect(result).toEqual({ optinId: 'optin_1', sent: false })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it('does not spend a Tomorrow.io call when the org has no outdoor sponsor', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [sponsorRow()], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    // The forecast cannot change the message for an org that never sold the
    // slot, and this runs once per guest per night.
    expect(getTomorrowForecastForLocation).not.toHaveBeenCalled()
  })

  it('does not spend a Tomorrow.io call when it is already raining tonight', async () => {
    const rainySponsor = sponsorRow({ id: 'sp_rain', business_name: 'The Cozy Cafe', slot_type: 'rainy_day' })
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [rainySponsor, outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(rainyWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    // Rain already won — the forecast cannot displace it.
    expect(getTomorrowForecastForLocation).not.toHaveBeenCalled()
  })

  it('queries the outdoor_adventure slot type — without this the sponsor is never in the pool', async () => {
    const supabase = makeSupabase({
      guidebook_guest_sms_optins: [{ data: optinDetailRow(), error: null }],
      properties:                 [{ data: propertyRow, error: null }],
      guidebook_sponsors:         [{ data: [outdoorSponsor], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getWeatherForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearWeather)
    ;(getTomorrowForecastForLocation as ReturnType<typeof vi.fn>).mockResolvedValue(clearForecast)

    await invokeHandler(guidebookSmsEveningSend, { event: sendEvent, step: makeStep() })

    const inCall = supabase.calls.find((c) => c.table === 'guidebook_sponsors' && c.method === 'in')
    expect(inCall?.args[1]).toContain('outdoor_adventure')
  })
})
