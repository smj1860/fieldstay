import { vi } from 'vitest'

/**
 * Faithful stand-in for lib/rate-limit.ts's checkLimit() for tests that
 * vi.mock('@/lib/rate-limit') with hand-built limiter doubles.
 *
 * It DELEGATES to whatever `{ limit: vi.fn() }` double the test supplied, so
 * existing assertions like `expect(workOrderRatelimit.limit).toHaveBeenCalledWith(...)`
 * keep working unchanged, and it reproduces the real helper's onError policy
 * so "fails open when the limiter throws" tests still exercise a real branch.
 */
interface LimiterDouble {
  limit: (identifier: string) => Promise<{ success: boolean; limit?: number; remaining?: number; reset?: number }>
}

export function checkLimitStub() {
  return vi.fn(async (
    limiter:    LimiterDouble,
    identifier: string,
    options:    { onError: 'allow' | 'deny'; site: string },
  ) => {
    try {
      const r = await limiter.limit(identifier)
      return {
        allowed:   r.success,
        skipped:   false,
        errored:   false,
        limit:     r.limit     ?? 0,
        remaining: r.remaining ?? 0,
        reset:     r.reset     ?? Date.now() + 60_000,
      }
    } catch {
      return {
        allowed:   options.onError === 'allow',
        skipped:   false,
        errored:   true,
        limit:     0,
        remaining: 0,
        reset:     Date.now(),
      }
    }
  })
}

export function retryAfterSecondsStub(decision: { reset: number }): number {
  return Math.max(1, Math.ceil((decision.reset - Date.now()) / 1000))
}
