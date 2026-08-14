import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeDexieDb, type FakeDexieDb } from './fake-dexie'

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/dexie/schema', () => ({
  getDexieDb: () => holder.db,
  isDexieShutdown: () => false,
}))

import { warmCrewRouteCache, WARM_ROUTE_LIMIT } from '@/lib/dexie/sync/warm-routes'

// ============================================================================
// Pre-caching the crew app's page documents.
//
// sw.js caches a page only once that exact URL has been navigated to. So
// /crew/turnovers/<uuid> is first requested at the moment the crew member taps
// it — standing at the property, which is precisely where there is no signal.
// All the DATA is already in IndexedDB; the missing piece is the HTML shell for
// a route that renders entirely from it.
//
// This warms those documents after every successful sync, while the network is
// known to be up and the assignment scope is known.
// ============================================================================

function db(): FakeDexieDb { return holder.db as FakeDexieDb }

interface CachePut { url: string }

function installCacheApi() {
  const puts: CachePut[] = []
  const cache = { put: vi.fn(async (url: string) => { puts.push({ url }) }) }
  ;(globalThis as unknown as { caches: unknown }).caches = { open: vi.fn(async () => cache) }
  return puts
}

function mockFetch(impl?: (url: string) => { ok?: boolean; redirected?: boolean }) {
  globalThis.fetch = vi.fn(async (url: string) => {
    const o = impl?.(url) ?? {}
    return {
      ok:         o.ok ?? true,
      redirected: o.redirected ?? false,
      clone:      () => ({ body: url }),
    }
  }) as unknown as typeof globalThis.fetch
}

const turnover = (id: string, checkoutIso: string, status = 'assigned') => ({
  id, property_id: 'p1', org_id: 'o1', status,
  checkout_datetime: checkoutIso, checkin_datetime: checkoutIso,
  window_minutes: 240, priority: 'medium', notes: '',
})

const originalFetch = globalThis.fetch

beforeEach(() => {
  holder.db = makeFakeDexieDb()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'))
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  globalThis.fetch = originalFetch
  delete (globalThis as unknown as { caches?: unknown }).caches
})

describe('warmCrewRouteCache', () => {
  it('caches the page for an assigned turnover the crew member has never opened', async () => {
    // The whole point: this URL has never been visited, so sw.js would not
    // have it, so the tap at the property would fail.
    const puts = installCacheApi()
    mockFetch()
    await db().turnovers.bulkPut([turnover('t-abc', '2026-08-20T15:00:00+00:00')])

    await warmCrewRouteCache('u1')

    expect(puts.map((p) => p.url)).toContain('/crew/turnovers/t-abc')
  })

  it('always warms the start_url', async () => {
    const puts = installCacheApi()
    mockFetch()
    await warmCrewRouteCache('u1')
    expect(puts.map((p) => p.url)).toContain('/crew')
  })

  it('warms work order pages too', async () => {
    const puts = installCacheApi()
    mockFetch()
    await db().crew_work_orders.bulkPut([{ id: 'wo-1', property_id: 'p1', status: 'assigned' }])

    await warmCrewRouteCache('u1')

    expect(puts.map((p) => p.url)).toContain('/crew/work-orders/wo-1')
  })

  it('NEVER caches a redirect — a cached /login is a trap at a property with no signal', async () => {
    const puts = installCacheApi()
    mockFetch((url) => (url.includes('turnovers') ? { redirected: true } : {}))
    await db().turnovers.bulkPut([turnover('t-abc', '2026-08-20T15:00:00+00:00')])

    await warmCrewRouteCache('u1')

    expect(puts.map((p) => p.url)).not.toContain('/crew/turnovers/t-abc')
  })

  it('never caches a non-2xx either', async () => {
    const puts = installCacheApi()
    mockFetch((url) => (url.includes('turnovers') ? { ok: false } : {}))
    await db().turnovers.bulkPut([turnover('t-abc', '2026-08-20T15:00:00+00:00')])

    await warmCrewRouteCache('u1')

    expect(puts.map((p) => p.url)).not.toContain('/crew/turnovers/t-abc')
  })

  it('skips completed and cancelled turnovers', async () => {
    const puts = installCacheApi()
    mockFetch()
    await db().turnovers.bulkPut([
      turnover('t-done', '2026-08-20T15:00:00+00:00', 'completed'),
      turnover('t-cxl',  '2026-08-20T15:00:00+00:00', 'cancelled'),
    ])

    await warmCrewRouteCache('u1')

    const urls = puts.map((p) => p.url)
    expect(urls).not.toContain('/crew/turnovers/t-done')
    expect(urls).not.toContain('/crew/turnovers/t-cxl')
  })

  it('is bounded — a long assignment history is not a request storm on every sync', async () => {
    const puts = installCacheApi()
    mockFetch()
    await db().turnovers.bulkPut(
      Array.from({ length: 60 }, (_, i) => turnover(`t${i}`, '2026-08-16T15:00:00+00:00')),
    )

    await warmCrewRouteCache('u1')

    expect(puts.length).toBeLessThanOrEqual(WARM_ROUTE_LIMIT)
  })

  it('does nothing offline rather than burning retries', async () => {
    const puts = installCacheApi()
    mockFetch()
    vi.stubGlobal('navigator', { onLine: false })

    expect(await warmCrewRouteCache('u1')).toBe(0)
    expect(puts).toHaveLength(0)
  })

  it('is inert where the Cache API does not exist, so it cannot break a sync', async () => {
    // Node/SSR. fullCrewResync awaits this on every pass.
    mockFetch()
    await expect(warmCrewRouteCache('u1')).resolves.toBe(0)
  })

  it('one route failing does not abandon the rest', async () => {
    const puts = installCacheApi()
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/crew') throw new Error('boom')
      return { ok: true, redirected: false, clone: () => ({ body: url }) }
    }) as unknown as typeof globalThis.fetch
    await db().turnovers.bulkPut([turnover('t-abc', '2026-08-20T15:00:00+00:00')])

    await warmCrewRouteCache('u1')

    expect(puts.map((p) => p.url)).toContain('/crew/turnovers/t-abc')
  })
})
