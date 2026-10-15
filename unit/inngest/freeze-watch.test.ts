import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvents: vi.fn(async () => undefined) }))
vi.mock('@/lib/inngest/helpers', () => ({ createPmNotifications: vi.fn(async () => undefined) }))
vi.mock('@/lib/weather/tomorrow', () => ({ getTomorrowForecastForLocation: vi.fn() }))

import { freezeWatchOrg } from '@/lib/inngest/functions/cron/freeze-watch'
import { createServiceClient } from '@/lib/supabase/server'
import { getTomorrowForecastForLocation } from '@/lib/weather/tomorrow'
import { createPmNotifications } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'

const NOW = Date.parse('2026-12-01T20:00:00Z')   // forecast date: 2026-12-02 in America/Chicago
const prop = (id: string) => ({ id, org_id: 'o1', name: `P-${id}`, freeze_threshold_f: null, lat: 36, lng: -86, timezone: 'America/Chicago' })

interface Db {
  properties: unknown[]
  bookings:   unknown[]
  openWos:    unknown[]
  schedules:  unknown[]
  insertErrorFor?: string
}

function stub(db: Db) {
  const inserts: Record<string, unknown>[] = []
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'lte', 'gt', 'not', 'ilike', 'limit']) c[m] = () => c
    c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res)
    return c
  }
  vi.mocked(createServiceClient).mockReturnValue({
    from: (table: string) => {
      if (table === 'properties') return chain(db.properties)
      if (table === 'bookings') return chain(db.bookings)
      if (table === 'maintenance_schedules') return chain(db.schedules)
      return {
        select: () => chain(db.openWos),
        insert: (row: Record<string, unknown>) => {
          inserts.push(row)
          const failing = db.insertErrorFor === row.property_id
          return { select: () => ({ single: async () => failing
            ? { data: null, error: { code: '23505' } }
            : { data: { id: `wo-${row.property_id}` }, error: null } }) }
        },
      }
    },
  } as never)
  return inserts
}

function run() {
  const sendEvent = vi.fn(async () => undefined)
  const out = invokeHandler(freezeWatchOrg, {
    event: { data: { org_id: 'o1', forecast_date: '2026-12-02', now_ms: NOW } },
    step: { run: async (_n: string, cb: () => unknown) => cb(), sendEvent },
    logger: { info: vi.fn(), error: vi.fn() },
  })
  return { out, sendEvent }
}

describe('freezeWatchOrg', () => {
  beforeEach(() => {
    vi.mocked(getTomorrowForecastForLocation).mockReset()
    vi.mocked(createPmNotifications).mockClear()
  })

  it('creates one high priority work order for a vacant property below its threshold and notifies once', async () => {
    vi.mocked(getTomorrowForecastForLocation).mockResolvedValue({ temperatureMin: 18 } as never)
    const inserts = stub({ properties: [prop('a')], bookings: [], openWos: [], schedules: [] })
    const { out, sendEvent } = run()
    expect(await out).toEqual({ created: 1 })
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({
      property_id: 'a', source: 'freeze_watch', priority: 'high', status: 'pending',
      needed_by_date: '2026-12-02', vendor_id: null, portal_enabled: false,
    })
    expect(vi.mocked(createPmNotifications).mock.calls[0][1]).toHaveLength(1)
    expect(sendEvent).not.toHaveBeenCalled()
  })

  it('skips an occupied property and one that already has an open freeze work order', async () => {
    vi.mocked(getTomorrowForecastForLocation).mockResolvedValue({ temperatureMin: 10 } as never)
    const inserts = stub({
      properties: [prop('occ'), prop('open'), prop('free')],
      bookings:   [{ property_id: 'occ', checkin_date: '2026-12-01', checkout_date: '2026-12-04' }],
      openWos:    [{ property_id: 'open' }],
      schedules:  [],
    })
    const { out } = run()
    expect(await out).toEqual({ created: 1 })
    expect(inserts.map((i) => i.property_id)).toEqual(['free'])
  })

  it('treats a forecast cached before temperatureMin existed as no forecast', async () => {
    vi.mocked(getTomorrowForecastForLocation).mockResolvedValue({ temperatureMax: 40 } as never)
    const inserts = stub({ properties: [prop('a')], bookings: [], openWos: [], schedules: [] })
    expect(await run().out).toEqual({ created: 0 })
    expect(inserts).toHaveLength(0)
  })

  it('treats a forecast failure as no forecast for that property only', async () => {
    vi.mocked(getTomorrowForecastForLocation)
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ temperatureMin: 5 } as never)
    const inserts = stub({ properties: [prop('a'), prop('b')], bookings: [], openWos: [], schedules: [] })
    expect(await run().out).toEqual({ created: 1 })
    expect(inserts).toHaveLength(1)
  })

  it('dispatches to the freeze schedule vendor through the work-order/created event', async () => {
    vi.mocked(getTomorrowForecastForLocation).mockResolvedValue({ temperatureMin: 5 } as never)
    const inserts = stub({
      properties: [prop('a')], bookings: [], openWos: [],
      schedules: [{ property_id: 'a', assigned_vendor_id: 'v1', vendors: { portal_enabled: true } }],
    })
    const { out, sendEvent } = run()
    await out
    expect(inserts[0]).toMatchObject({ vendor_id: 'v1', status: 'assigned', portal_enabled: true })
    expect(sendEvent).toHaveBeenCalledTimes(1)
    const events = (sendEvent.mock.calls[0] as unknown as [string, { name: string; data: Record<string, unknown> }[]])[1]
    expect(events[0]).toMatchObject({ name: 'work-order/created', data: { vendor_id: 'v1', portal_enabled: true } })
  })

  it('recovers a replayed insert (23505) without creating or notifying twice', async () => {
    vi.mocked(getTomorrowForecastForLocation).mockResolvedValue({ temperatureMin: 5 } as never)
    stub({ properties: [prop('a')], bookings: [], openWos: [], schedules: [], insertErrorFor: 'a' })
    expect(await run().out).toEqual({ created: 0 })
    expect(vi.mocked(createPmNotifications).mock.calls[0][1]).toHaveLength(0)
  })
})
