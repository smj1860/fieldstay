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

export async function generateTurnoversForProperty(
  propertyId: string,
  orgId:       string,
  supabase:    DBClient
): Promise<string[]> {
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, checkin_date, checkout_date, checkin_time, checkout_time')
    .eq('property_id', propertyId)
    .in('status', ['confirmed', 'tentative'])
    .order('checkin_date', { ascending: true })
  if (!bookings?.length) return []
  // Use maybeSingle() — .single() errors when 0 rows, causing the step to throw
  const { data: property } = await supabase
    .from('properties')
    .select('checkin_time, checkout_time, checklist_template_id')
    .eq('id', propertyId)
    .maybeSingle()
  const { data: defaultTemplate } = await supabase
    .from('checklist_templates')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_default', true)
    .maybeSingle()
  const { data: existingTurnovers } = await supabase
    .from('turnovers')
    .select('booking_id, prev_booking_id')
    .eq('property_id', propertyId)
  const existingPairs = new Set(
    (existingTurnovers ?? [])
      .filter(t => t.prev_booking_id != null)
      .map(t => `${t.prev_booking_id}:${t.booking_id}`)
  )
  const existingStandalones = new Set(
    (existingTurnovers ?? [])
      .filter(t => t.prev_booking_id == null && t.booking_id != null)
      .map(t => t.booking_id as string)
  )
  const newTurnoverIds: string[] = []
  const DEFAULT_WINDOW_HOURS = 4
  // ── PASS 1: Standalone turnover for every checkout ──────────────
  // Ensures every booking gets a clean regardless of whether a next
  // booking exists. Pass 2 upgrades these to precise pairs.
  for (const booking of bookings) {
    if (existingStandalones.has(booking.id)) continue
    const alreadyPaired = (existingTurnovers ?? []).some(
      t => t.booking_id === booking.id && t.prev_booking_id != null
    )
    if (alreadyPaired) continue
    const checkoutTimeStr = (booking.checkout_time ?? property?.checkout_time ?? '11:00').slice(0, 5)
    const checkoutDT      = new Date(`${booking.checkout_date}T${checkoutTimeStr}:00`)
    if (isNaN(checkoutDT.getTime())) {
      console.error('[generator] invalid date in Pass 1', {
        propertyId, checkout_date: booking.checkout_date, checkoutTimeStr,
      })
      continue
    }
    const checkinDT       = new Date(checkoutDT.getTime() + DEFAULT_WINDOW_HOURS * 3_600_000)
    const windowMinutes   = DEFAULT_WINDOW_HOURS * 60
    const { data: turnover, error } = await supabase
      .from('turnovers')
      .insert({
        property_id:           propertyId,
        org_id:                orgId,
        booking_id:            booking.id,
        prev_booking_id:       null,
        checkout_datetime:     checkoutDT.toISOString(),
        checkin_datetime:      checkinDT.toISOString(),
        window_minutes:        windowMinutes,
        status:                'pending_assignment',
        priority:              'medium' as const,
        auto_generated:        true,
        checklist_template_id: defaultTemplate?.id ?? null,
      })
      .select('id')
      .single()
    if (error) {
      // 23505 = unique_violation: concurrent worker already inserted this standalone.
      // The new turnovers_standalone_unique partial index makes this safe to ignore.
      if (error.code !== '23505') {
        console.error('[generator] Pass 1 insert error', { propertyId, bookingId: booking.id, code: error.code, msg: error.message })
      }
      continue
    }
    if (turnover) {
      newTurnoverIds.push(turnover.id)
      existingStandalones.add(booking.id)
      await snapshotChecklist(supabase, turnover.id, orgId, defaultTemplate?.id ?? null)
    }
  }
  // ── PASS 2: Upgrade standalone → precise pair ────────────────────
  // When a next booking exists, update the standalone with real times.
  for (let i = 0; i < bookings.length - 1; i++) {
    const outgoing = bookings[i]!
    const incoming = bookings[i + 1]!
    if (existingPairs.has(`${outgoing.id}:${incoming.id}`)) continue
    // Slice to 5 chars ('HH:MM') to handle both 'HH:MM' and 'HH:MM:SS' storage formats
    const checkoutTimeStr = (outgoing.checkout_time ?? property?.checkout_time ?? '11:00').slice(0, 5)
    const checkinTimeStr  = (incoming.checkin_time  ?? property?.checkin_time  ?? '15:00').slice(0, 5)
    const checkoutDT = new Date(`${outgoing.checkout_date}T${checkoutTimeStr}:00`)
    const checkinDT  = new Date(`${incoming.checkin_date}T${checkinTimeStr}:00`)
    if (isNaN(checkoutDT.getTime()) || isNaN(checkinDT.getTime())) {
      console.error('[generator] invalid date constructed', {
        propertyId, checkout_date: outgoing.checkout_date, checkoutTimeStr,
        checkin_date: incoming.checkin_date, checkinTimeStr,
      })
      continue
    }
    if (checkinDT <= checkoutDT) continue
    const windowMinutes = Math.round(
      (checkinDT.getTime() - checkoutDT.getTime()) / 60_000
    )
    const priority: PriorityLevel =
      windowMinutes < 120  ? 'urgent' :
      windowMinutes < 240  ? 'high'   :
      windowMinutes < 480  ? 'medium' : 'low'
    if (existingStandalones.has(outgoing.id)) {
      // Upgrade existing standalone to a precise pair
      await supabase
        .from('turnovers')
        .update({
          booking_id:       incoming.id,
          prev_booking_id:  outgoing.id,
          checkin_datetime: checkinDT.toISOString(),
          window_minutes:   windowMinutes,
          priority,
        })
        .eq('booking_id',      outgoing.id)
        .is('prev_booking_id', null)
        .eq('property_id',     propertyId)
      existingPairs.add(`${outgoing.id}:${incoming.id}`)
    } else {
      // Insert a fresh pair turnover
      const { data: turnover, error } = await supabase
        .from('turnovers')
        .insert({
          property_id:           propertyId,
          org_id:                orgId,
          booking_id:            incoming.id,
          prev_booking_id:       outgoing.id,
          checkout_datetime:     checkoutDT.toISOString(),
          checkin_datetime:      checkinDT.toISOString(),
          window_minutes:        windowMinutes,
          status:                'pending_assignment',
          priority,
          auto_generated:        true,
          checklist_template_id: defaultTemplate?.id ?? null,
        })
        .select('id')
        .single()
      if (error) {
        // 23505 = unique_violation: concurrent worker already inserted this pair
        // (covered by the existing turnovers_booking_pair_unique partial index).
        if (error.code !== '23505') {
          console.error('[generator] Pass 2 insert error', { propertyId, code: error.code, msg: error.message })
        }
      } else if (turnover) {
        newTurnoverIds.push(turnover.id)
        await snapshotChecklist(supabase, turnover.id, orgId, defaultTemplate?.id ?? null)
      }
    }
  }
  return newTurnoverIds
}

export async function snapshotChecklist(
  supabase:   DBClient,
  turnoverID: string,
  orgId:      string,
  templateId: string | null
): Promise<void> {
  if (!templateId) return
  const { data: sections } = await supabase
    .from('checklist_template_sections')
    .select(`id, name, sort_order,
      checklist_template_items ( id, task, requires_photo, notes, sort_order )`)
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true })
  if (!sections?.length) return
  const { data: instance } = await supabase
    .from('checklist_instances')
    .insert({ turnover_id: turnoverID, org_id: orgId, template_id: templateId,
              template_snapshot: sections, status: 'not_started' })
    .select('id').single()
  if (!instance) return
  const items = sections.flatMap((section) =>
    (section.checklist_template_items ?? []).map((item: {
      task: string; requires_photo: boolean; notes: string | null; sort_order: number
    }) => ({
      instance_id: instance.id, section_name: section.name,
      task: item.task, requires_photo: item.requires_photo,
      notes: item.notes, sort_order: item.sort_order, is_completed: false,
    }))
  )
  if (items.length > 0) await supabase.from('checklist_instance_items').insert(items)
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
