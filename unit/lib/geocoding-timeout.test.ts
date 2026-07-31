import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { geocodeZip } from '@/lib/geocoding'
import { reportError } from '@/lib/observability/report-error'

// geocodeZip() runs INSIDE createProperty/updateProperty (and the crew/vendor
// settings actions). Before the 2026-07-30 audit it had no timeout and no
// try/catch, so a hung or erroring Mapbox held a user's save open until the
// Vercel function timeout — or failed the save outright. Its contract is now
// explicit: bounded, and null on every failure.
describe('geocodeZip — bounded and non-fatal', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.MAPBOX_PUBLIC_TOKEN = 'test-token'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('passes an AbortSignal timeout to fetch', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ features: [{ center: [-85.9, 32.6] }] }), { status: 200 })
    )

    const coords = await geocodeZip('36853')

    expect(coords).toEqual({ lat: 32.6, lng: -85.9 })
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('returns null (never throws) when the request times out, and says so distinctly', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    })
    vi.spyOn(global, 'fetch').mockRejectedValue(timeout)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(geocodeZip('36853')).resolves.toBeNull()

    expect(warnSpy).toHaveBeenCalledWith(
      '[geocodeZip] Mapbox request timed out',
      expect.objectContaining({ zip: '36853' }),
    )
    expect(reportError).toHaveBeenCalledWith(
      timeout,
      expect.objectContaining({ extra: { timedOut: true } }),
    )
  })

  it('returns null (never throws) on a network error, reported as a failure not a timeout', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(geocodeZip('36853')).resolves.toBeNull()

    expect(errorSpy).toHaveBeenCalledWith(
      '[geocodeZip] Mapbox request failed',
      expect.objectContaining({ zip: '36853', error: 'ECONNRESET' }),
    )
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: { timedOut: false } }),
    )
  })

  it('returns null on a non-OK response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(geocodeZip('36853')).resolves.toBeNull()
  })
})
