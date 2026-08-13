import { describe, it, expect } from 'vitest'

import {
  planBackfillWindow,
  advanceBackfill,
  initialHistoryFrom,
  readBackfillState,
  isoDate,
  INITIAL_HISTORY_DAYS,
  BACKFILL_WINDOW_DAYS,
  BACKFILL_HORIZON_DAYS,
  type OwnerRezBackfillState,
} from '@/lib/integrations/providers/ownerrez-backfill'

// ============================================================================
// The backfill walk. Pure, so the whole thing is driven by a fixed clock.
//
// The property that matters most is COVERAGE: consecutive windows must leave no
// gap in stay dates, because a gap is a permanently missing slice of history —
// nothing ever revisits it. The walk is allowed to overlap (from/to is an
// interval-overlap filter and bookings upsert by id), so every assertion below
// checks for gaps, never for exact abutment.
// ============================================================================

const NOW = new Date('2026-08-13T12:00:00.000Z')
const fresh: OwnerRezBackfillState = { oldestCovered: null, complete: false }

/** Runs the walk to completion and returns every window, in order. */
function walkToCompletion(now = NOW, maxIterations = 100) {
  let state = fresh
  const windows = []
  for (let i = 0; i < maxIterations; i++) {
    const w = planBackfillWindow(state, now)
    if (!w) break
    windows.push(w)
    state = advanceBackfill(w, now)
  }
  return { windows, state }
}

describe('initialHistoryFrom', () => {
  it('is INITIAL_HISTORY_DAYS before now', () => {
    expect(initialHistoryFrom(NOW)).toBe('2026-05-15')
    expect(initialHistoryFrom(NOW)).toBe(
      isoDate(new Date(NOW.getTime() - INITIAL_HISTORY_DAYS * 86_400_000)),
    )
  })
})

describe('planBackfillWindow', () => {
  it('starts where the initial sync stopped, so no history is skipped', () => {
    // The seam that would otherwise silently lose 90 days: the first backfill
    // window's upper bound must be the initial sync's lower bound.
    expect(planBackfillWindow(fresh, NOW)?.to).toBe(initialHistoryFrom(NOW))
  })

  it('claims one BACKFILL_WINDOW_DAYS window per call', () => {
    const w = planBackfillWindow(fresh, NOW)!
    const span = (Date.parse(`${w.to}T00:00:00Z`) - Date.parse(`${w.from}T00:00:00Z`)) / 86_400_000
    expect(span).toBe(BACKFILL_WINDOW_DAYS)
  })

  it('resumes from oldestCovered on the next run', () => {
    const first  = planBackfillWindow(fresh, NOW)!
    const second = planBackfillWindow(advanceBackfill(first, NOW), NOW)!
    expect(second.to).toBe(first.from)
  })

  it('returns null once complete, and never restarts on its own', () => {
    expect(planBackfillWindow({ oldestCovered: '2025-01-01', complete: true }, NOW)).toBeNull()
  })

  it('returns null when oldestCovered is already at the horizon', () => {
    const horizon = isoDate(new Date(NOW.getTime() - BACKFILL_HORIZON_DAYS * 86_400_000))
    expect(planBackfillWindow({ oldestCovered: horizon, complete: false }, NOW)).toBeNull()
  })

  it('clamps the final window to the horizon instead of overshooting', () => {
    // Two days short of the horizon: the last window must be 2 days, not 90.
    const nearly = isoDate(new Date(NOW.getTime() - (BACKFILL_HORIZON_DAYS - 2) * 86_400_000))
    const w = planBackfillWindow({ oldestCovered: nearly, complete: false }, NOW)!
    expect(w.from).toBe(isoDate(new Date(NOW.getTime() - BACKFILL_HORIZON_DAYS * 86_400_000)))
    expect(w.to).toBe(nearly)
  })
})

describe('the full walk', () => {
  it('terminates', () => {
    const { windows, state } = walkToCompletion()
    expect(state.complete).toBe(true)
    // (730 - 90) / 90 = 7.1 -> 8 windows, the last one clamped.
    expect(windows).toHaveLength(8)
  })

  it('leaves NO GAP in stay-date coverage', () => {
    // The defect this guards: any gap is history that nothing ever revisits.
    const { windows } = walkToCompletion()
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].to).toBe(windows[i - 1].from)
    }
  })

  it('reaches exactly the horizon and no further', () => {
    const { windows } = walkToCompletion()
    const horizon = isoDate(new Date(NOW.getTime() - BACKFILL_HORIZON_DAYS * 86_400_000))
    expect(windows[windows.length - 1].from).toBe(horizon)
  })

  it('covers the whole span from the horizon up to the initial window', () => {
    const { windows } = walkToCompletion()
    expect(windows[0].to).toBe(initialHistoryFrom(NOW))
    expect(windows[windows.length - 1].from)
      .toBe(isoDate(new Date(NOW.getTime() - BACKFILL_HORIZON_DAYS * 86_400_000)))
  })

  it('every window is non-empty and ordered', () => {
    const { windows } = walkToCompletion()
    for (const w of windows) expect(w.from < w.to).toBe(true)
  })

  it('is idempotent under a replayed run — re-planning without advancing repeats the same window', () => {
    // Inngest retries a step; planning must not consume a window as a side effect.
    const a = planBackfillWindow(fresh, NOW)
    const b = planBackfillWindow(fresh, NOW)
    expect(a).toEqual(b)
  })
})

describe('advanceBackfill', () => {
  it('records the window it just covered', () => {
    const w = planBackfillWindow(fresh, NOW)!
    expect(advanceBackfill(w, NOW).oldestCovered).toBe(w.from)
  })

  it('does not mark complete mid-walk', () => {
    const w = planBackfillWindow(fresh, NOW)!
    expect(advanceBackfill(w, NOW).complete).toBe(false)
  })

  it('marks complete when the window reached the horizon', () => {
    const horizon = isoDate(new Date(NOW.getTime() - BACKFILL_HORIZON_DAYS * 86_400_000))
    expect(advanceBackfill({ from: horizon, to: '2025-01-01' }, NOW).complete).toBe(true)
  })
})

describe('readBackfillState', () => {
  it('reads a well-formed metadata blob', () => {
    expect(readBackfillState({ backfill_oldest_covered: '2026-01-01', backfill_complete: true }))
      .toEqual({ oldestCovered: '2026-01-01', complete: true })
  })

  it('treats an older connection with no backfill keys as a fresh walk', () => {
    expect(readBackfillState({ sync_cursor: 'x' })).toEqual({ oldestCovered: null, complete: false })
  })

  it.each([
    ['null',      null],
    ['undefined', undefined],
    ['an array',  ['nope']],
    ['a string',  'nope'],
    ['a number',  42],
  ])('survives metadata that is %s', (_label, value) => {
    expect(readBackfillState(value)).toEqual({ oldestCovered: null, complete: false })
  })

  it.each([
    ['an empty string', ''],
    ['a number',        20260101],
    ['null',            null],
  ])('ignores a non-string oldest cursor (%s) rather than trusting it', (_label, value) => {
    expect(readBackfillState({ backfill_oldest_covered: value }).oldestCovered).toBeNull()
  })

  it('only accepts a literal true for complete', () => {
    // A truthy-but-not-true value must not silently end the walk.
    expect(readBackfillState({ backfill_complete: 'yes' }).complete).toBe(false)
    expect(readBackfillState({ backfill_complete: 1 }).complete).toBe(false)
  })
})
