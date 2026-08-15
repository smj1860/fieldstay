import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/helpers', () => ({
  createPmNotifications: vi.fn(async () => undefined),
}))

import { assetWarrantyExpiryCheck } from '@/lib/inngest/functions/cron/asset-warranty-expiry-check'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotifications } from '@/lib/inngest/helpers'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

describe('assetWarrantyExpiryCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('claims and notifies for an asset newly entering the expiring-soon window', async () => {
    const supabase = makeSupabase({
      property_assets: [
        {
          data: [{
            id: 'asset_1', org_id: 'org_1', name: 'Main HVAC',
            warranty_expiry_date: '2026-08-01', warranty_provider: 'Carrier',
          }],
          error: null,
        },
        // The batched claim update — returns the claimed row(s).
        { data: [{ id: 'asset_1' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetWarrantyExpiryCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })

    expect(result).toEqual({ warned: 1 })

    expect(createPmNotifications).toHaveBeenCalledWith(
      supabase,
      [expect.objectContaining({
        orgId:     'org_1',
        type:      'asset_warranty_expiry',
        title:     'Main HVAC warranty expires in 10 days',
        subtitle:  'Carrier',
        href:      '/assets',
        severity:  'amber',
        dedupeKey: 'asset-warranty-expiry-asset_1',
      })],
    )

    const updateCall = supabase.calls.find(
      (c) => c.table === 'property_assets' && c.method === 'update',
    )
    expect(updateCall?.args[0]).toMatchObject({ warranty_warned_at: expect.any(String) })
  })

  it('is a no-op when nothing is entering the expiring-soon window', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetWarrantyExpiryCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })

    expect(result).toEqual({ warned: 0 })
    expect(createPmNotifications).not.toHaveBeenCalled()
  })

  it('does not notify for an asset another concurrent run already claimed', async () => {
    const supabase = makeSupabase({
      property_assets: [
        {
          data: [{
            id: 'asset_2', org_id: 'org_1', name: 'Water Heater',
            warranty_expiry_date: '2026-08-05', warranty_provider: null,
          }],
          error: null,
        },
        // Another run already flipped warranty_warned_at — the
        // `.is('warranty_warned_at', null)` precondition no longer matches
        // this row, so the claim update returns nothing for it.
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(assetWarrantyExpiryCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })

    expect(result).toEqual({ warned: 0 })
    expect(createPmNotifications).toHaveBeenCalledWith(supabase, [])
  })

  it('queries the exact 30-day expiring-soon window from today', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(assetWarrantyExpiryCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })

    const gte = supabase.calls.find((c) => c.method === 'gte' && c.args[0] === 'warranty_expiry_date')
    const lte = supabase.calls.find((c) => c.method === 'lte' && c.args[0] === 'warranty_expiry_date')
    expect(gte?.args[1]).toBe('2026-07-22')
    expect(lte?.args[1]).toBe('2026-08-21') // today + 30 days
  })

  it('only scopes to active assets with an unwarned, non-null warranty date', async () => {
    const supabase = makeSupabase({
      property_assets: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(assetWarrantyExpiryCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    })

    const eqCalls = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'eq')
    expect(eqCalls.map((c) => c.args)).toContainEqual(['is_active', true])

    const isCalls = supabase.calls.filter((c) => c.table === 'property_assets' && c.method === 'is')
    expect(isCalls.map((c) => c.args)).toContainEqual(['warranty_warned_at', null])
  })
})
