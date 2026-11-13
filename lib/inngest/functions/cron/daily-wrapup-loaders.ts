import type { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows }  from '@/lib/inngest/paginate'
import { unwrapCount }   from '@/lib/supabase/unwrap'
import { unwrapJoin }    from '@/lib/utils/supabase-joins'

// Reads added to the daily wrap-up for the "Tomorrow", "Freeze prep tonight" and
// "Done today" sections. They live beside the cron rather than inline so the
// compute step in daily-wrapup.ts keeps one job: assembling sections.
//
// Every read is bounded: paginated with fetchAllRows, or a head-only count that
// ships no rows. None of them runs inside a loop.

type ServiceClient = ReturnType<typeof createServiceClient>

export interface WrapUpArrival {
  propertyId: string
  property:   string
}

export interface WrapUpFreezeAlert {
  workOrderId: string
  title:       string
}

export interface WrapUpDoneToday {
  turnovers:  number
  workOrders: number
}

/**
 * "Today" for the done-today count, in milliseconds back from the run. The cron
 * fires at 23:00 UTC, which is 5 to 6pm across the US, and a US day starts
 * between 05:00 and 08:00 UTC, so 12 hours back lands in the small hours of the
 * PM's own day without reaching into last night.
 */
export const DONE_TODAY_WINDOW_MS = 12 * 3_600_000

/** Guest stays that begin on `checkinDate` (a calendar date, the property's local one). */
export async function loadArrivals(
  supabase: ServiceClient, orgId: string, checkinDate: string,
): Promise<WrapUpArrival[]> {
  const rows = await fetchAllRows<{
    property_id: string
    properties:  { name: string } | { name: string }[] | null
  }>(
    (from, to) => supabase
      .from('bookings')
      .select('property_id, properties ( name )')
      .eq('org_id', orgId)
      .eq('checkin_date', checkinDate)
      .eq('is_block', false)
      .eq('stay_type', 'guest_stay')
      .in('status', ['confirmed', 'tentative'])
      .order('id', { ascending: true })
      .range(from, to),
    { label: `arrivals-tomorrow(daily-wrapup)[org=${orgId}]` },
  )
  return (rows ?? []).map((r) => ({
    propertyId: r.property_id,
    property:   unwrapJoin(r.properties)?.name ?? 'Property',
  }))
}

/**
 * Work orders Freeze Watch raised for tonight, still open. The 20:00 UTC cron has
 * already done the forecast lookups and decided which properties are vacant and
 * cold, so the wrap-up reads its result instead of calling Tomorrow.io a second
 * time: that key's rate limit is shared, and a second fan-out at 23:00 UTC is
 * exactly how the first one ran into it.
 */
export async function loadFreezeAlerts(
  supabase: ServiceClient, orgId: string, tonight: string,
): Promise<WrapUpFreezeAlert[]> {
  const rows = await fetchAllRows<{ id: string; title: string }>(
    (from, to) => supabase
      .from('work_orders')
      .select('id, title')
      .eq('org_id', orgId)
      .eq('source', 'freeze_watch')
      .eq('needed_by_date', tonight)
      .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
      .order('id', { ascending: true })
      .range(from, to),
    { label: `freeze-alerts(daily-wrapup)[org=${orgId}]` },
  )
  return (rows ?? []).map((w) => ({ workOrderId: w.id, title: w.title }))
}

/** Turnovers completed and work orders closed today. Head-only counts: no rows are read. */
export async function loadDoneToday(
  supabase: ServiceClient, orgId: string, completedSinceIso: string, todayDate: string,
): Promise<WrapUpDoneToday> {
  const [turnoversRes, workOrdersRes] = await Promise.all([
    supabase
      .from('turnovers')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'completed')
      .gte('completed_at', completedSinceIso),
    supabase
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('status', 'completed')
      .gte('completed_date', todayDate),
  ])
  return {
    turnovers:  unwrapCount(turnoversRes,  { site: 'inngest.daily-wrapup.doneTurnovers',  orgId }),
    workOrders: unwrapCount(workOrdersRes, { site: 'inngest.daily-wrapup.doneWorkOrders', orgId }),
  }
}
