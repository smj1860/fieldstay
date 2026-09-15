import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

const { headersMock, checkLimitMock, extractClientIpMock } = vi.hoisted(() => ({
  headersMock:        vi.fn(),
  checkLimitMock:      vi.fn(),
  extractClientIpMock: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: headersMock }))
vi.mock('@/lib/rate-limit', () => ({ inviteAcceptRatelimit: {}, checkLimit: checkLimitMock }))
vi.mock('@/lib/integrations/webhook-verification', () => ({ extractClientIp: extractClientIpMock }))

import { inviteViewThrottled } from '@/lib/auth/invite-view-throttle'

// ============================================================================
// This module's whole point is anti-enumeration on invite-token GUESSING.
// Before this fix, a request with no resolvable IP header (no forwarded-for/
// real-ip present at all — plausible for ordinary traffic, not just an
// attacker) fell back to the single shared key 'invite-view:unknown'. That is
// a shared-fate bucket: one client hammering the page with no IP headers
// could exhaust the WHOLE budget for every other client in that same
// position, defeating the per-client anti-enumeration property for that
// entire class of traffic.
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks()
  headersMock.mockResolvedValue(new Headers())
})

describe('inviteViewThrottled', () => {
  it('throttles immediately when no client IP can be resolved, rather than sharing a bucket', async () => {
    extractClientIpMock.mockReturnValue(null)

    const throttled = await inviteViewThrottled('test.site')

    expect(throttled).toBe(true)
    // Never even asks the limiter — there is no per-client key to check.
    expect(checkLimitMock).not.toHaveBeenCalled()
  })

  it('checks the limiter under a key scoped to the resolved IP when one is present', async () => {
    extractClientIpMock.mockReturnValue('203.0.113.7')
    checkLimitMock.mockResolvedValue({ allowed: true })

    const throttled = await inviteViewThrottled('test.site')

    expect(throttled).toBe(false)
    expect(checkLimitMock).toHaveBeenCalledWith(
      {},
      'invite-view:203.0.113.7',
      expect.objectContaining({ onError: 'allow', site: 'test.site' }),
    )
  })

  it('reports throttled when the limiter denies the resolved IP', async () => {
    extractClientIpMock.mockReturnValue('203.0.113.7')
    checkLimitMock.mockResolvedValue({ allowed: false })

    expect(await inviteViewThrottled('test.site')).toBe(true)
  })
})
