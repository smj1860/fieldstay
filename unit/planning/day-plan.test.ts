import { describe, it, expect } from 'vitest'
import {
  planDay, estimateMinutes,
  ARRIVAL_BUFFER_MINUTES, FALLBACK_MINUTES_PER_BEDROOM,
  type PlannableTurnover,
} from '@/lib/planning/day-plan'

/** Two properties ~24km apart, which at 48km/h is a 30-minute drive. */
const A = { lat: 32.50, lng: -85.90 }
const B = { lat: 32.50, lng: -85.64 }

const job = (over: Partial<PlannableTurnover> & { turnover_id: string }): PlannableTurnover => ({
  checkout_datetime: '2026-10-13T15:00:00.000Z',
  checkin_datetime:  null,
  lat: null, lng: null,
  duration_minutes:  120,
  ...over,
})

const at = (iso: string) => Date.parse(iso)

describe('planDay', () => {
  it('starts a single job when the property becomes free', () => {
    const { slots } = planDay([job({ turnover_id: 't1', checkout_datetime: '2026-10-13T15:00:00.000Z' })])

    expect(slots).toHaveLength(1)
    expect(slots[0]!.planned_start_at).toBe('2026-10-13T15:00:00.000Z')
    expect(slots[0]!.planned_end_at).toBe('2026-10-13T17:00:00.000Z')
  })

  it('orders by when each property becomes free, not by input order', () => {
    const { slots } = planDay([
      job({ turnover_id: 'late',  checkout_datetime: '2026-10-13T16:00:00.000Z' }),
      job({ turnover_id: 'early', checkout_datetime: '2026-10-13T10:00:00.000Z' }),
    ])
    expect(slots.map((s) => s.turnover_id)).toEqual(['early', 'late'])
  })

  // Both constraints bind. Using only the property's free time puts someone in
  // two places at once; using only their own availability has them arriving
  // while the guest is still packing.
  it('holds a job until the crew member is actually free, when that is later', () => {
    const { slots } = planDay([
      job({ turnover_id: 't1', checkout_datetime: '2026-10-13T10:00:00.000Z', duration_minutes: 120, ...A }),
      job({ turnover_id: 't2', checkout_datetime: '2026-10-13T10:30:00.000Z', ...A }),
    ])

    // t1 runs 10:00-12:00. Same location, so no travel, but the buffer applies.
    expect(slots[1]!.planned_start_at)
      .toBe(new Date(at('2026-10-13T12:00:00.000Z') + ARRIVAL_BUFFER_MINUTES * 60_000).toISOString())
  })

  it('holds a job until the property is free, when THAT is later', () => {
    const { slots } = planDay([
      job({ turnover_id: 't1', checkout_datetime: '2026-10-13T08:00:00.000Z', duration_minutes: 30, ...A }),
      job({ turnover_id: 't2', checkout_datetime: '2026-10-13T15:00:00.000Z', ...A }),
    ])
    // Free at 08:30 with hours to spare, but the second property is not.
    expect(slots[1]!.planned_start_at).toBe('2026-10-13T15:00:00.000Z')
  })

  it('adds drive time between stops that are far apart', () => {
    const near = planDay([
      job({ turnover_id: 't1', checkout_datetime: '2026-10-13T10:00:00.000Z', duration_minutes: 60, ...A }),
      job({ turnover_id: 't2', checkout_datetime: '2026-10-13T10:00:00.000Z', ...A }),
    ])
    const far = planDay([
      job({ turnover_id: 't1', checkout_datetime: '2026-10-13T10:00:00.000Z', duration_minutes: 60, ...A }),
      job({ turnover_id: 't2', checkout_datetime: '2026-10-13T10:00:00.000Z', ...B }),
    ])

    expect(at(far.slots[1]!.planned_start_at))
      .toBeGreaterThan(at(near.slots[1]!.planned_start_at))
  })

  // Coordinates are genuinely missing for plenty of properties. A plan must
  // still be produced; it simply carries no travel estimate.
  it('plans without travel when either end has no coordinates', () => {
    const { slots } = planDay([
      job({ turnover_id: 't1', checkout_datetime: '2026-10-13T10:00:00.000Z', duration_minutes: 60, ...A }),
      job({ turnover_id: 't2', checkout_datetime: '2026-10-13T10:00:00.000Z', lat: null, lng: null }),
    ])
    expect(slots[1]!.planned_start_at)
      .toBe(new Date(at('2026-10-13T11:00:00.000Z') + ARRIVAL_BUFFER_MINUTES * 60_000).toISOString())
  })

  it('adds no travel before the first job of the day', () => {
    const { slots } = planDay([job({ turnover_id: 't1', checkout_datetime: '2026-10-13T09:00:00.000Z', ...B })])
    expect(slots[0]!.planned_start_at).toBe('2026-10-13T09:00:00.000Z')
  })
})

