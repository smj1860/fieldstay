import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  cn,
  formatDate,
  formatDateTime,
  fromNow,
  windowMinutes,
  formatWindow,
  slugify,
  formatDuration,
  PRIORITY_COLORS,
  TURNOVER_STATUS_LABELS,
  WO_STATUS_LABELS,
  INVENTORY_CATEGORY_LABELS,
} from '@/lib/utils'

// Fixed noon-UTC timestamps avoid day-boundary flakiness if the test
// runner's local timezone differs from UTC.
const NOON_JULY = '2026-07-06T12:00:00.000Z'
const NOON_JAN = '2026-01-15T12:00:00.000Z'

describe('cn', () => {
  it('merges plain class strings', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('resolves conflicting Tailwind utilities, keeping the last one', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, 0, 'b')).toBe('a b')
  })

  it('supports conditional object syntax', () => {
    expect(cn('base', { active: true, hidden: false })).toBe('base active')
  })
})

describe('formatDate', () => {
  it('formats a date with the default pattern', () => {
    expect(formatDate(NOON_JULY)).toBe('Jul 6, 2026')
  })

  it('accepts a Date object', () => {
    expect(formatDate(new Date(NOON_JULY))).toBe('Jul 6, 2026')
  })

  it('accepts a custom format pattern', () => {
    expect(formatDate(NOON_JULY, 'yyyy-MM-dd')).toBe('2026-07-06')
  })
})

describe('formatDateTime', () => {
  it('formats date and time together', () => {
    expect(formatDateTime(NOON_JAN)).toBe('Jan 15, 2026 12:00 PM')
  })
})

describe('fromNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a relative time in the past with a suffix', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-06T15:00:00.000Z'))
    expect(fromNow('2026-07-06T12:00:00.000Z')).toBe('about 3 hours ago')
  })

  it('reports a relative time in the future with a suffix', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-06T12:00:00.000Z'))
    expect(fromNow('2026-07-06T15:00:00.000Z')).toBe('in about 3 hours')
  })
})

describe('windowMinutes', () => {
  it('returns the number of minutes between two datetimes', () => {
    expect(windowMinutes('2026-07-06T11:00:00.000Z', '2026-07-06T15:00:00.000Z')).toBe(240)
  })

  it('returns a negative number when end precedes start', () => {
    expect(windowMinutes('2026-07-06T15:00:00.000Z', '2026-07-06T11:00:00.000Z')).toBe(-240)
  })

  it('returns 0 for identical timestamps', () => {
    expect(windowMinutes('2026-07-06T11:00:00.000Z', '2026-07-06T11:00:00.000Z')).toBe(0)
  })
})

describe('formatWindow', () => {
  it('formats sub-hour durations as minutes only', () => {
    expect(formatWindow(0)).toBe('0m')
    expect(formatWindow(45)).toBe('45m')
    expect(formatWindow(59)).toBe('59m')
  })

  it('formats exact hours without a minutes suffix', () => {
    expect(formatWindow(60)).toBe('1h')
    expect(formatWindow(120)).toBe('2h')
  })

  it('formats hours and minutes together', () => {
    expect(formatWindow(90)).toBe('1h 30m')
    expect(formatWindow(245)).toBe('4h 5m')
  })
})

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('collapses runs of whitespace, underscores, and hyphens into one hyphen', () => {
    expect(slugify('Hello   World_-_Again')).toBe('hello-world-again')
  })

  it('strips non-word, non-space, non-hyphen characters', () => {
    expect(slugify("Bob's Beach House!")).toBe('bobs-beach-house')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  -Leading and Trailing-  ')).toBe('leading-and-trailing')
  })

  it('handles an already-clean slug unchanged', () => {
    expect(slugify('already-a-slug')).toBe('already-a-slug')
  })
})

describe('formatDuration', () => {
  it('returns null when startedAt is missing', () => {
    expect(formatDuration(null, '2026-07-06T12:00:00.000Z')).toBeNull()
  })

  it('returns null when completedAt is missing', () => {
    expect(formatDuration('2026-07-06T12:00:00.000Z', null)).toBeNull()
  })

  it('returns null when both are missing', () => {
    expect(formatDuration(null, null)).toBeNull()
  })

  it('formats sub-minute durations as "< 1m"', () => {
    expect(formatDuration('2026-07-06T12:00:00.000Z', '2026-07-06T12:00:10.000Z')).toBe('< 1m')
  })

  it('formats sub-hour durations as minutes', () => {
    expect(formatDuration('2026-07-06T12:00:00.000Z', '2026-07-06T12:45:00.000Z')).toBe('45m')
  })

  it('formats exact-hour durations without a minutes suffix', () => {
    expect(formatDuration('2026-07-06T12:00:00.000Z', '2026-07-06T14:00:00.000Z')).toBe('2h')
  })

  it('formats hour-and-minute durations', () => {
    expect(formatDuration('2026-07-06T12:00:00.000Z', '2026-07-06T13:35:00.000Z')).toBe('1h 35m')
  })
})

describe('display label / color maps', () => {
  it('PRIORITY_COLORS covers every priority level', () => {
    expect(Object.keys(PRIORITY_COLORS).sort()).toEqual(['high', 'low', 'medium', 'urgent'])
  })

  it('TURNOVER_STATUS_LABELS covers every turnover status', () => {
    expect(Object.keys(TURNOVER_STATUS_LABELS).sort()).toEqual(
      ['assigned', 'cancelled', 'completed', 'flagged', 'in_progress', 'pending_assignment'].sort(),
    )
  })

  it('WO_STATUS_LABELS covers every work order status', () => {
    expect(Object.keys(WO_STATUS_LABELS).sort()).toEqual(
      ['assigned', 'cancelled', 'completed', 'in_progress', 'pending', 'quote_requested'].sort(),
    )
  })

  it('INVENTORY_CATEGORY_LABELS covers every inventory category used by this map', () => {
    expect(INVENTORY_CATEGORY_LABELS.paper_goods).toBe('Paper Goods')
    expect(INVENTORY_CATEGORY_LABELS.bedroom_linens).toBe('Bedroom & Linens')
    expect(INVENTORY_CATEGORY_LABELS.other).toBe('Other')
  })
})
