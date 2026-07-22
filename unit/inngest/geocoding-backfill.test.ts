import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { geocodingBackfill } from '@/lib/inngest/functions/geocoding-backfill'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — see checklist-broadcast.test.ts for the
// reference pattern. The function issues one paginated select per table
// (resolved via `.then()`, since the query is awaited directly rather than
// terminated with `.single()`), followed by one batched `.update().in()`
// write per unique-coordinate group — so entries are queued in that order.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.not    = (...a: unknown[]) => record('not', a)
    chain.range  = (...a: unknown[]) => record('range', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.in     = (...a: unknown[]) => record('in', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function mockMapboxFetch(byZip: Record<string, { center?: [number, number] } | 'error'>) {
  return vi.fn(async (url: string) => {
    const match = /mapbox\.places\/([^.]+)\.json/.exec(url)
    const zip = match ? decodeURIComponent(match[1]!) : ''
    const entry = byZip[zip]

    if (entry === 'error' || entry === undefined) {
      return { ok: false, status: 404, json: async () => ({}) }
    }
    return {
      ok:   true,
      json: async () => ({ features: entry.center ? [{ center: entry.center }] : [] }),
    }
  })
}

describe('geocodingBackfill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MAPBOX_PUBLIC_TOKEN = 'test_mapbox_token'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('geocodes properties and vendors, batching same-zip records into one update each', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: [{ id: 'prop_1', zip: '35007' }, { id: 'prop_2', zip: '35007' }], error: null }, // page 1
        { error: null }, // batched update for zip 35007
      ],
      vendors: [
        { data: [{ id: 'vendor_1', service_zip: '35010' }], error: null },
        { error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockMapboxFetch({
      '35007': { center: [-86.5, 32.6] },
      '35010': { center: [-86.4, 32.7] },
    }))

    const result = await invokeHandler(geocodingBackfill, { event: { data: {} }, step: runAllStep() })

    expect(result).toEqual({
      properties: { geocoded: 2, skipped: 0 },
      vendors:    { geocoded: 1, skipped: 0 },
    })

    const propUpdate = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
    expect(propUpdate?.args[0]).toEqual({ lat: 32.6, lng: -86.5 })
    const propUpdateIn = supabase.calls.find((c) => c.table === 'properties' && c.method === 'in')
    expect(propUpdateIn?.args[1]).toEqual(['prop_1', 'prop_2'])

    const vendorUpdate = supabase.calls.find((c) => c.table === 'vendors' && c.method === 'update')
    expect(vendorUpdate?.args[0]).toEqual({ lat: 32.7, lng: -86.4 })
  }, 10_000)

  it('is a no-op for both properties and vendors when nothing needs geocoding', async () => {
    const supabase = makeSupabase({
      properties: [{ data: [], error: null }],
      vendors:    [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeHandler(geocodingBackfill, { event: { data: {} }, step: runAllStep() })

    expect(result).toEqual({
      properties: { geocoded: 0, skipped: 0 },
      vendors:    { geocoded: 0, skipped: 0 },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('counts a zip with no Mapbox results as skipped and issues no update for it', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: [{ id: 'prop_1', zip: '00000' }], error: null },
      ],
      vendors: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockMapboxFetch({ '00000': { center: undefined } })) // ok, but empty features

    const result = await invokeHandler(geocodingBackfill, { event: { data: {} }, step: runAllStep() })

    expect(result).toEqual({
      properties: { geocoded: 0, skipped: 1 },
      vendors:    { geocoded: 0, skipped: 0 },
    })
    expect(supabase.calls.some((c) => c.table === 'properties' && c.method === 'update')).toBe(false)
  })

  it('treats a Mapbox request failure (non-ok response) the same as no result — skipped, not thrown', async () => {
    const supabase = makeSupabase({
      properties: [
        { data: [{ id: 'prop_1', zip: '99999' }], error: null },
      ],
      vendors: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    vi.stubGlobal('fetch', mockMapboxFetch({})) // no entry for '99999' → simulated 404

    const result = await invokeHandler(geocodingBackfill, { event: { data: {} }, step: runAllStep() })

    expect(result).toEqual({
      properties: { geocoded: 0, skipped: 1 },
      vendors:    { geocoded: 0, skipped: 0 },
    })
  })
})