describe('planDay — infeasible days', () => {
  // The single most valuable output: the day that will not work, seen before
  // it happens rather than after.
  it('flags a job that cannot finish before the next guest arrives', () => {
    const { slots, hasInfeasible } = planDay([job({
      turnover_id:       't1',
      checkout_datetime: '2026-10-13T15:00:00.000Z',
      checkin_datetime:  '2026-10-13T16:00:00.000Z',
      duration_minutes:  120,
    })])

    expect(slots[0]!.infeasible).toBe(true)
    expect(hasInfeasible).toBe(true)
  })

  it('does not flag a job that finishes with room to spare', () => {
    const { slots, hasInfeasible } = planDay([job({
      turnover_id:       't1',
      checkout_datetime: '2026-10-13T10:00:00.000Z',
      checkin_datetime:  '2026-10-13T16:00:00.000Z',
      duration_minutes:  120,
    })])
    expect(slots[0]!.infeasible).toBe(false)
    expect(hasInfeasible).toBe(false)
  })

  // A standalone turnover has no incoming guest. Treating its absent check-in
  // as a deadline would mark quiet days as crises.
  it('never flags a turnover with no incoming booking', () => {
    const { slots } = planDay([job({
      turnover_id: 't1', checkin_datetime: null, duration_minutes: 10_000,
    })])
    expect(slots[0]!.infeasible).toBe(false)
  })

  // Cascade: the first job running long is what makes the SECOND one late.
  // Distinct from the null case above: null means no incoming guest, an
  // unparseable date means data we could not read. Neither can be late, but
  // collapsing them would hide the second behind the first.
  it('never flags a turnover whose check-in cannot be parsed', () => {
    const { slots, hasInfeasible } = planDay([job({
      turnover_id: 't1', checkin_datetime: 'not-a-date', duration_minutes: 10_000,
    })])
    expect(slots[0]!.infeasible).toBe(false)
    expect(hasInfeasible).toBe(false)
  })

  it('flags a later job pushed past its check-in by an earlier overrun', () => {
    const { slots } = planDay([
      job({
        turnover_id: 'first', checkout_datetime: '2026-10-13T09:00:00.000Z',
        checkin_datetime: '2026-10-13T20:00:00.000Z', duration_minutes: 300, ...A,
      }),
      job({
        turnover_id: 'second', checkout_datetime: '2026-10-13T10:00:00.000Z',
        checkin_datetime: '2026-10-13T15:00:00.000Z', duration_minutes: 120, ...A,
      }),
    ])

    expect(slots.find((s) => s.turnover_id === 'first')!.infeasible).toBe(false)
    expect(slots.find((s) => s.turnover_id === 'second')!.infeasible).toBe(true)
  })
})

describe('planDay — degenerate input', () => {
  it('returns an empty plan for no turnovers', () => {
    expect(planDay([])).toEqual({ slots: [], hasInfeasible: false })
  })

  // An unparseable timestamp must not poison the rest of the day with NaN
  // start times, which would write garbage through the CHECK constraint.
  it('skips a turnover with an unparseable checkout and still plans the rest', () => {
    const { slots } = planDay([
      job({ turnover_id: 'bad',  checkout_datetime: 'not-a-date' }),
      job({ turnover_id: 'good', checkout_datetime: '2026-10-13T11:00:00.000Z' }),
    ])
    expect(slots.map((s) => s.turnover_id)).toEqual(['good'])
    expect(slots[0]!.planned_start_at).toBe('2026-10-13T11:00:00.000Z')
  })

  it('never produces an end at or before its start', () => {
    const { slots } = planDay([job({ turnover_id: 't1', duration_minutes: 1 })])
    expect(at(slots[0]!.planned_end_at)).toBeGreaterThan(at(slots[0]!.planned_start_at))
  })
})

describe('estimateMinutes', () => {
  it('prefers this crew member\'s own baseline', () => {
    expect(estimateMinutes({ bedrooms: 3, crewMinutesPerBedroom: 40, orgMedianPerBedroom: 60 }))
      .toBe(120)
  })

  it('falls back to the org median when the crew member has no baseline', () => {
    expect(estimateMinutes({ bedrooms: 2, crewMinutesPerBedroom: null, orgMedianPerBedroom: 50 }))
      .toBe(100)
  })

  it('falls back to a constant when the org has neither', () => {
    expect(estimateMinutes({ bedrooms: 2, crewMinutesPerBedroom: null, orgMedianPerBedroom: null }))
      .toBe(FALLBACK_MINUTES_PER_BEDROOM * 2)
  })

  // A studio is 0 bedrooms in the column and is not 0 minutes of work.
  it.each([0, null])('treats %s bedrooms as one', (bedrooms) => {
    expect(estimateMinutes({ bedrooms, crewMinutesPerBedroom: 45, orgMedianPerBedroom: null }))
      .toBe(45)
  })
})
