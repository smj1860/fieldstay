// Crew Sync v2 Phase 3 (docs/CREW_SYNC_V2_PHASES.md section 3c):
// reconnect jitter bounds — the rejoin delay is always within
// [base, base + 30 s] so a Realtime node restart never stampedes every
// crew device back at the same instant.

import { describe, it, expect } from 'vitest'
import {
  computeReconnectDelayMs,
  reconnectDelayWithJitterMs,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_JITTER_MAX_MS,
} from '@/lib/dexie/sync/signals'

describe('computeReconnectDelayMs', () => {
  it('maps random=0 to exactly the base delay (5 s)', () => {
    expect(computeReconnectDelayMs(0)).toBe(RECONNECT_BASE_DELAY_MS)
    expect(RECONNECT_BASE_DELAY_MS).toBe(5_000)
  })

  it('maps random=1 to base + full jitter (35 s)', () => {
    expect(computeReconnectDelayMs(1)).toBe(RECONNECT_BASE_DELAY_MS + RECONNECT_JITTER_MAX_MS)
    expect(RECONNECT_JITTER_MAX_MS).toBe(30_000)
  })

  it('is linear in between (uniform jitter, not skewed)', () => {
    expect(computeReconnectDelayMs(0.5)).toBe(RECONNECT_BASE_DELAY_MS + RECONNECT_JITTER_MAX_MS / 2)
    expect(computeReconnectDelayMs(0.1)).toBeCloseTo(RECONNECT_BASE_DELAY_MS + RECONNECT_JITTER_MAX_MS * 0.1)
  })

  it('clamps out-of-range random inputs instead of over/undershooting', () => {
    expect(computeReconnectDelayMs(-0.5)).toBe(RECONNECT_BASE_DELAY_MS)
    expect(computeReconnectDelayMs(1.5)).toBe(RECONNECT_BASE_DELAY_MS + RECONNECT_JITTER_MAX_MS)
  })
})

describe('reconnectDelayWithJitterMs', () => {
  it('always lands within [5 s, 35 s]', () => {
    for (let i = 0; i < 1_000; i++) {
      const delay = reconnectDelayWithJitterMs()
      expect(delay).toBeGreaterThanOrEqual(RECONNECT_BASE_DELAY_MS)
      expect(delay).toBeLessThanOrEqual(RECONNECT_BASE_DELAY_MS + RECONNECT_JITTER_MAX_MS)
    }
  })

  it('actually varies (it is jitter, not a constant)', () => {
    const samples = new Set<number>()
    for (let i = 0; i < 100; i++) samples.add(reconnectDelayWithJitterMs())
    expect(samples.size).toBeGreaterThan(1)
  })
})
