import { describe, it, expect, vi, beforeEach } from 'vitest'

const maybeSingle = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}))

import { isDemoOrg, __clearDemoOrgCache, DEMO_ORG_CACHE_MAX_ENTRIES } from '@/lib/demo/org'

// ============================================================================
// The Map had no eviction path. An entry was overwritten when its TTL lapsed
// AND a caller asked for that org again, but never removed — so on a
// long-lived server the resident set is every org ever seen, not every org
// seen in the last minute. Not a per-request leak, which is why nothing would
// ever surface it; it just grows with lifetime tenant count.
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks()
  __clearDemoOrgCache()
  maybeSingle.mockResolvedValue({ data: { is_demo: false }, error: null })
})

describe('isDemoOrg cache', () => {
  it('serves a repeat lookup from memory — the N+1 this cache exists to stop', async () => {
    await isDemoOrg('org_1')
    await isDemoOrg('org_1')
    expect(maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('holds at most MAX_ENTRIES orgs no matter how many are seen', async () => {
    for (let i = 0; i < DEMO_ORG_CACHE_MAX_ENTRIES + 250; i++) await isDemoOrg(`org_${i}`)
    expect(maybeSingle).toHaveBeenCalledTimes(DEMO_ORG_CACHE_MAX_ENTRIES + 250)

    // The earliest orgs were evicted, so re-asking re-queries...
    maybeSingle.mockClear()
    await isDemoOrg('org_0')
    expect(maybeSingle).toHaveBeenCalledTimes(1)

    // ...while the most recent are still resident.
    maybeSingle.mockClear()
    await isDemoOrg(`org_${DEMO_ORG_CACHE_MAX_ENTRIES + 249}`)
    expect(maybeSingle).not.toHaveBeenCalled()
  })

  it('a repeatedly-read org survives eviction — reads are an LRU touch, not just writes', async () => {
    // Without the touch, a hot org inserted early is evicted by cold traffic
    // it is more valuable than, and the cache stops paying for itself exactly
    // on the tenant it was protecting.
    await isDemoOrg('hot')
    for (let i = 0; i < DEMO_ORG_CACHE_MAX_ENTRIES - 1; i++) {
      await isDemoOrg(`cold_${i}`)
      await isDemoOrg('hot')
    }
    maybeSingle.mockClear()
    await isDemoOrg('hot')
    expect(maybeSingle).not.toHaveBeenCalled()
  })

  it('still reuses the last known value when the lookup errors', async () => {
    await isDemoOrg('org_1')
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'down' } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Cached value is fresh, so this does not even reach the error path.
    expect(await isDemoOrg('org_1')).toBe(false)
  })
})
