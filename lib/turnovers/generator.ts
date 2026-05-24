import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, PriorityLevel } from '@/types/database'

type DBClient = SupabaseClient<Database>

export interface GeneratedTurnover {
  id:                string
  property_id:       string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number
  isNew:             boolean
}

/**
 * Generate turnovers for a property by examining consecutive booking pairs.
 *
 * Logic:
 *  - Sort confirmed bookings by checkin date
 *  - For each adjacent pair (A checkout → B checkin), calculate the window
 *  - If a turnover already exists for that pair, skip
 *  - Otherwise create a new turnover with appropriate priority
 *
 * Returns IDs of newly created turnovers.
 */
export async function generateTurnoversForProperty(
  propertyId: string,
  orgId:       string,
  supabase:    DBClient
): Promise<string[]> {
  // Fetch all confirmed bookings for this property, sorted by checkin
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, checkin_date, checkout_date, checkin_time, checkout_time')
    .eq('property_id', propertyId)
    .in('status', ['confirmed', 'tentative'])
    .order('checkin_date', { ascending: true })

  if (!bookings || bookings.length < 2) return []

  // Fetch property defaults for checkin/checkout times
  const { data: property } = await supabase
    .from('properties')
    .select('checkin_time, checkout_time, checklist_template_id')
    .eq('id', propertyId)
    .single()

  // Fetch the default checklist template for this property (if set)
  const { data: defaultTemplate } = await supabase
    .from('checklist_templates')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_default', true)
    .single()

  const newTurnoverIds: string[] = []

  for (let i = 0; i < bookings.length - 1; i++) {
    const outgoing = bookings[i]
    const incoming = bookings[i + 1]

    // Build datetime strings — fall back to property defaults then hardcoded defaults
    const checkoutTimeStr = outgoing.checkout_time ?? property?.checkout_time ?? '11:00'
    const checkinTimeStr  = incoming.checkin_time  ?? property?.checkin_time  ?? '15:00'

    const checkoutDT = new Date(`${outgoing.checkout_date}T${checkoutTimeStr}:00`)
    const checkinDT  = new Date(`${incoming.checkin_date}T${checkinTimeStr}:00`)

    // Skip overlapping bookings (data issue) or zero-gap situations
    if (checkinDT <= checkoutDT) continue

    const windowMinutes = Math.round(
      (checkinDT.getTime() - checkoutDT.getTime()) / 60_000
    )

    // Deduplicate — check if a turnover already exists for this exact pair
    const { data: existing } = await supabase
      .from('turnovers')
      .select('id')
      .eq('property_id', propertyId)
      .eq('booking_id', incoming.id)
      .eq('prev_booking_id', outgoing.id)
      .maybeSingle()

    if (existing) continue

    // Priority based on window size
    const priority: PriorityLevel =
      windowMinutes < 120  ? 'urgent' :
      windowMinutes < 240  ? 'high'   :
      windowMinutes < 480  ? 'medium' : 'low'

    const { data: turnover, error } = await supabase
      .from('turnovers')
      .insert({
        property_id:          propertyId,
        org_id:               orgId,
        booking_id:           incoming.id,
        prev_booking_id:      outgoing.id,
        checkout_datetime:    checkoutDT.toISOString(),
        checkin_datetime:     checkinDT.toISOString(),
        window_minutes:       windowMinutes,
        status:               'pending_assignment',
        priority,
        auto_generated:       true,
        checklist_template_id: defaultTemplate?.id ?? null,
      })
      .select('id')
      .single()

    if (!error && turnover) {
      newTurnoverIds.push(turnover.id)
    }
  }

  return newTurnoverIds
}

/**
 * When a booking is cancelled, cancel any turnovers that depended on it.
 * A turnover depends on a booking if it's the prev_booking OR the next booking.
 * If the prev booking disappears, the turnover no longer has a checkout to clean after.
 * If the next booking disappears, there's no arrival to prep for.
 */
export async function cancelTurnoversForBooking(
  bookingId: string,
  supabase:  DBClient
): Promise<void> {
  await supabase
    .from('turnovers')
    .update({ status: 'cancelled' })
    .or(`booking_id.eq.${bookingId},prev_booking_id.eq.${bookingId}`)
    .in('status', ['pending_assignment', 'assigned'])
}

/**
 * Calculate next due date for a routine maintenance schedule.
 */
export function calcNextDueDate(frequency: string, from: Date): Date {
  const next = new Date(from)
  switch (frequency) {
    case 'weekly':      next.setDate(next.getDate() + 7);          break
    case 'biweekly':    next.setDate(next.getDate() + 14);         break
    case 'monthly':     next.setMonth(next.getMonth() + 1);        break
    case 'quarterly':   next.setMonth(next.getMonth() + 3);        break
    case 'semi_annual': next.setMonth(next.getMonth() + 6);        break
    case 'annual':      next.setFullYear(next.getFullYear() + 1);  break
    default:            next.setMonth(next.getMonth() + 1);        break
  }
  return next
}
