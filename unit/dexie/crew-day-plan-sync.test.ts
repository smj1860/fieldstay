import { describe, it, expect } from 'vitest'
import { publishedPlan } from '@/lib/dexie/sync/turnovers'

/**
 * The publish gate is the whole safety design of the day planner, and this is
 * the half that runs on the crew's device.
 *
 * An unpublished planned time must never reach Dexie. Gating at SYNC time
 * rather than in the component means no later UI change can start showing one
 * by accident, which matters because the point of the gate is that a crew
 * member is never handed a start time no human reviewed.
 */

const START = '2026-10-13T15:00:00.000Z'
const END   = '2026-10-13T17:00:00.000Z'
const NONE  = { planned_start_at: null, planned_end_at: null }

describe('publishedPlan', () => {
  it('returns the window once the day is published', () => {
    expect(publishedPlan([{
      planned_start_at: START, planned_end_at: END, plan_published_at: '2026-10-12T20:00:00.000Z',
    }])).toEqual({ planned_start_at: START, planned_end_at: END })
  })

  // The one that matters. A planned time exists but no PM has signed off on
  // it, so the device must not learn it.
  it('withholds a computed plan that has not been published', () => {
    expect(publishedPlan([{
      planned_start_at: START, planned_end_at: END, plan_published_at: null,
    }])).toEqual(NONE)
  })

  it('returns nothing when there is no plan at all', () => {
    expect(publishedPlan([{
      planned_start_at: null, planned_end_at: null, plan_published_at: null,
    }])).toEqual(NONE)
  })

  // A CHECK constraint makes this unreachable from the planner, but the
  // device should not render half a window if it ever arrives.
  it.each([
    ['no start', { planned_start_at: null, planned_end_at: END,  plan_published_at: START }],
    ['no end',   { planned_start_at: START, planned_end_at: null, plan_published_at: START }],
  ])('drops a half-plan (%s) rather than caching one end of it', (_label, row) => {
    expect(publishedPlan([row])).toEqual(NONE)
  })

  // PostgREST returns an embed as an array, or as a single object on a to-one
  // relation. Neither shape is assumed.
  it('accepts the embed as a bare object', () => {
    expect(publishedPlan({
      planned_start_at: START, planned_end_at: END, plan_published_at: START,
    })).toEqual({ planned_start_at: START, planned_end_at: END })
  })

  it.each([
    ['null',      null],
    ['undefined', undefined],
    ['empty array', []],
  ])('returns nothing for an absent embed (%s)', (_label, embedded) => {
    expect(publishedPlan(embedded)).toEqual(NONE)
  })
})
