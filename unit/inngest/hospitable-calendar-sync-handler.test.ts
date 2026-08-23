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
vi.mock('@/lib/inngest/helpers', () => ({ createPmNotification: vi.fn() }))

import { hospCalendarSyncHandler } from '@/lib/inngest/functions/hospitable/calendar-sync-handler'
import { createServiceClient } from '@/lib/supabase/server'
import { getValidHospitableToken } from '@/lib/integrations/providers/hospitable-token'
import { hospFetchCalendar, consolidateHospitableBlocks } from '@/lib/integrations/providers/hospitable'
import { createPmNotification } from '@/lib/inngest/helpers'
import { ProviderEntityGoneError } from '@/lib/integrations/types'
import { invokeHandler } from './test-helpers'

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
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
    chain.limit  = (...a: unknown[]) => record('limit', a)
    chain.is     = (...a: unknown[]) => record('is', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
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

  // ==========================================================================
  // A LISTING HOSPITABLE NO LONGER RECOGNISES.
  //
  // From 2026-08-22 this cron dispatched a sync every morning for a property
  // uuid the provider had stopped returning, got 404, exhausted its retries and
  // raised SENTRY-CRAZY-CUSHION-F. Nothing in the system could resolve it,
  // because nothing recorded that the listing was gone.
  //
  // The 404 is acted on — where absence from a LIST would not be — because it
  // is positive, per-entity evidence about one id we asked about directly. It
  // cannot be manufactured by a truncated page. Acting on it still means
  // PAUSING and telling the PM, never deactivating: a 404 does not distinguish
  // "delisted" from "relisted under a new id".
  // ==========================================================================
  describe('when Hospitable no longer recognises the listing', () => {
    const gone = () => new ProviderEntityGoneError(
      'Hospitable', '/properties/{uuid}/calendar', 'hosp_1', 'No result found.',
    )

    it('pauses the property instead of throwing, so retries are not burned', async () => {
      ;(hospFetchCalendar as ReturnType<typeof vi.fn>).mockRejectedValue(gone())
      const supabase = makeSupabase({
        properties: [{ data: { name: 'Tarrytown Loft' }, error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      const result = await invokeHandler(hospCalendarSyncHandler, {
        event: { data: EVENT_DATA },
        step:  runAllStep(),
        logger: makeLogger(),
      })

      expect(result).toEqual({ activeCount: 0, cancelledCount: 0, paused: true })
      const update = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
      expect(update?.args[0]).toMatchObject({ external_missing_since: expect.any(String) })
    })

    it('does NOT deactivate the property', async () => {
      // The whole asymmetry. A property carries bookings, turnovers and every
      // downstream cron; switching it off on one status code is the mistake
      // that deactivated an org's entire crew roster on 2026-07-18.
      ;(hospFetchCalendar as ReturnType<typeof vi.fn>).mockRejectedValue(gone())
      const supabase = makeSupabase({
        properties: [{ data: { name: 'Tarrytown Loft' }, error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(hospCalendarSyncHandler, {
        event: { data: EVENT_DATA }, step: runAllStep(), logger: makeLogger(),
      })

      const update = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
      expect(update?.args[0]).not.toHaveProperty('is_active')
    })

    it('stamps the FIRST 404, not the most recent one', async () => {
      // The timestamp is the only evidence of how long a listing has been gone.
      // A daily cron without this guard rewrites it to today every morning, so
      // it would always read "missing since today".
      ;(hospFetchCalendar as ReturnType<typeof vi.fn>).mockRejectedValue(gone())
      const supabase = makeSupabase({
        properties: [{ data: { name: 'Tarrytown Loft' }, error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(hospCalendarSyncHandler, {
        event: { data: EVENT_DATA }, step: runAllStep(), logger: makeLogger(),
      })

      const isNull = supabase.calls.find((c) => c.table === 'properties' && c.method === 'is')
      expect(isNull?.args).toEqual(['external_missing_since', null])
    })

    it('tells the PM once, deduped on the property', async () => {
      // A property that silently stops syncing is the bad outcome here. The
      // notification is what turns a pause into something the customer can act
      // on — and the dedupe key is what stops a daily cron stacking one a day.
      ;(hospFetchCalendar as ReturnType<typeof vi.fn>).mockRejectedValue(gone())
      const supabase = makeSupabase({
        properties: [{ data: { name: 'Tarrytown Loft' }, error: null }],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(hospCalendarSyncHandler, {
        event: { data: EVENT_DATA }, step: runAllStep(), logger: makeLogger(),
      })

      expect(createPmNotification).toHaveBeenCalledTimes(1)
      const input = vi.mocked(createPmNotification).mock.calls[0]![1]
      expect(input).toMatchObject({
        orgId: 'org_1', severity: 'amber', dedupeKey: 'property-missing:prop_1',
      })
      expect(input.title).toContain('Tarrytown Loft')
      // A PM cannot act on a provider uuid, and it does not belong in the bell.
      expect(`${input.title} ${input.subtitle}`).not.toContain('hosp_1')
    })

    it('does not re-notify once the property is already marked', async () => {
      // maybeSingle returns no row because the `.is(..., null)` filter matched
      // nothing — it was marked on an earlier run.
      ;(hospFetchCalendar as ReturnType<typeof vi.fn>).mockRejectedValue(gone())
      const supabase = makeSupabase({ properties: [{ data: null, error: null }] })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      const result = await invokeHandler(hospCalendarSyncHandler, {
        event: { data: EVENT_DATA }, step: runAllStep(), logger: makeLogger(),
      })

      expect(result).toMatchObject({ paused: true })
      expect(createPmNotification).not.toHaveBeenCalled()
    })

    it('still throws on any OTHER provider failure', async () => {
      // Only 404 is terminal. A 500 or a timeout must keep its retries — the
      // listing is probably fine and pausing it would be the wrong answer.
      ;(hospFetchCalendar as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Hospitable /properties/hosp_1/calendar failed (503): '))
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(makeSupabase({}))

      await expect(invokeHandler(hospCalendarSyncHandler, {
        event: { data: EVENT_DATA }, step: runAllStep(), logger: makeLogger(),
      })).rejects.toThrow('503')
      expect(createPmNotification).not.toHaveBeenCalled()
    })
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
