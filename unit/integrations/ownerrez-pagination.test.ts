import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))

// The transport is the unit under test, so only its collaborators are mocked.
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken: vi.fn(async () => 'test-token'),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => { throw new Error('not expected in these tests') }),
}))
vi.mock('@/lib/supabase/unwrap', () => ({ unwrap: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
// upstashConfigured() === false short-circuits the shared IP budget check, so
// these tests exercise pagination without a Redis double.
vi.mock('@/lib/redis', () => ({
  getRedis:           vi.fn(),
  upstashConfigured:  vi.fn(() => false),
}))

import { OwnerRezApiClient } from '@/lib/integrations/providers/ownerrez-api'

// ============================================================================
// OwnerRez pagination — the layer that had NO test at all, which is how it
// shipped reading two fields that do not exist in OwnerRez's API.
//
// `OwnerRezPagedResponse` declared `total_count` and `next_page_token`. Neither
// string appears anywhere in https://api.ownerrez.com/openapi/v2.json (zero
// occurrences of each); the real wrapper is { items, limit, offset,
// next_page_url }. So `next_page_token` was undefined on every response, the
// do/while exited after one page, and no `limit` was sent — leaving OwnerRez's
// default of 20. It affected getBookings, getListings, getGuests and getReviews
// alike, and produced a 200 with a well-formed body and no truncation signal.
//
// Live confirmation before the fix: one production org's first OwnerRez sync
// created exactly 20 bookings inside a single minute — the only burst of that
// size anywhere in the table.
//
// Every existing OwnerRez test mocks the client CLASS (getBookings and friends)
// and so sits entirely above this code. These drive globalThis.fetch instead.
// ============================================================================

const BASE = 'https://api.ownerrez.com'

interface PageSpec {
  items:          unknown[]
  limit?:         number
  offset?:        number
  next_page_url?: string | null
}

/** Records every URL requested and replays `pages` in order. */
function mockPages(pages: PageSpec[]) {
  const urls: string[] = []
  const fetchMock = vi.fn(async (url: string) => {
    urls.push(url)
    const page = pages[urls.length - 1]
    if (!page) throw new Error(`unexpected extra request #${urls.length} to ${url}`)
    return {
      ok:      true,
      status:  200,
      headers: new Headers(),
      json:    async () => page,
      text:    async () => JSON.stringify(page),
    }
  })
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  return { urls, fetchMock }
}

const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i }))

