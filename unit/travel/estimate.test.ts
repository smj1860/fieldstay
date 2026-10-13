import { describe, it, expect } from 'vitest'
import {
  chainTravel, estimateLeg, travelLegKey, roundCoord, hasCoordinates,
  straightLineMiles, minutesForMiles, type TravelStop,
} from '@/lib/travel/estimate'

// ~24km / 15mi apart on the same latitude: about 30 minutes at 30mph.
const A: TravelStop = { id: 'a', lat: 32.50, lng: -85.90 }
const B: TravelStop = { id: 'b', lat: 32.50, lng: -85.64 }
const C: TravelStop = { id: 'c', lat: 32.50, lng: -85.38 }
const NOWHERE: TravelStop = { id: 'x', lat: null, lng: null }

describe('hasCoordinates', () => {
  it('rejects null island, which is what a failed geocode looks like', () => {
    expect(hasCoordinates({ lat: 0, lng: 0 })).toBe(false)
    expect(hasCoordinates({ lat: 32.5, lng: -85.9 })).toBe(true)
  })

  it('rejects a partially-present pair', () => {
    expect(hasCoordinates({ lat: 32.5, lng: null })).toBe(false)
  })
})

describe('travelLegKey', () => {
  it('is DIRECTIONAL — A to B is not B to A', () => {
    expect(travelLegKey(A, B)).not.toBe(travelLegKey(B, A))
  })

  it('rounds to four decimals so a re-geocode does not orphan the cache', () => {
    const nudged = { lat: 32.5000004, lng: -85.9000004 }
    expect(travelLegKey(nudged, B)).toBe(travelLegKey(A, B))
  })

  it('is null when either end is unmappable', () => {
    expect(travelLegKey(A, NOWHERE)).toBeNull()
    expect(travelLegKey(NOWHERE, A)).toBeNull()
  })
})

describe('roundCoord', () => {
  it('keeps four decimal places', () => {
    expect(roundCoord(32.123456)).toBe(32.1235)
    expect(roundCoord(-85.987654)).toBe(-85.9877)
  })
})

describe('estimateLeg', () => {
  it('estimates a mappable leg', () => {
    const leg = estimateLeg(A, B)
    expect(leg.source).toBe('estimated')
    expect(leg.miles).toBeCloseTo(15, 0)
    expect(leg.minutes).toBe(30)
  })

  // The distinction the old copies collapsed: an unmeasurable leg carries
  // minutes 0 because there is nothing to add, and says `unknown` so a total
  // built from it cannot be presented as complete.
  it('labels an unmappable leg unknown, with a NULL distance rather than 0', () => {
    const leg = estimateLeg(A, NOWHERE)
    expect(leg.source).toBe('unknown')
    expect(leg.minutes).toBe(0)
    expect(leg.miles).toBeNull()
  })
})

describe('straightLineMiles / minutesForMiles', () => {
  it('returns null rather than 0 for an unmappable pair', () => {
    expect(straightLineMiles(A, NOWHERE)).toBeNull()
  })

  it('converts miles to minutes at the shared speed', () => {
    expect(minutesForMiles(15)).toBe(30)
    expect(minutesForMiles(0)).toBe(0)
  })
})

describe('chainTravel', () => {
  it('sums the legs of a day in the order given', () => {
    const chain = chainTravel([A, B, C])
    expect(chain.legs).toHaveLength(2)
    expect(chain.measured).toBe(2)
    expect(chain.unmeasured).toBe(0)
    expect(chain.source).toBe('estimated')
    expect(chain.minutes).toBe(60)
  })

  it('reports nothing for a day with fewer than two stops', () => {
    expect(chainTravel([A]).legs).toEqual([])
    expect(chainTravel([A]).source).toBe('unknown')
    expect(chainTravel([]).minutes).toBe(0)
  })

  // The defect this module exists to fix. One unmappable property used to
  // zero the WHOLE figure, which reads on screen as "no driving today".
  it('keeps the legs it CAN measure when one stop is unmappable', () => {
    const chain = chainTravel([A, B, NOWHERE, C])
    expect(chain.measured).toBe(1)
    expect(chain.unmeasured).toBe(2)
    expect(chain.minutes).toBe(30)
    expect(chain.source).toBe('mixed')
  })

  it('is unknown, not zero-estimated, when no leg can be measured', () => {
    const chain = chainTravel([NOWHERE, { ...NOWHERE, id: 'y' }])
    expect(chain.measured).toBe(0)
    expect(chain.source).toBe('unknown')
  })

  describe('with routed legs supplied', () => {
    it('prefers a routed duration over the straight line', () => {
      const known = new Map([[travelLegKey(A, B)!, { minutes: 44, miles: 21 }]])
      const chain = chainTravel([A, B], known)
      expect(chain.legs[0]!.source).toBe('routed')
      expect(chain.minutes).toBe(44)
      expect(chain.miles).toBe(21)
    })

    it('mixes routed and estimated legs rather than choosing one for the day', () => {
      const known = new Map([[travelLegKey(A, B)!, { minutes: 44, miles: 21 }]])
      const chain = chainTravel([A, B, C], known)
      expect(chain.source).toBe('mixed')
      expect(chain.minutes).toBe(74)          // 44 routed + 30 estimated
      expect(chain.legs.map((l) => l.source)).toEqual(['routed', 'estimated'])
    })

    // A routed duration with no distance must not borrow the straight line's:
    // the two figures would describe different journeys.
    it('keeps miles null on a routed leg that carries no distance', () => {
      const known = new Map([[travelLegKey(A, B)!, { minutes: 44 }]])
      const chain = chainTravel([A, B], known)
      expect(chain.legs[0]!.miles).toBeNull()
      expect(chain.miles).toBe(0)
      expect(chain.minutes).toBe(44)
    })

    it('ignores a routed leg for a pair the day does not drive', () => {
      const known = new Map([[travelLegKey(A, C)!, { minutes: 999, miles: 999 }]])
      const chain = chainTravel([A, B], known)
      expect(chain.legs[0]!.source).toBe('estimated')
      expect(chain.minutes).toBe(30)
    })
  })
})
