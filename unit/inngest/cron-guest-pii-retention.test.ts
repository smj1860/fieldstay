import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvents: vi.fn(),
}))

import { dailyGuestPiiRetention, guestPiiRetentionOrg } from '@/lib/inngest/functions/cron/guest-pii-retention'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

// Now a DISPATCHER (`dailyGuestPiiRetention`) plus a per-org handler
// (`guestPiiRetentionOrg`). The single-invocation version ran one `step.run`
// per org (150 steps at 150 tenants) and issued one serial delete_vault_secret
// RPC per stale booking with no bound on booking count; the handler now
// processes bookings in bounded batches.
//
// `bookings` is queried twice per batch (the stale select, then the
// anonymizing update), so tables are seeded as a queue consumed in query order.
//
// supabase.rpc('delete_vault_secret', ...) is called directly, not through the
// .from() chain — the source only inspects its error, so the shared double's
// default resolved rpc stub is enough. Real vault-secret ids are never used:
// fixture ids here are placeholders, never actual guest data.
function makeSupabase(queued: Record<string, TableSpec>) {
  return createSupabaseDouble(queued)
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

const NOW_MS = Date.parse('2026-07-22T00:00:00.000Z')

describe('dailyGuestPiiRetention (dispatcher)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fans out one guest-PII-retention event per org, carrying a single captured now_ms', async () => {
    const supabase = makeSupabase({
      organizations: [{ data: [{ id: 'org_1' }, { id: 'org_2' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyGuestPiiRetention, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 2 })
    const [, events] = step.sendEvent.mock.calls[0] as [string, { name: string; data: { org_id: string; now_ms: number } }[]]
    expect(events.map((e) => e.data.org_id)).toEqual(['org_1', 'org_2'])
    expect(new Set(events.map((e) => e.data.now_ms)).size).toBe(1)
  })

  it('dispatches every org past the first PostgREST page', async () => {
    const orgs = Array.from({ length: 1_400 }, (_, i) => ({ id: `org_${i}` }))
    const supabase = makeSupabase({ organizations: { data: orgs, error: null } })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(dailyGuestPiiRetention, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ dispatched: 1_400 })
  })
})

describe('guestPiiRetentionOrg (per org)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function orgEvent(orgId = 'org_1', nowMs = NOW_MS) {
    return { data: { org_id: orgId, now_ms: nowMs } }
  }

  it('anonymizes stale bookings (incl. deleting the door-code Vault secret) and deletes stale never-opted-out SMS optins', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { guest_pii_retention_days: 365 }, error: null },
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

    const result = await invokeHandler(guestPiiRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', bookings_anonymized: 2, optins_deleted: 1 })

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

  it('is a no-op when nothing for the org is past the retention window', async () => {
    const supabase = makeSupabase({
      organizations: [
        { data: { guest_pii_retention_days: 365 }, error: null },
      ],
      bookings: [
        { data: [], error: null },
      ],
      guidebook_guest_sms_optins: [
        { data: [], error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guestPiiRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', bookings_anonymized: 0, optins_deleted: 0 })
    expect(supabase.rpc).not.toHaveBeenCalled()
    // No bookings past the cutoff means no anonymizing update runs at all.
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(false)
    expect(logAuditEvents).not.toHaveBeenCalled()
  })

  it('does nothing but report when the org was deleted between dispatch and delivery', async () => {
    const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guestPiiRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ org_id: 'org_1', skipped: 'org_missing' })
    expect(supabase.calls.some((c) => c.table === 'bookings')).toBe(false)
  })

  it('keeps batching until a short batch arrives, so a backlog past one batch is not left behind', async () => {
    // A full 200-row batch must be followed by another pass; the previous
    // single-query version processed one page and stopped.
    const fullBatch = Array.from({ length: 200 }, (_, i) => ({ id: `bk_${i}`, door_code_secret_id: null }))
    const supabase = makeSupabase({
      organizations: [{ data: { guest_pii_retention_days: 365 }, error: null }],
      bookings: [
        { data: fullBatch, error: null },                                  // batch 0 select — full
        { data: null, error: null },                                       // batch 0 update
        { data: [{ id: 'bk_200', door_code_secret_id: null }], error: null }, // batch 1 select — short
        { data: null, error: null },                                       // batch 1 update
      ],
      guidebook_guest_sms_optins: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guestPiiRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toMatchObject({ bookings_anonymized: 201 })
    expect(supabase.calls.filter((c) => c.table === 'bookings' && c.method === 'update')).toHaveLength(2)
  })

  it('anonymizes the row even when its Vault secret delete fails (already-gone secret must not block)', async () => {
    const supabase = createSupabaseDouble(
      {
        organizations: [{ data: { guest_pii_retention_days: 365 }, error: null }],
        bookings: [
          { data: [{ id: 'bk_1', door_code_secret_id: 'vault_sec_1' }], error: null },
          { data: null, error: null },
        ],
        guidebook_guest_sms_optins: [{ data: [], error: null }],
      },
      { rpc: { data: null, error: { code: '42704', message: 'secret not found' } } },
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guestPiiRetentionOrg, {
      event:  orgEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toMatchObject({ bookings_anonymized: 1 })
    expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'update')).toBe(true)
  })

  describe('retention-window cutoff date math', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    function quietOrg() {
      return makeSupabase({
        organizations: [
          { data: { guest_pii_retention_days: 1 }, error: null },
        ],
        bookings: [
          { data: [], error: null },
        ],
        guidebook_guest_sms_optins: [
          { data: [], error: null },
        ],
      })
    }

    it('cuts bookings off at the date-truncated retention boundary and optins at the full-timestamp boundary', async () => {
      const supabase = quietOrg()
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(guestPiiRetentionOrg, {
        event:  orgEvent(),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      // bookings.checkout_date is a date column — the cutoff is truncated to
      // YYYY-MM-DD. A 1-day retention window from the dispatcher-captured
      // now_ms (2026-07-22 UTC midnight) lands exactly on yesterday.
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
      const supabase = quietOrg()
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(guestPiiRetentionOrg, {
        event:  orgEvent(),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      const bookingsCall = supabase.calls.find((c) => c.table === 'bookings' && c.method === 'lt')
      expect(bookingsCall?.method).toBe('lt')
      expect(supabase.calls.some((c) => c.table === 'bookings' && c.method === 'lte')).toBe(false)
    })
  })
})
