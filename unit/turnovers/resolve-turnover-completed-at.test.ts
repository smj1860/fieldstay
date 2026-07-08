import { describe, it, expect } from 'vitest'
import { resolveTurnoverCompletedAt } from '@/lib/turnovers/completion'

describe('resolveTurnoverCompletedAt', () => {
  it('returns the later of the two confirmation timestamps', () => {
    const earlier = '2026-08-01T10:00:00.000Z'
    const later    = '2026-08-01T10:05:00.000Z'

    expect(resolveTurnoverCompletedAt(earlier, later)).toBe(later)
    expect(resolveTurnoverCompletedAt(later, earlier)).toBe(later)
  })

  it('returns the shared timestamp when both confirmations landed at the same instant', () => {
    const at = '2026-08-01T10:00:00.000Z'
    expect(resolveTurnoverCompletedAt(at, at)).toBe(at)
  })

  it('falls back to the current time when either confirmation is missing', () => {
    const before = Date.now()
    const result  = resolveTurnoverCompletedAt(null, '2026-08-01T10:00:00.000Z')
    const after   = Date.now()

    const resultMs = new Date(result).getTime()
    expect(resultMs).toBeGreaterThanOrEqual(before)
    expect(resultMs).toBeLessThanOrEqual(after)
  })

  it('falls back to the current time when both confirmations are missing', () => {
    const before = Date.now()
    const result  = resolveTurnoverCompletedAt(null, null)
    const after   = Date.now()

    const resultMs = new Date(result).getTime()
    expect(resultMs).toBeGreaterThanOrEqual(before)
    expect(resultMs).toBeLessThanOrEqual(after)
  })
})
