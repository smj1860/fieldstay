import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // The outbound quota fails CLOSED, so an unconfigured limiter would reject
  // every call before it reached the fetch these tests are about.
  checkLimit: vi.fn(async () => ({ allowed: true, skipped: true, errored: false })),
}))

import { hospFetchCalendar } from '@/lib/integrations/providers/hospitable'
import { ProviderEntityGoneError } from '@/lib/integrations/types'

// ============================================================================
// THE LINK BETWEEN THE FETCHER AND THE HANDLER.
//
// unit/inngest/hospitable-calendar-sync-handler.test.ts proves the handler
// pauses a property when it catches ProviderEntityGoneError. That proof is
// worth nothing unless the fetcher actually THROWS one — and when the typed
// branch was deliberately disabled, every handler test still passed. Both
// halves were green and the chain was broken in the middle.
//
// So this tests the other half: which status codes produce the terminal type,
// and — just as important — which ones must not, because a 500 that paused a
// property would be far worse than the daily 404 this all started from.
// ============================================================================

function mockResponse(status: number, body = '') {
  return {
    ok:      status >= 200 && status < 300,
    status,
    text:    async () => body,
    json:    async () => ({ data: { days: [] } }),
    headers: { get: () => null },
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('hospFetchCalendar on a listing Hospitable does not have', () => {
  it('throws the TERMINAL type on 404, carrying the id that was not found', async () => {
    fetchMock.mockResolvedValue(mockResponse(404, '{"status_code":404,"reason_phrase":"No result found."}'))

    const err = await hospFetchCalendar('tok', 'hosp_1', '2026-08-01', '2026-11-01')
      .then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(ProviderEntityGoneError)
    expect((err as ProviderEntityGoneError).entityId).toBe('hosp_1')
    // The reason the type exists: a plain Error cannot tell the caller that
    // retrying asks for the same missing thing.
    expect((err as Error).message).toContain('no longer recognises')
  })

  it('does NOT throw it on 500 — a transient failure keeps its retries', async () => {
    fetchMock.mockResolvedValue(mockResponse(500, 'upstream exploded'))

    const err = await hospFetchCalendar('tok', 'hosp_1', '2026-08-01', '2026-11-01')
      .then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ProviderEntityGoneError)
    expect((err as Error).message).toContain('500')
  })

  it('does NOT throw it on 403 — a missing scope is not a missing property', async () => {
    // Pausing the property here would tell the PM their listing had vanished
    // when the real answer is that the connection needs reconnecting.
    fetchMock.mockResolvedValue(mockResponse(403, 'forbidden'))

    const err = await hospFetchCalendar('tok', 'hosp_1', '2026-08-01', '2026-11-01')
      .then(() => null, (e: unknown) => e)

    expect(err).not.toBeInstanceOf(ProviderEntityGoneError)
  })

  it('returns days normally on success', async () => {
    fetchMock.mockResolvedValue(mockResponse(200))
    await expect(hospFetchCalendar('tok', 'hosp_1', '2026-08-01', '2026-11-01')).resolves.toEqual([])
  })
})
