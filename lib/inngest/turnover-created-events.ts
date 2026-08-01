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
 * `.order('id')` gives fetchAllRows stable page boundaries.
 */
export async function fetchTurnoverCreatedEvents(
  supabase:    ServiceClient,
  turnoverIds: string[],
  orgId:       string,
): Promise<TurnoverCreatedEvent[]> {
  if (!turnoverIds.length) return []

  const turnovers = await fetchAllRows<TurnoverRow>(
    (from, to) => supabase
      .from('turnovers')
      .select('id, property_id, checkout_datetime, checkin_datetime, window_minutes')
      .in('id', turnoverIds)
      .order('id')
      .range(from, to),
    { label: 'turnover-created-events.turnovers' },
  )

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
