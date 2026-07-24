import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/assets/scan-data-plate', () => ({
  scanDataPlateImage:   vi.fn(),
  isValidScanMediaType: vi.fn(),
}))

import { assetDataPlateScan } from '@/lib/inngest/functions/asset-scan'
import { createServiceClient } from '@/lib/supabase/server'
import { scanDataPlateImage, isValidScanMediaType } from '@/lib/assets/scan-data-plate'
import { invokeHandler } from './test-helpers'

// Queue-based mock: each `.from(table)` call consumes the next queued
// response for that table, in call order — mirrors the pattern in
// checklist-broadcast.test.ts. `property_assets` is hit three times across
// this function's steps (mark-processing update, save-result select,
// save-result update), so a fixed per-table canned response isn't enough.
function makeSupabase(
  queued: Record<string, { data?: unknown; error?: unknown }[]>,
  downloadResult: { data?: unknown; error?: unknown } = { data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null },
) {
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
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  const download = vi.fn(async () => downloadResult)
  const storage = { from: vi.fn(() => ({ download })) }

  return { from, storage, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const defaultLogger = { info: vi.fn(), error: vi.fn() }

function scanEvent(overrides: Partial<{ org_id: string; asset_id: string; storage_path: string; media_type: string }> = {}) {
  return {
    data: {
      org_id:       'org_1',
      asset_id:     'asset_1',
      storage_path: 'org_1/asset_1/plate.jpg',
      media_type:   'image/jpeg',
      ...overrides,
    },
  }
}

const scanResultFound = {
  make:             'Carrier',
  model:            '58STA080',
  serial_number:    'SN12345',
  manufacture_year: 2020,
  capacity:         '80000 BTU',
  confidence:       'high' as const,
}

const scanResultNotFound = {
  make: null, model: null, serial_number: null,
  manufacture_year: null, capacity: null, confidence: 'low' as const,
}

describe('assetDataPlateScan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(isValidScanMediaType as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true)
  })

  it('fills in blank fields from a successful high-confidence scan and marks it completed', async () => {
    const supabase = makeSupabase({
      property_assets: [
        { data: null, error: null }, // mark-processing update
        {
          data: {
            make: null, model: null, serial_number: null,
            manufacture_date: null, notes: null, scan_status: 'processing',
          },
          error: null,
        }, // save-result select
        { data: null, error: null }, // save-result update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(scanDataPlateImage as ReturnType<typeof vi.fn>).mockResolvedValue(scanResultFound)

    const result = await invokeHandler(assetDataPlateScan, {
      event: scanEvent(),
      step:  makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ asset_id: 'asset_1', confidence: 'high' })

    const finalUpdate = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'update')
    expect(finalUpdate).toHaveLength(2) // mark-processing + save-result
    expect(finalUpdate[1].args[0]).toEqual({
      scan_status:       'completed',
      make:              'Carrier',
      model:             '58STA080',
      serial_number:     'SN12345',
      manufacture_date:  '2020-01-01',
      notes:             'Capacity: 80000 BTU',
    })
  })

  it('marks the scan failed and applies no field updates when nothing is found', async () => {
    const supabase = makeSupabase({
      property_assets: [
        { data: null, error: null },
        {
          data: {
            make: null, model: null, serial_number: null,
            manufacture_date: null, notes: null, scan_status: 'processing',
          },
          error: null,
        },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(scanDataPlateImage as ReturnType<typeof vi.fn>).mockResolvedValue(scanResultNotFound)

    const result = await invokeHandler(assetDataPlateScan, {
      event: scanEvent(),
      step:  makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ asset_id: 'asset_1', confidence: 'low' })
    const finalUpdate = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'update')
    expect(finalUpdate[1].args[0]).toEqual({ scan_status: 'failed' })
  })

  it('never downgrades an already-completed scan and never duplicates an existing capacity note', async () => {
    const supabase = makeSupabase({
      property_assets: [
        { data: null, error: null },
        {
          data: {
            make: 'Carrier', model: '58STA080', serial_number: 'SN12345',
            manufacture_date: '2020-01-01', notes: 'Capacity: 80000 BTU',
            scan_status: 'completed',
          },
          error: null,
        },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    // A retried/duplicate run disagreeing with a low-confidence result for
    // the same data — must not flip a completed scan back to failed, and
    // must not re-append a capacity line that's already present.
    ;(scanDataPlateImage as ReturnType<typeof vi.fn>).mockResolvedValue({
      make: null, model: null, serial_number: null, manufacture_year: null,
      capacity: '80000 BTU', confidence: 'low' as const,
    })

    const result = await invokeHandler(assetDataPlateScan, {
      event: scanEvent(),
      step:  makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ asset_id: 'asset_1', confidence: 'low' })
    const finalUpdate = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'update')
    // Every field is already set and matches — no updates object keys at all.
    expect(finalUpdate[1].args[0]).toEqual({})
  })

  it('is a no-op save when the asset was deleted between the scan and the save step', async () => {
    const supabase = makeSupabase({
      property_assets: [
        { data: null, error: null }, // mark-processing update
        { data: null, error: null }, // save-result select: asset gone
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(scanDataPlateImage as ReturnType<typeof vi.fn>).mockResolvedValue(scanResultFound)

    const result = await invokeHandler(assetDataPlateScan, {
      event: scanEvent(),
      step:  makeStep(),
      logger: defaultLogger,
    })

    expect(result).toEqual({ asset_id: 'asset_1', confidence: 'high' })
    const updateCalls = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'update')
    expect(updateCalls).toHaveLength(1) // only mark-processing — save-result bailed out early
  })

  it('throws (so Inngest retries) on an unsupported media type, without touching storage', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(isValidScanMediaType as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false)

    await expect(
      invokeHandler(assetDataPlateScan, {
        event: scanEvent({ media_type: 'image/heic' }),
        step:  makeStep(),
        logger: defaultLogger,
      }),
    ).rejects.toThrow('Unsupported media type: image/heic')

    expect(supabase.storage.from).not.toHaveBeenCalled()
  })

  it('throws when the data-plate photo cannot be downloaded from storage', async () => {
    const supabase = makeSupabase(
      { property_assets: [{ data: null, error: null }] },
      { data: null, error: { message: 'object not found' } },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(assetDataPlateScan, {
        event: scanEvent(),
        step:  makeStep(),
        logger: defaultLogger,
      }),
    ).rejects.toThrow('Could not download photo: object not found')

    expect(scanDataPlateImage).not.toHaveBeenCalled()
  })

  it('throws when the final property_assets update fails', async () => {
    const supabase = makeSupabase({
      property_assets: [
        { data: null, error: null },
        {
          data: {
            make: null, model: null, serial_number: null,
            manufacture_date: null, notes: null, scan_status: 'processing',
          },
          error: null,
        },
        { data: null, error: { message: 'connection reset' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(scanDataPlateImage as ReturnType<typeof vi.fn>).mockResolvedValue(scanResultFound)

    await expect(
      invokeHandler(assetDataPlateScan, {
        event: scanEvent(),
        step:  makeStep(),
        logger: defaultLogger,
      }),
    ).rejects.toThrow('property_assets update failed: connection reset')
  })
})
