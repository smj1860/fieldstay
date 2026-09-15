import type { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'

type ServiceClient = ReturnType<typeof createServiceClient>

interface TurnoverRow {
  id:                string
  property_id:       string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number | null
}

export interface TurnoverCreatedEvent {
  name: 'turnover/created'
  data: {
    turnover_id:       string
    property_id:       string
    org_id:            string
    checkout_datetime: string
    checkin_datetime:  string
    window_minutes:    number
  }
}

/**
 * Keeps a single request's `.in('id', …)` list under the gateway's URL limit.
 *
 * PostgREST encodes `.in()` values straight into the query string, so an
 * unbounded id array eventually produces a URL past a proxy's length limit
 * and the request itself fails with a 414 — a REQUEST-side ceiling, distinct
 * from and unaffected by the response-side pagination below. `fetchAllRows`
 * bounds what comes BACK from one query; it does nothing to bound what goes
 * OUT in that query's own `.in()` filter, so pairing it with an unchunked
 * `turnoverIds` still sends the whole array on every page of every request.
 * 100 UUIDs ≈ 3.7KB of query string — comfortably inside every proxy default
 * — matching the same constant and reasoning as lib/dexie/sync/chunked.ts's
 * IN_CHUNK_SIZE for the identical defect in the crew sync layer.
 */
const ID_CHUNK_SIZE = 100

/**
 * Build the `turnover/created` events for a set of just-created turnovers.
 *
 * This existed as six byte-for-byte copies — booking-events, hospitable
 * initial + incremental, hostaway initial, and ownerrez initial + incremental —
 * each re-deriving the same select, the same row type, and the same event
 * shape. Six copies of one read is six places for the same defect, which is
 * how the unbounded `.in()` below survived in all of them at once.
 *
 * PAGINATED, because the id list is not small. A first-time sync of a property
 * with a few years of booking history generates one turnover per stay, so
 * `turnoverIds` routinely runs to thousands on an initial sync. The previous
 * `.in('id', ids)` with no bound hit PostgREST's max_rows = 1000 cap, which
 * returns 200 with no truncation signal — so every turnover past the first
 * 1000 silently never fired `turnover/created`, and therefore never got crew
 * auto-assignment, checklist application, or a guest message. Nothing errored;
 * the tail of the import simply did not exist as far as the rest of the system
 * was concerned.
 *
 * CHUNKED first, THEN paginated: `turnoverIds` is split into ID_CHUNK_SIZE
 * batches so the `.in()` list itself never grows past the gateway's URL
 * limit, and `fetchAllRows` still drains each chunk's own response in case a
 * chunk's row count (bounded to ID_CHUNK_SIZE here, since `id` is the
 * table's primary key) ever needs more than one page.
 *
 * `.order('id')` gives fetchAllRows stable page boundaries.
 */
export async function fetchTurnoverCreatedEvents(
  supabase:    ServiceClient,
  turnoverIds: string[],
  orgId:       string,
): Promise<TurnoverCreatedEvent[]> {
  if (!turnoverIds.length) return []

  const turnovers: TurnoverRow[] = []
  for (let i = 0; i < turnoverIds.length; i += ID_CHUNK_SIZE) {
    const chunk = turnoverIds.slice(i, i + ID_CHUNK_SIZE)
    const page = await fetchAllRows<TurnoverRow>(
      (from, to) => supabase
        .from('turnovers')
        .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
        .in('id', chunk)
        .order('id')
        .range(from, to),
      { label: 'turnover-created-events.turnovers' },
    )
    turnovers.push(...page)
  }

  return turnovers.map((t) => ({
    name: 'turnover/created' as const,
    data: {
      turnover_id:       t.id,
      property_id:       t.property_id,
      org_id:            orgId,
      checkout_datetime: t.checkout_datetime,
      checkin_datetime:  t.checkin_datetime,
      window_minutes:    t.window_minutes ?? 0,
    },
  }))
}
