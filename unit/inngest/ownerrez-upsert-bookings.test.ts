import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  upsertBookingsReturningIds,
  BOOKING_UPSERT_CHUNK,
} from '@/lib/inngest/functions/ownerrez/upsert-bookings'
import { SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import { selectOwnerRezBookingsToPostRevenue } from '@/lib/integrations/providers/ownerrez'

// ============================================================================
// A single .upsert().select() returns at most max_rows = 1000 rows, with a 200
// and no truncation signal — the WRITE is uncapped, only the returned
// representation is clipped. Both OwnerRez syncs built their external_id -> id
// map from that response, and selectOwnerRezBookingsToPostRevenue ends with
//
//     .filter((b) => !!b.bookingId)
//
// so every booking missing from the clipped response was silently dropped from
// revenue posting. The bookings existed; only the owner's P&L was short.
//
// initial-sync fetches every booking for every property in one call, so a
// portfolio with history crosses 1000 on its FIRST run — the run whose whole
// job is to get the historical ledger right.
// ============================================================================

interface UpsertCall { size: number }

/**
 * A client whose .select() truncates at `cap`, exactly as PostgREST does.
 * The write always "succeeds" for every row — that asymmetry is the bug.
 */
function makeSupabase(cap = SUPABASE_MAX_ROWS) {
  const calls: UpsertCall[] = []
  const from = vi.fn(() => ({
    upsert: (rows: { external_id: string }[]) => ({
      select: () => {
        calls.push({ size: rows.length })
        return Promise.resolve({
          data:  rows.slice(0, cap).map((r) => ({ id: `id-${r.external_id}`, external_id: r.external_id })),
          error: null,
        })
      },
    }),
  }))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, calls }
}

const rows = (n: number) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Array.from({ length: n }, (_, i) => ({ external_id: `e${i}` })) as any

describe('upsertBookingsReturningIds', () => {
  it('returns an id for EVERY booking past the 1000-row response cap', async () => {
    // 2,500 bookings is an ordinary two-year history for a 50-property account
    // — CLAUDE.md's own stated target scale.
    const { client } = makeSupabase()
    const map = await upsertBookingsReturningIds(client, rows(2_500), 'OwnerRez:test')

    expect(Object.keys(map)).toHaveLength(2_500)
    expect(map['e0']).toBe('id-e0')
    expect(map['e2499']).toBe('id-e2499')   // the row a single upsert lost
  })

  it('never sends a chunk that could itself be truncated', async () => {
    const { client, calls } = makeSupabase()
    await upsertBookingsReturningIds(client, rows(2_500), 'OwnerRez:test')

    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) expect(c.size).toBeLessThanOrEqual(BOOKING_UPSERT_CHUNK)
    // Headroom, not exactly at the cap: a future change returning more columns
    // or a server with a lower max_rows must not silently re-break this.
    expect(BOOKING_UPSERT_CHUNK).toBeLessThan(SUPABASE_MAX_ROWS)
  })

  it('THROWS on a short response rather than returning a partial map', async () => {
    // The defining property. A partial map is indistinguishable from success
    // downstream — it just posts less revenue. Failing loudly is the only way
    // this surfaces at all.
    const { client } = makeSupabase(10)
    await expect(upsertBookingsReturningIds(client, rows(600), 'OwnerRez:test'))
      .rejects.toThrow(/truncated/)
  })

  it('does one round trip for a small sync, not one per booking', async () => {
    const { client, calls } = makeSupabase()
    await upsertBookingsReturningIds(client, rows(40), 'OwnerRez:test')
    expect(calls).toHaveLength(1)
  })

  it('is a no-op for zero bookings', async () => {
    const { client, calls } = makeSupabase()
    await expect(upsertBookingsReturningIds(client, rows(0), 'OwnerRez:test')).resolves.toEqual({})
    expect(calls).toHaveLength(0)
  })
})

describe('the revenue gap this closes', () => {
  it('drops revenue for bookings missing from a truncated id map', async () => {
    // Demonstrates the ORIGINAL failure end to end, so the reason for the
    // chunking is testable rather than asserted in a comment.
    const bookingRows = Array.from({ length: 1_200 }, (_, i) => ({
      external_id: `e${i}`, status: 'confirmed', stay_type: 'guest_stay',
      property_id: 'p-1', actual_total_amount: 100,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any

    const truncatedMap = Object.fromEntries(
      bookingRows.slice(0, SUPABASE_MAX_ROWS).map((r: { external_id: string }) => [r.external_id, `id-${r.external_id}`]),
    )
    expect(selectOwnerRezBookingsToPostRevenue(bookingRows, truncatedMap)).toHaveLength(1_000)

    const { client } = makeSupabase()
    const completeMap = await upsertBookingsReturningIds(client, bookingRows, 'OwnerRez:test')
    expect(selectOwnerRezBookingsToPostRevenue(bookingRows, completeMap)).toHaveLength(1_200)
  })
})
