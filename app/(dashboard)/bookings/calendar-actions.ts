'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'

export async function updateBookingDates(
  bookingId: string,
  newCheckin: string,
  newCheckout: string
): Promise<{ success?: boolean; error?: string }> {
  const { user, supabase, membership } = await requireOrgMember()

  if (newCheckout <= newCheckin) {
    return { error: 'Check-out must be after check-in' }
  }

  // Re-fetch provenance server-side — the client-side drag already
  // happened, but this is the authoritative gate. A booking synced from
  // OwnerRez (external_source) or an iCal feed (ical_feed_id) is not
  // owned by FieldStay; saving a drag here would silently diverge from
  // the real reservation until the next sync overwrites it with no
  // indication to the PM that their change was never real.
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, property_id, ical_feed_id, external_source')
    .eq('id', bookingId)
    .eq('org_id', membership.org_id)
    .single()

  if (!booking) return { error: 'Booking not found' }
  if (booking.ical_feed_id !== null || booking.external_source !== null) {
    return { error: 'This booking is synced from an external source and cannot be edited here' }
  }

  const { error } = await supabase
    .from('bookings')
    .update({ checkin_date: newCheckin, checkout_date: newCheckout })
    .eq('id', bookingId)

  if (error) {
    // bookings_manual_dates_unique — dropped onto dates another manual
    // booking already occupies at this property
    if (error.code === '23505') {
      return { error: 'A booking already exists for these dates at this property.' }
    }
    console.error('[updateBookingDates]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'booking.dates_updated',
    targetType: 'booking',
    targetId:   bookingId,
    metadata:   { checkin_date: newCheckin, checkout_date: newCheckout },
  })

  // Authoritative server-side conflict re-check, regardless of the
  // client-side pre-check already done in moveResizeValidator
  await detectAndFlagOverlaps(supabase, booking.property_id)

  revalidatePath('/bookings')
  return { success: true }
}
