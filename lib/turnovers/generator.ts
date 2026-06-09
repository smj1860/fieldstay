import type { SupabaseClient } from '@supabase/supabase-js'
import type { PriorityLevel } from '@/types/database'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DBClient = SupabaseClient<any>

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

  // Prefetch all existing turnover pairs for this property in one query
  // instead of one query per booking pair (O(N) → O(1) dedup lookup)
  const { data: existingTurnovers } = await supabase
    .from('turnovers')
    .select('booking_id, prev_booking_id')
    .eq('property_id', propertyId)

  const existingPairs = new Set(
    (existingTurnovers ?? []).map((t) => `${t.prev_booking_id}:${t.booking_id}`)
  )

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

    // Deduplicate using prefetched set — O(1) vs O(N) round-trips
    if (existingPairs.has(`${outgoing.id}:${incoming.id}`)) continue

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

      // Snapshot the default checklist into an instance for this turnover
      if (defaultTemplate?.id) {
        const { data: sections } = await supabase
          .from('checklist_template_sections')
          .select(`
            id, name, sort_order,
            checklist_template_items ( id, task, requires_photo, notes, sort_order )
          `)
          .eq('template_id', defaultTemplate.id)
          .order('sort_order', { ascending: true })

        if (sections && sections.length > 0) {
          const { data: instance } = await supabase
            .from('checklist_instances')
            .insert({
              turnover_id:       turnover.id,
              org_id:            orgId,
              template_id:       defaultTemplate.id,
              template_snapshot: sections,
              status:            'not_started',
            })
            .select('id')
            .single()

          if (instance) {
            const items = sections.flatMap((section) =>
              (section.checklist_template_items ?? []).map((item: {
                task: string; requires_photo: boolean; notes: string | null; sort_order: number
              }) => ({
                instance_id:    instance.id,
                section_name:   section.name,
                task:           item.task,
                requires_photo: item.requires_photo,
                notes:          item.notes,
                sort_order:     item.sort_order,
                is_completed:   false,
              }))
            )
            if (items.length > 0) {
              await supabase.from('checklist_instance_items').insert(items)
            }
          }
        }
      }
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
