import { describe, it, expect } from 'vitest'
import { resolveCapturedAt } from '@/lib/evidence/seal'

const SERVER = Date.parse('2026-10-14T12:00:00Z')

describe('resolveCapturedAt', () => {
  it('uses server time with source server when the device sent nothing', () => {
    expect(resolveCapturedAt(null, null, SERVER)).toEqual({
      capturedAt: '2026-10-14T12:00:00.000Z', source: 'server', offsetSeconds: null,
    })
  })

  it('corrects a slow device clock by the measured skew', () => {
    // device clock is 60s behind the server
    const r = resolveCapturedAt('2026-10-14T11:58:00Z', '2026-10-14T11:59:00Z', SERVER)
    expect(r.source).toBe('device')
    expect(r.offsetSeconds).toBe(60)
    expect(r.capturedAt).toBe('2026-10-14T11:59:00.000Z')
  })

  it('never reports a time in the future', () => {
    const r = resolveCapturedAt('2026-10-14T13:00:00Z', '2026-10-14T12:00:00Z', SERVER)
    expect(Date.parse(r.capturedAt)).toBeLessThanOrEqual(SERVER)
  })

  it('falls back to server provenance when the skew is implausible', () => {
    const r = resolveCapturedAt('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', SERVER)
    expect(r.source).toBe('server')
    expect(r.offsetSeconds).toBeNull()
  })
})
