import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import type { OwnerRezBookingRow } from '@/lib/integrations/providers/ownerrez'

/**
 * Upsert booking rows and return a COMPLETE external_id -> id map.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it is invisible in every way that
 * matters. Both OwnerRez syncs used to upsert the whole booking set in ONE
 * call and build the id map from that call's returned rows —
 * `.upsert(bookingRows, …).select('id, external_id')`, once, however many
 * bookings there were.
 *
 * (Written as prose rather than as a code sample on purpose: a literal
 * `const { … } = await supabase…` in this comment is matched by
 * unit/guardrails/supabase-error-handling.test.ts, which scans raw source and
 * cannot tell an illustration of a defect from the defect.)
 *
 * The WRITE is not capped — every row lands. The returned REPRESENTATION is:
 * PostgREST caps it at max_rows = 1000 with a 200 and no truncation signal,
 * exactly as it does for a read. So on a portfolio with more than 1000
 * bookings the map came back short, and
 * selectOwnerRezBookingsToPostRevenue's closing
 *
 *     .filter((b) => !!b.bookingId)
 *
 * silently dropped every booking whose id was missing from it. The bookings
 * themselves existed and the calendar looked complete; only the
 * owner_transactions REVENUE rows for them were never posted. No error, no
 * log, nothing in the UI. An owner's P&L was simply short, by an amount that
 * grew with the size of the portfolio.
 *
 * initial-sync is where this bites hardest: it fetches every booking for every
 * property in one call, so a 50-property account with two years of history
 * clears 1000 on its FIRST sync — the one run whose whole job is to get the
 * historical ledger right.
 *
 * The fix is to chunk the upsert so no single response can be truncated, and
 * merge the maps. Chunked at half of max_rows rather than at it: the cap
 * applies to the returned representation, and leaving headroom means a future
 * change that returns more columns, or a server configured with a lower
 * max_rows, does not quietly re-introduce the same silent loss.
 *
 * A numeric chunk loop, not a per-row loop — structurally exempt from
 * unit/guardrails/n-plus-one-loops.test.ts, and one round trip per 500
 * bookings rather than per booking.
 */
export const BOOKING_UPSERT_CHUNK = Math.floor(SUPABASE_MAX_ROWS / 2)

export async function upsertBookingsReturningIds(
  supabase: SupabaseClient,
  rows: OwnerRezBookingRow[],
  /** Connection label for the thrown message, e.g. `OwnerRez:<user_id>`. */
  label: string,
): Promise<Record<string, string>> {
  const idByExternalId: Record<string, string> = {}

  for (let i = 0; i < rows.length; i += BOOKING_UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + BOOKING_UPSERT_CHUNK)

    const { data, error } = await supabase
      .from('bookings')
      .upsert(chunk, { onConflict: 'org_id,external_id,external_source' })
      .select('id, external_id')

    // Thrown, never swallowed: a partial failure here means a partial map,
    // which is the same silent revenue gap this helper exists to close. The
    // caller's step.run retries the whole batch — the upsert is idempotent on
    // (org_id, external_id, external_source), so a replay is safe.
    if (error) throw new Error(`[${label}] bookings upsert: ${error.message}`)

    // A short chunk means PostgREST truncated a response we deliberately
    // sized to fit. Failing loudly beats returning a map that is quietly
    // missing ids, which is precisely the failure mode being fixed.
    if ((data ?? []).length < chunk.length) {
      throw new Error(
        `[${label}] bookings upsert returned ${(data ?? []).length} of ${chunk.length} rows — ` +
        'response truncated, refusing to post revenue against an incomplete id map'
      )
    }

    for (const row of data ?? []) {
      idByExternalId[row.external_id as string] = row.id as string
    }
  }

  return idByExternalId
}
