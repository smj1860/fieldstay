import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { unwrapList, tryUnwrap } from '@/lib/supabase/unwrap'

/**
 * PAR pass 2, learning side: turn a submitted inventory count into consumption
 * observations, so smart pars stop being pure formula and start reflecting what
 * a property actually goes through.
 *
 * The observation is the DROP between two consecutive counts of the same item
 * at the same property, over the guest-nights that happened in between.
 *
 * Read from the COUNT SESSIONS, never from inventory_items.current_quantity.
 * The sibling handler (handleInventoryCountSubmitted) overwrites
 * current_quantity from the same event, so reading it here would be a race
 * whose outcome depends on which Inngest function ran first — and would
 * silently produce a consumption of zero whenever the sibling won.
 *
 * A RISE IS NOT NEGATIVE CONSUMPTION. If the count went up, someone restocked
 * between the two counts, and nothing in the schema records how much. The real
 * consumption is (previous + restocked - current), and with the middle term
 * unknown the sample is unrecoverable, not zero. Those items are skipped:
 * a wrong sample is worse than a missing one, because the mean keeps it
 * forever.
 *
 * THE UNIT IS PER CAPACITY-NIGHT, not per actual guest-night. bookings carries
 * no guest-count column anywhere in this schema, so real occupancy is not
 * observable. Dividing by occupied_nights * max_guests keeps the round trip
 * self-consistent, because resolvePar()'s historical branch multiplies by that
 * same max_guests — the proxy cancels out. See 20260811150000.
 */

const ITEM_CAP    = 5_000
const BOOKING_CAP = 500

interface CountRow { id: string; submitted_at: string; property_id: string }
interface CountItemRow { inventory_item_id: string; quantity_counted: number }
interface BookingRow { checkin_date: string; checkout_date: string }

export interface RecordConsumptionResult {
  recorded: number
  /** Why nothing was recorded, when nothing was. Surfaced for the log — these
   *  are all ordinary states, not failures. */
  reason?: 'no_previous_count' | 'no_occupied_nights' | 'no_positive_deltas' | 'no_property'
}

/** Nights of overlap between a booking and the window between two counts.
 *  Dates are half-open (checkout day is not a night), matching how a stay
 *  actually occupies a property. */
function overlapNights(b: BookingRow, fromISO: string, toISO: string): number {
  const from = new Date(fromISO).getTime()
  const to   = new Date(toISO).getTime()
  const inMs  = Math.max(new Date(b.checkin_date).getTime(), from)
  const outMs = Math.min(new Date(b.checkout_date).getTime(), to)
  if (outMs <= inMs) return 0
  return Math.round((outMs - inMs) / 86_400_000)
}

export async function recordConsumptionFromCount(
  supabase: SupabaseClient,
  scope: { countId: string; propertyId: string; orgId: string },
): Promise<RecordConsumptionResult> {
  const { countId, propertyId, orgId } = scope
  const ctx = { site: 'lib.inventory.recordConsumptionFromCount', orgId }

  const currRes = await supabase
    .from('inventory_counts')
    .select('id, submitted_at, property_id')
    .eq('id', countId)
    .eq('org_id', orgId)
    .maybeSingle()
  const curr = tryUnwrap<CountRow>(currRes, ctx)
  if (!curr.ok || !curr.data) return { recorded: 0, reason: 'no_previous_count' }

  // The immediately preceding count for this property. Scoped by org as well
  // as property so a forged count_id cannot walk another tenant's history.
  const prevRes = await supabase
    .from('inventory_counts')
    .select('id, submitted_at, property_id')
    .eq('property_id', propertyId)
    .eq('org_id', orgId)
    .lt('submitted_at', curr.data.submitted_at)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const prev = tryUnwrap<CountRow>(prevRes, ctx)
  if (!prev.ok || !prev.data) return { recorded: 0, reason: 'no_previous_count' }

  const propRes = await supabase
    .from('properties')
    .select('max_guests')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .maybeSingle()
  const prop = tryUnwrap<{ max_guests: number | null }>(propRes, ctx)
  if (!prop.ok || !prop.data) return { recorded: 0, reason: 'no_property' }
  // Same fallback the resolver uses for an unset capacity, so the two stay
  // consistent when a property's metadata is incomplete.
  const capacity = prop.data.max_guests && prop.data.max_guests > 0 ? prop.data.max_guests : 2

  const bookingsRes = await supabase
    .from('bookings')
    .select('checkin_date, checkout_date')
    .eq('property_id', propertyId)
    .eq('org_id', orgId)
    .eq('status', 'confirmed')
    .eq('is_block', false)
    .lt('checkin_date', curr.data.submitted_at)
    .gt('checkout_date', prev.data.submitted_at)
    .limit(BOOKING_CAP)
  const bookings = unwrapList<BookingRow>(bookingsRes, ctx)

  const occupiedNights = bookings.reduce(
    (sum, b) => sum + overlapNights(b, prev.data!.submitted_at, curr.data!.submitted_at), 0)

  // No stays between the counts means whatever moved was not guest-driven —
  // a PM tidying, a crew restock, a miscount. Recording it would teach the
  // engine that an empty property consumes towels.
  if (occupiedNights <= 0) return { recorded: 0, reason: 'no_occupied_nights' }

  const guestNights = occupiedNights * capacity

  const [prevItemsRes, currItemsRes] = await Promise.all([
    supabase.from('inventory_count_items').select('inventory_item_id, quantity_counted')
      .eq('count_id', prev.data.id).limit(ITEM_CAP),
    supabase.from('inventory_count_items').select('inventory_item_id, quantity_counted')
      .eq('count_id', curr.data.id).limit(ITEM_CAP),
  ])
  const prevItems = unwrapList<CountItemRow>(prevItemsRes, ctx)
  const currItems = unwrapList<CountItemRow>(currItemsRes, ctx)

  const prevByItem = new Map(prevItems.map((i) => [i.inventory_item_id, i.quantity_counted]))

  const samples = currItems.flatMap((c) => {
    const before = prevByItem.get(c.inventory_item_id)
    if (before === undefined) return []            // not counted last time
    const consumed = before - c.quantity_counted
    if (consumed <= 0) return []                   // restocked, or untouched
    return [{
      inventory_item_id: c.inventory_item_id,
      org_id:            orgId,
      rate:              consumed / guestNights,
      sampled_at:        curr.data!.submitted_at,
    }]
  })

  if (!samples.length) return { recorded: 0, reason: 'no_positive_deltas' }

  const { data, error } = await supabase.rpc('record_consumption_samples', { p_rows: samples })
  if (error) throw error

  return { recorded: Number(data ?? 0) }
}
