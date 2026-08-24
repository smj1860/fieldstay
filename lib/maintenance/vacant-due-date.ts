import type { SupabaseClient } from '@supabase/supabase-js'
import { deriveVacancyGaps, monthBounds, pickVacantDayInMonth } from './gaps'
import type { BookingWindow } from './gaps'

/**
 * Bookings that mean the property is occupied.
 *
 * The SAME two the vacancy-gap cron uses, deliberately. `blocked` is absent
 * from both: this codebase already treats an explicit owner block as a vacancy
 * WINDOW rather than an occupancy (see vacancy-suggestions.ts's Phase 30 path,
 * which exists to schedule maintenance into exactly those), so counting it as
 * occupied here would make the same block mean opposite things in two places.
 */
const OCCUPYING_STATUSES = ['confirmed', 'tentative'] as const

/**
 * A ceiling on bookings read for one property-month. A month holds at most 31
 * same-day turnovers, so anything approaching this is a data fault; the read is
 * bounded because an unbounded one is never acceptable, not because the number
 * is expected to bind.
 */
const MAX_BOOKINGS_PER_MONTH = 200

/** How far past the last checkout to call the property free. Clamped to the
 *  month by `pickVacantDayInMonth` regardless, so this only has to exceed 31. */
const OPEN_ENDED_DAYS = 62

/**
 * Moves a due date onto a day the property is actually empty.
 *
 * An inspection is a walk-through: somebody has to be inside for an hour with a
 * camera. Landing an occurrence in the middle of a guest's stay produces a
 * notification a PM can only reschedule, every time, forever — the recurrence
 * puts it back next quarter.
 *
 * WITHIN THE DUE MONTH AND NEVER OUTSIDE IT. `calcNextDueDate` steps whole
 * months from the previous due date, so the calendar month IS this codebase's
 * recurrence anchor — there is no separate anchor column. Nudging March 30th to
 * April 2nd would re-anchor the series to April, and the one after to July.
 * See `pickVacantDayInMonth`.
 *
 * FAILS SOFT, always returning a usable date. The occurrence itself is the
 * deliverable; the nudge is a convenience, and a property with no bookings on
 * file (a new one, a channel not yet connected) correctly gets its date back
 * unchanged.
 */
export async function nudgeDueDateIntoVacancy(
  supabase:   SupabaseClient,
  orgId:      string,
  propertyId: string,
  target:     string,
): Promise<string> {
  const { first, last } = monthBounds(target)

  // Overlap, not containment: a booking that starts in the prior month and ends
  // in this one occupies the first days of it, and a containment filter would
  // miss it and call those days free.
  const { data, error } = await supabase
    .from('bookings')
    .select('checkin_date, checkout_date')
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .in('status', OCCUPYING_STATUSES)
    .lte('checkin_date', last)
    .gte('checkout_date', first)
    .limit(MAX_BOOKINGS_PER_MONTH)

  if (error) {
    // Reported and swallowed. Failing the schedule advance over a scheduling
    // nicety would trade a real occurrence for a better date.
    console.warn('[nudgeDueDateIntoVacancy] booking lookup failed:', error.message)
    return target
  }

  const gaps = deriveVacancyGaps(
    (data ?? []) as BookingWindow[],
    OPEN_ENDED_DAYS,
    // The month may open before the first booking of it — the most vacant a
    // property gets, and without this it would produce no gap at all.
    first,
  )
  return pickVacantDayInMonth(target, gaps)
}
