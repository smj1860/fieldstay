import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { sweepOrgDeadlines } from '@/lib/evidence/packet/deadline-sweep'

type Rows = Record<string, unknown[]>

function fakeDb(rows: Rows) {
  const chain = (table: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'not', 'limit']) c[m] = () => c
    c.maybeSingle = async () => ({ data: rows[table]?.[0] ?? null, error: null })
    c.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(res)
    return c
  }
  return { from: (table: string) => chain(table) } as never
}

const NOW = Date.parse('2026-10-14T15:00:00Z')   // Oct 14 in Chicago
const property = { id: 'p1', name: 'Lake House', timezone: 'America/Chicago' }
const standalone = { id: 't1', property_id: 'p1', booking_id: 'b1', prev_booking_id: null, checkin_datetime: '2026-10-30T20:00:00Z' }

describe('sweepOrgDeadlines', () => {
  it('opens a countdown for the departing guest of a flagged turnover, with the stage in the dedupe key', async () => {
    const db = fakeDb({
      organizations: [{ claim_window_days: 14 }],
      turnovers: [{ id: 't1' }, standalone],
      work_orders: [],
      bookings: [{ id: 'b1', source: 'airbnb', checkout_date: '2026-10-10' }],
      properties: [property],
    })
    const out = await sweepOrgDeadlines(db, { orgId: 'o1', nowMs: NOW, onlyTurnoverId: 't1' })
    // Airbnb, checkout Oct 10: file by Oct 24, ten days left, so the 'opened' stage.
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'evidence_claim_deadline', severity: 'blue', dedupeKey: 'evidence-deadline-b1-opened',
      href: '/properties/p1/evidence?stay=b1',
    })
    expect(out[0].subtitle).toContain('2026-10-24')
  })

  it('uses the departing booking of a PAIR turnover and bounds Airbnb by the arriving check-in', async () => {
    const pair = { id: 't2', property_id: 'p1', booking_id: 'arriving', prev_booking_id: 'departing', checkin_datetime: '2026-10-16T20:00:00Z' }
    const db = fakeDb({
      organizations: [{ claim_window_days: 14 }],
      turnovers: [pair],
      bookings: [{ id: 'departing', source: 'airbnb', checkout_date: '2026-10-13' }],
      properties: [property],
    })
    const [n] = await sweepOrgDeadlines(db, { orgId: 'o1', nowMs: NOW, onlyTurnoverId: 't2' })
    // Next guest arrives Oct 16 in Chicago, so the last safe day is Oct 15: one day left.
    expect(n.dedupeKey).toBe('evidence-deadline-departing-d2')
    expect(n.severity).toBe('red')
    expect(n.subtitle).toContain('2026-10-15')
  })

  it('says the window closed once it has passed', async () => {
    const db = fakeDb({
      organizations: [{ claim_window_days: 14 }],
      turnovers: [standalone],
      bookings: [{ id: 'b1', source: 'vrbo', checkout_date: '2026-09-20' }],
      properties: [property],
    })
    const [n] = await sweepOrgDeadlines(db, { orgId: 'o1', nowMs: NOW, onlyTurnoverId: 't1' })
    expect(n.dedupeKey).toBe('evidence-deadline-b1-expired')
    expect(n.title).toContain('closed')
  })

  it('does not count down for a guest who has not left yet', async () => {
    const db = fakeDb({
      organizations: [{ claim_window_days: 14 }],
      turnovers: [standalone],
      bookings: [{ id: 'b1', source: 'airbnb', checkout_date: '2026-10-20' }],
      properties: [property],
    })
    expect(await sweepOrgDeadlines(db, { orgId: 'o1', nowMs: NOW, onlyTurnoverId: 't1' })).toEqual([])
  })

  it('one notice per stay even when two turnovers point at it, and nothing without a candidate', async () => {
    const db = fakeDb({
      organizations: [{ claim_window_days: 14 }],
      turnovers: [standalone, { ...standalone, id: 't9' }],
      work_orders: [{ source_turnover_id: 't9' }],
      bookings: [{ id: 'b1', source: 'direct', checkout_date: '2026-10-10' }],
      properties: [property],
    })
    expect(await sweepOrgDeadlines(db, { orgId: 'o1', nowMs: NOW })).toHaveLength(1)
    expect(await sweepOrgDeadlines(fakeDb({ organizations: [{ claim_window_days: 14 }], turnovers: [], work_orders: [] }),
      { orgId: 'o1', nowMs: NOW })).toEqual([])
  })
})