let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
  process.env.OWNERREZ_CLIENT_ID = 'test-client-id'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('OwnerRez pagination', () => {
  it('follows next_page_url across pages and returns EVERY record', async () => {
    // The regression test. Against the old code this returns 100, not 250.
    const { urls } = mockPages([
      { items: rows(100, 0),   limit: 100, offset: 0,   next_page_url: `${BASE}/v2/bookings?limit=100&offset=100` },
      { items: rows(100, 100), limit: 100, offset: 100, next_page_url: `${BASE}/v2/bookings?limit=100&offset=200` },
      { items: rows(50,  200), limit: 100, offset: 200, next_page_url: null },
    ])

    const all = await new OwnerRezApiClient('user-1').getBookings({})

    expect(all).toHaveLength(250)
    expect(urls).toHaveLength(3)
    // Contiguous and in order — no page dropped, none replayed.
    expect((all as { id: number }[]).map((b) => b.id)).toEqual(rows(250).map((r) => r.id))
  })

  it('asks for the 100-record maximum instead of taking the default 20', async () => {
    const { urls } = mockPages([{ items: rows(3), limit: 100, offset: 0, next_page_url: null }])

    await new OwnerRezApiClient('user-1').getBookings({})

    expect(new URL(urls[0]).searchParams.get('limit')).toBe('100')
  })

  it('preserves caller params on the first page', async () => {
    const { urls } = mockPages([{ items: [], next_page_url: null }])

    await new OwnerRezApiClient('user-1').getBookings({
      propertyIds:  [7, 9],
      sinceUtc:     '2026-01-01T00:00:00Z',
      includeGuest: true,
    })

    const q = new URL(urls[0]).searchParams
    expect(q.get('property_ids')).toBe('7,9')
    expect(q.get('since_utc')).toBe('2026-01-01T00:00:00Z')
    expect(q.get('include_guest')).toBe('true')
  })

  it('stops at a null next_page_url even when the page is full', async () => {
    // next_page_url is authoritative when present: a full final page is still
    // final if the server says so.
    const { urls } = mockPages([{ items: rows(100), limit: 100, offset: 0, next_page_url: null }])

    const all = await new OwnerRezApiClient('user-1').getReviews()

    expect(all).toHaveLength(100)
    expect(urls).toHaveLength(1)
  })

  it('stops on an empty page without looping', async () => {
    const { urls } = mockPages([{ items: [], limit: 100, offset: 0 }])

    await expect(new OwnerRezApiClient('user-1').getGuests()).resolves.toEqual([])
    expect(urls).toHaveLength(1)
  })

  describe('offset fallback when next_page_url is absent', () => {
    it('keeps paging while pages come back full', async () => {
      const { urls } = mockPages([
        { items: rows(100, 0),   limit: 100, offset: 0 },
        { items: rows(40,  100), limit: 100, offset: 100 },
      ])

      const all = await new OwnerRezApiClient('user-1').getListings()

      expect(all).toHaveLength(140)
      expect(new URL(urls[1]).searchParams.get('offset')).toBe('100')
    })

    it('trusts the server-reported limit over the one we requested', async () => {
      // If OwnerRez quietly caps us at 20 while we ask for 100, a short-page
      // test against OUR requested size stops after one page — the original
      // bug wearing a different hat. page.limit is what settles it.
      const { urls } = mockPages([
        { items: rows(20, 0),  limit: 20, offset: 0 },
        { items: rows(20, 20), limit: 20, offset: 20 },
        { items: rows(5,  40), limit: 20, offset: 40 },
      ])

      const all = await new OwnerRezApiClient('user-1').getBookings({})

      expect(all).toHaveLength(45)
      expect(urls).toHaveLength(3)
    })

    it('stops on a short page', async () => {
      const { urls } = mockPages([{ items: rows(99), limit: 100, offset: 0 }])

      await expect(new OwnerRezApiClient('user-1').getBookings({})).resolves.toHaveLength(99)
      expect(urls).toHaveLength(1)
    })
  })

  describe('next_page_url is response-supplied, so its origin is checked', () => {
    it('refuses to follow an off-host URL and never sends the token there', async () => {
      const { urls } = mockPages([
        { items: rows(1), limit: 100, offset: 0, next_page_url: 'https://evil.example.com/v2/bookings?limit=100' },
      ])

      await expect(new OwnerRezApiClient('user-1').getBookings({}))
        .rejects.toThrow(/off-host/)

      // The point of the guard: the bearer token was never sent to that host.
      expect(urls).toHaveLength(1)
      expect(urls.every((u) => u.startsWith(BASE))).toBe(true)
    })

    it('accepts a relative next_page_url, resolved against the API base', async () => {
      const { urls } = mockPages([
        { items: rows(1), limit: 100, offset: 0, next_page_url: '/v2/bookings?limit=100&offset=100' },
        { items: [],      limit: 100, offset: 100, next_page_url: null },
      ])

      await new OwnerRezApiClient('user-1').getBookings({})

      expect(urls[1]).toBe(`${BASE}/v2/bookings?limit=100&offset=100`)
    })

    it('rejects an unparseable next_page_url rather than fetching it', async () => {
      mockPages([
        { items: rows(1), limit: 100, offset: 0, next_page_url: 'http://[oops' },
      ])

      await expect(new OwnerRezApiClient('user-1').getBookings({}))
        .rejects.toThrow(/next_page_url/)
    })
  })

  it('THROWS past the page ceiling instead of returning a partial list', async () => {
    // A server that never terminates. Returning results.length here would hand
    // callers a short list they would treat as complete — and OwnerRez callers
    // reconcile deletions against exactly that list.
    let n = 0
    globalThis.fetch = vi.fn(async () => {
      n++
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({
          items: rows(100), limit: 100, offset: n * 100,
          next_page_url: `${BASE}/v2/bookings?limit=100&offset=${n * 100}`,
        }),
        text: async () => '',
      }
    }) as unknown as typeof globalThis.fetch

    await expect(new OwnerRezApiClient('user-1').getBookings({}))
      .rejects.toThrow(/refusing to return a partial result/)
  })
})
