import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'

/**
 * Resolving `work_orders.needed_by_date` — the date the PM needs the work done BY.
 *
 * WHY THIS IS DERIVED RATHER THAN TYPED. For a short-term-rental operator the
 * real deadline is almost never a date somebody picks out of the air: it is the
 * next guest's arrival. Asking the PM to type it means the field is either left
 * blank or filled with a guess, and in both cases the vendor on-time metric that
 * measures against it is measuring nothing. Defaulting it from the next booking
 * makes the number TRUE at no cost to whoever is filling in the form, which is
 * the same reasoning that keeps properties.seasonal_profile derived from the ZIP
 * rather than classified by hand.
 *
 * It is a DEFAULT, not a rule. The PM can clear it or change it, and a property
 * with no upcoming booking gets null rather than a fabricated date.
 */

/**
 * The property's next confirmed arrival, as a `YYYY-MM-DD` date string, or null.
 *
 * `checkin_date > today`, strictly: a guest arriving TODAY is not a deadline a
 * work order can still be scheduled against, and offering it would have the
 * create form propose a date that is already unmeetable.
 *
 * Only `confirmed` bookings count. `tentative` is not a commitment, `cancelled`
 * is the opposite of one, and `blocked` is an owner hold rather than an arrival —
 * none of the three is a guest whose stay the work has to be finished before.
 */
export async function resolveNeededByFromNextBooking(
  supabase:   SupabaseClient,
  orgId:      string,
  propertyId: string,
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10)

  // .maybeSingle() over .limit(1), so the read is bounded by construction and a
  // second row would be an error rather than a silently-ignored one.
  const { data, error } = await supabase
    .from('bookings')
    .select('checkin_date')
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .eq('status', 'confirmed')
    .gt('checkin_date', today)
    .order('checkin_date', { ascending: true })
    .limit(1)
    .maybeSingle()

  // A failed lookup must not fail work-order creation: the default is a
  // convenience, and refusing to create the work order because we could not
  // read the booking calendar would trade a missing date for a missing work
  // order. Reported rather than swallowed, so the degradation is visible.
  if (error) {
    reportError(error, {
      site:  'lib.work-orders.needed-by.resolveNeededByFromNextBooking',
      orgId,
      level: 'warning',
    })
    return null
  }

  return data?.checkin_date ?? null
}

/**
 * The needed-by date for a new work order: what the PM typed, else the next
 * booking's check-in.
 *
 * An explicitly supplied date always wins, including over a nearer booking — a
 * PM who typed a date meant it. Only an ABSENT value is derived; this never
 * overrules a human, the same distinction properties.seasonal_profile draws
 * between an empty override and a deliberate one.
 */
export async function resolveNeededByDate(
  supabase:   SupabaseClient,
  orgId:      string,
  propertyId: string,
  supplied:   string | null,
): Promise<{ date: string | null; derived: boolean }> {
  if (supplied) return { date: supplied, derived: false }
  if (!propertyId) return { date: null, derived: false }

  const next = await resolveNeededByFromNextBooking(supabase, orgId, propertyId)
  return { date: next, derived: next !== null }
}
