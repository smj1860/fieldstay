import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { dailyGuestPiiRetention } from '@/lib/inngest/functions/cron/guest-pii-retention'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Cron function — the real event has no meaningful `data` the handler reads
// (it only queries by wall-clock date), so `event` is passed as `{}` below,
// mirroring cron-vendor-compliance-grace-check.test.ts.

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check: each `.from(table)` call consumes
// the next queued response for that table, in call order. `bookings` is
// queried twice per org with a stale-booking candidate present (the stale
// select, then the anonymizing update), so a fixed per-table response isn't
// enough — order matters.
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
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.lt     = (...a: unknown[]) => record('lt', a)
    chain.in     = (...a: unknown[]) => record('in', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.delete = (...a: unknown[]) => record('delete', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  // supabase.rpc('delete_vault_secret', ...) is called directly, not through
  // the .from() chain — its return value is ignored by the source, so a
  // plain resolved stub is enough. Real vault-secret ids are never used —
  // fixture ids here are placeholders, never actual guest data.
  const rpc = vi.fn(async () => ({ data: null, error: null }))

  return { from, rpc, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('dailyGuestPiiRetention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('anonymizes stale bookings (incl. deleting the door-code Vault secret) and deletes stale never-opted-out SMS optins', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: [{ id: 'org_1', guest_pii_retention_days: 365 }], error: null },
      ],
      bookings: [
        {
          data: [
            { id: 'bk_1', door_code_secret_id: 'vault_sec_1' },
            { id: 'bk_2', door_code_secret_id: null },
          ],
          error: null,
        },
        { data: null, error: null }, // update — result is unused by the source
      ],
      guidebook_guest_sms_optins: [
        { data: [{ id: 'optin_1' }], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyGuestPiiRetention, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ bookings_anonymized: 2, optins_deleted: 1 })

    // Only the booking that actually stored a door-code Vault secret gets it deleted.
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('delete_vault_secret', { p_secret_id: 'vault_sec_1' })

    const updateCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({
      guest_name:              null,
      guest_email:             null,
      raw_ical_data:           null,
      door_code_secret_id:     null,
      guest_pii_anonymized_at: expect.any(String),
    })
    const updateInCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'in')
    expect(updateInCall?.args).toEqual(['id', ['bk_1', 'bk_2']])

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId:      'org_1',
        action:     'booking.guest_pii_anonymized',
        targetType: 'booking',
        metadata:   expect.objectContaining({ source: 'retention_cron', count: 2 }),
      }),
      expect.objectContaining({
        orgId:      'org_1',
        action:     'sms.optin_phone_anonymized',
        targetType: 'guidebook_guest_sms_optin',
        metadata:   expect.objectContaining({ source: 'retention_cron', count: 1 }),
      }),
    ])
  })

  it('is a no-op when nothing for any org is past the retention window', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: [{ id: 'org_1', guest_pii_retention_days: 365 }], error: null },
      ],
      bookings: [
        { data: [], error: null },
      ],
      guidebook_guest_sms_optins: [
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyGuestPiiRetention, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ bookings_anonymized: 0, optins_deleted: 0 })
    expect(supabase.rpc).not.toHaveBeenCalled()
    // No bookings never past the cutoff means no anonymizing update runs at all.
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('processes multiple orgs independently and aggregates the totals', async () => {
    const supabase = makeSupabase({
      organizations: [
        {
          data: [
            { id: 'org_1', guest_pii_retention_days: 365 },
            { id: 'org_2', guest_pii_retention_days: 90 },
          ],
          error: null,
        },
      ],
      bookings: [
        { data: [{ id: 'bk_1', door_code_secret_id: null }], error: null }, // org_1 select
        { data: null, error: null },                                       // org_1 update
        { data: [], error: null },                                         // org_2 select — nothing stale
      ],
      guidebook_guest_sms_optins: [
        { data: [], error: null },                        // org_1
        { data: [{ id: 'optin_2' }], error: null },        // org_2
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(dailyGuestPiiRetention, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ bookings_anonymized: 1, optins_deleted: 1 })

    const orgIds = (logAuditEvents as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { orgId: string }[])[0].orgId,
    )
    expect(orgIds).toEqual(['org_1', 'org_2'])
  })

  describe('retention-window cutoff date math', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('cuts bookings off at the date-truncated retention boundary and optins at the full-timestamp boundary', async () => {
      const supabase = makeSupabase({
        organizations: [
          { data: [{ id: 'org_1', guest_pii_retention_days: 1 }], error: null },
        ],
        bookings: [
          { data: [], error: null },
        ],
        guidebook_guest_sms_optins: [
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(dailyGuestPiiRetention, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      // bookings.checkout_date is a date column — the cutoff is truncated to
      // YYYY-MM-DD. A 1-day retention window from "now" (2026-07-22 UTC
      // midnight) lands exactly on yesterday.
      const bookingsLt = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'lt')
      expect(bookingsLt?.args).toEqual(['checkout_date', '2026-07-21'])

      // guidebook_guest_sms_optins.opted_in_at is a timestamptz — the cutoff
      // stays a full ISO instant, not truncated to a date.
      const optinsLt = supabase.calls.find((c) => c.table === 'guidebook_guest_sms_optins' && c.method === 'lt')
      expect(optinsLt?.args).toEqual(['opted_in_at', '2026-07-21T00:00:00.000Z'])
    })

    it('does not sweep up a booking that checked out exactly at the retention boundary (not yet stale)', async () => {
      // checkout_date === cutoff must NOT match `lt` (strictly less-than) —
      // the query itself enforces this, so this test locks in that the
      // handler passes a strict `lt`, not `lte`, to the query builder.
      const supabase = makeSupabase({
        organizations: [
          { data: [{ id: 'org_1', guest_pii_retention_days: 1 }], error: null },
        ],
        bookings: [
          { data: [], error: null },
        ],
        guidebook_guest_sms_optins: [
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(dailyGuestPiiRetention, {
        event:  {},
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const bookingsCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'lt')
      expect(bookingsCall?.method).toBe('lt')
      expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'lte')).toBe(false)
    })
  })
})
