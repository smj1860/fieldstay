import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/assets/manual-lookup', () => ({
  findManualUrl: vi.fn(),
}))

import { assetManualLookup } from '@/lib/inngest/functions/asset-manual-lookup'
import { createServiceClient } from '@/lib/supabase/server'
import { findManualUrl } from '@/lib/assets/manual-lookup'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — mirrors checklist-broadcast.test.ts.
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
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.insert = (...a: unknown[]) => record('insert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then        = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function lookupEvent(overrides: Partial<{ org_id: string; asset_type: string; make: string; model: string }> = {}) {
  return {
    data: {
      org_id:     'org_1',
      asset_type: 'hvac',
      make:       ' Carrier ',
      model:      'XR16',
      ...overrides,
    },
  }
}

describe('assetManualLookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('normalizes make/model, looks up, and saves a found manual URL', async () => {
    const supabase = makeSupabase({
      asset_manuals: [
        { data: null, error: null },  // check-existing: nothing yet
        { data: null, error: null },  // save-result insert
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(findManualUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      sourceUrl: 'https://www.carrier.com/manuals/xr16.pdf',
      foundVia:  'search',
    })

    const result = await invokeHandler(assetManualLookup, {
      event: lookupEvent(),
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ found: true })
    expect(findManualUrl).toHaveBeenCalledWith('hvac', 'carrier', 'xr16')

    const eqCalls = supabase.calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['make', 'carrier'],
        ['model', 'xr16'],
      ]),
    )

    const insertCall = supabase.calls.find((c) => c.table === 'asset_manuals' && c.method === 'insert')
    expect(insertCall?.args[0]).toEqual(
      expect.objectContaining({
        org_id:      'org_1',
        asset_type:  'hvac',
        make:        'carrier',
        model:       'xr16',
        source_url:  'https://www.carrier.com/manuals/xr16.pdf',
        found_via:   'search',
        verified_at: expect.any(String) as unknown as string,
      }),
    )
  })

  it('skips the lookup entirely when an attempt already exists for this make/model', async () => {
    const supabase = makeSupabase({
      asset_manuals: [
        { data: { id: 'manual_1' }, error: null }, // already attempted
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetManualLookup, {
      event: lookupEvent(),
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ skipped: true, reason: 'already_attempted' })
    expect(findManualUrl).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.method === 'insert')).toBe(false)
  })

  it('saves a null source_url when the lookup finds nothing with reasonable confidence', async () => {
    const supabase = makeSupabase({
      asset_manuals: [
        { data: null, error: null },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(findManualUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ sourceUrl: null, foundVia: null })

    const result = await invokeHandler(assetManualLookup, {
      event: lookupEvent(),
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ found: false })
    const insertCall = supabase.calls.find((c) => c.table === 'asset_manuals' && c.method === 'insert')
    expect(insertCall?.args[0]).toEqual(
      expect.objectContaining({ source_url: null, found_via: null, verified_at: null }),
    )
  })

  it('throws so Inngest retries the whole check when the existence check itself errors', async () => {
    const supabase = makeSupabase({
      asset_manuals: [
        { data: null, error: { message: 'connection reset' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(assetManualLookup, {
        event: lookupEvent(),
        step:  makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow('asset_manuals existence check failed: connection reset')

    expect(findManualUrl).not.toHaveBeenCalled()
  })

  it('treats a unique-violation on insert as a safe no-op concurrent save, not an error', async () => {
    const supabase = makeSupabase({
      asset_manuals: [
        { data: null, error: null },
        { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(findManualUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
      sourceUrl: 'https://www.carrier.com/manuals/xr16.pdf',
      foundVia:  'search',
    })

    const result = await invokeHandler(assetManualLookup, {
      event: lookupEvent(),
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ found: true })
  })

  it('throws on a non-unique-violation insert error', async () => {
    const supabase = makeSupabase({
      asset_manuals: [
        { data: null, error: null },
        { data: null, error: { code: '500', message: 'internal error' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(findManualUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ sourceUrl: null, foundVia: null })

    await expect(
      invokeHandler(assetManualLookup, {
        event: lookupEvent(),
        step:  makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow('asset_manuals insert failed: internal error')
  })
})
