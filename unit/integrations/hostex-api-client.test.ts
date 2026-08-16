import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================================
// hostexFetch / pagination.
//
// Hostex's two structural traps, both of which fail SILENTLY if mishandled:
//
//   1. HTTP status is ALWAYS 200 — a bad token, a validation error and a
//      throttle all arrive as 200. Judging the outcome on res.ok returns an
//      undefined payload that reads downstream as "this account has no
//      properties", and the sync then reports success having imported nothing.
//
//   2. Throttling is IN-BAND: 200 + error_code 429 + Retry-After. A
//      res.status === 429 branch never fires, so the request looks successful.
//
// Plus the pagination invariant: terminate on a short page, never on `total`,
// and never return a partial set quietly.
// ============================================================================

vi.mock('@/lib/rate-limit', () => ({
  checkLimit:       vi.fn(),
  hostexApiLimiter: { limit: vi.fn() },
}))

import { hostexFetch, hostexFetchProperties, hostexReservationWindow } from '@/lib/integrations/providers/hostex-api'
import { RateLimitError } from '@/lib/integrations/types'
import { checkLimit } from '@/lib/rate-limit'

const USER = 'user_1'

function envelope(data: unknown, errorCode = 200, headers: Record<string, string> = {}) {
  return {
    ok:      true,
    status:  200,
    headers: { get: (k: string) => headers[k] ?? null },
    json:    async () => ({ request_id: 'r', error_code: errorCode, error_msg: 'msg', data }),
  } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(checkLimit).mockResolvedValue({ allowed: true, reset: Date.now() + 60_000 } as never)
})
afterEach(() => vi.unstubAllGlobals())

describe('hostexFetch', () => {
  it('unwraps data on the documented success code (200)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ properties: [], total: 0 })))
    await expect(hostexFetch('/properties', 'tok', USER)).resolves.toEqual({ properties: [], total: 0 })
  })

  it('also accepts error_code 0, since the two Hostex sources disagree', async () => {
    // Picking one and being wrong fails 100% of calls — see HOSTEX_SUCCESS_CODES.
    vi.stubGlobal('fetch', vi.fn(async () => envelope({ ok: true }, 0)))
    await expect(hostexFetch('/properties', 'tok', USER)).resolves.toEqual({ ok: true })
  })

  it('throws RateLimitError on an IN-BAND 429 carried by a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 429, { 'Retry-After': '17' })))
    await expect(hostexFetch('/properties', 'tok', USER)).rejects.toBeInstanceOf(RateLimitError)
    await expect(hostexFetch('/properties', 'tok', USER)).rejects.toMatchObject({ retryAfter: 17 })
  })

  it('throws on any other non-success error_code rather than returning undefined data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => envelope(null, 40_001)))
    await expect(hostexFetch('/properties', 'tok', USER)).rejects.toThrow(/error_code 40001/)
  })

  it('sends the Hostex-Access-Token header, not Authorization: Bearer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => envelope({}))
    vi.stubGlobal('fetch', fetchMock)
    await hostexFetch('/properties', 'tok_abc', USER)

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers['Hostex-Access-Token']).toBe('tok_abc')
    expect(headers['Authorization']).toBeUndefined()
  })

  it('refuses the call when the rate-limit budget is unavailable (fails closed)', async () => {
    vi.mocked(checkLimit).mockResolvedValue({ allowed: false, reset: Date.now() + 5_000 } as never)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(hostexFetch('/properties', 'tok', USER)).rejects.toBeInstanceOf(RateLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('pagination', () => {
  it('walks every page and stops on the first short one', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `p${i}` }))
    const page2 = [{ id: 100, title: 'p100' }]

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ properties: page1, total: 101 }))
      .mockResolvedValueOnce(envelope({ properties: page2, total: 101 }))
    vi.stubGlobal('fetch', fetchMock)

    const all = await hostexFetchProperties('tok', USER)
    expect(all).toHaveLength(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1]![0] as string)).toContain('offset=100')
  })

  it('does not trust `total` — a wrong count neither truncates nor loops', async () => {
    // total lies (says 1), but the first page is full, so the walk continues.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, title: `p${i}` }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(envelope({ properties: page1, total: 1 }))
      .mockResolvedValueOnce(envelope({ properties: [], total: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(hostexFetchProperties('tok', USER)).resolves.toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('hostexReservationWindow', () => {
  it('always produces explicit bounds spanning history and lookahead', () => {
    // Hostex defaults to "the next 180 days" with no bounds, so an
    // unparameterised call returns a forward slice and NO history — which on
    // an initial sync looks like a PM with no past bookings.
    const w = hostexReservationWindow(12, 6, new Date('2026-08-16T00:00:00Z'))
    expect(w.startCheckOutDate).toBe('2025-08-16')
    expect(w.endCheckOutDate).toBe('2027-02-16')
  })
})
