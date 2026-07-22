import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable-token', () => ({
  getValidHospitableToken: vi.fn(),
}))
vi.mock('@/lib/integrations/providers/hospitable', () => ({
  hospFetchCalendar:          vi.fn(),
  consolidateHospitableBlocks: vi.fn(),
}))

import { hospCalendarSyncHandler } from '@/lib/inngest/functions/hospitable/calendar-sync-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospFetchCalendar, consolidateHospitableBlocks } from '@/lib/integrations/providers/hospitable'
import { invokeHandler } from './test-helpers'

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

function makeSupabase(queued: QueuedByTable) {
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.neq    = (...a: unknown[]) => record('neq', a)
    chain.lte    = (...a: unknown[]) => record('lte', a)
    chain.gte    = (...a: unknown[]) => record('gte', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const EVENT_DATA = {
  property_id:            'prop_1',
  org_id:                 'org_1',
  user_id:                'user_1',
  hospitable_property_id: 'hosp_1',
}

describe('hospCalendarSyncHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getValidHospitableToken as ReturnType<typeof vi.fn>).mockResolvedValue('token_abc')
    ;(hospFetchCalendar as ReturnType<typeof vi.fn>).mockResolvedValue([])
  })

  it('upserts active blocks on the stable per-range external_id and cancels a stale block no longer present in the fresh fetch', async () => {
    ;(consolidateHospitableBlocks as ReturnType<typeof vi.fn>).mockReturnValue([
      { checkin_date: '2026-08-01', checkout_date: '2026-08-03' },
    ])
    const supabase = makeSupabase({
      bookings: [
        { error: null }, // upsert active blocks
        {               // select existing blocks
          data: [
            { id: 'row_current', external_id: 'hospitable-block:hosp_1:2026-08-01' }, // still current, keep
            { id: 'row_stale',   external_id: 'hospitable-block:hosp_1:2026-07-01' }, // no longer present, cancel
          ],
          error: null,
        },
        { error: null }, // cancel update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospCalendarSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ activeCount: 1, cancelledCount: 1 })

    const upsert = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'upsert')
    expect(upsert?.args[1]).toEqual({ onConflict: 'org_id,external_id,external_source' })
    expect(upsert?.args[0]).toEqual([
      expect.objectContaining({
        org_id: 'org_1', property_id: 'prop_1', external_source: 'hospitable',
        external_id: 'hospitable-block:hosp_1:2026-08-01',
        checkin_date: '2026-08-01', checkout_date: '2026-08-03',
        is_block: true, status: 'blocked',
      }),
    ])

    const cancel = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    expect(cancel?.args[0]).toEqual({ status: 'cancelled' })
    const cancelIn = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'in')
    expect(cancelIn?.args).toEqual(['id', ['row_stale']])
  })

  it('re-running against the same still-active block does not cancel it — idempotent on unchanged calendar state', async () => {
    ;(consolidateHospitableBlocks as ReturnType<typeof vi.fn>).mockReturnValue([
      { checkin_date: '2026-08-01', checkout_date: '2026-08-03' },
    ])
    const supabase = makeSupabase({
      bookings: [
        { error: null }, // upsert (no-op re-upsert of the same row)
        {                // existing blocks — only the still-current one
          data: [{ id: 'row_current', external_id: 'hospitable-block:hosp_1:2026-08-01' }],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospCalendarSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ activeCount: 1, cancelledCount: 0 })
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
  })

  it('is a no-op when there are no manual blocks in the window and none existing to reconcile', async () => {
    ;(consolidateHospitableBlocks as ReturnType<typeof vi.fn>).mockReturnValue([])
    const supabase = makeSupabase({
      bookings: [
        { data: [], error: null }, // existing blocks select — none
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospCalendarSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ activeCount: 0, cancelledCount: 0 })
    // rows.length === 0 short-circuits the upsert entirely
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'upsert')).toBe(false)
  })

  it('throws when the active-block upsert fails, instead of silently proceeding to reconciliation', async () => {
    ;(consolidateHospitableBlocks as ReturnType<typeof vi.fn>).mockReturnValue([
      { checkin_date: '2026-08-01', checkout_date: '2026-08-03' },
    ])
    const supabase = makeSupabase({
      bookings: [{ error: { message: 'upsert failed' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(hospCalendarSyncHandler, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })).rejects.toThrow('Block upsert failed: upsert failed')
  })
})
