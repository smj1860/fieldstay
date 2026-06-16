'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import type { BookingSource } from '@/types/database'

export type BookingActionState = { error?: string; success?: boolean }

// ── Create manual booking ────────────────────────────────────────────────────

export async function createBooking(
  _prev: BookingActionState | null,
  formData: FormData
): Promise<BookingActionState> {
  const { user, supabase, membership } = await requireOrgMember()

  const property_id   = formData.get('property_id')  as string
  const guest_name    = (formData.get('guest_name')  as string)?.trim() || null
  const checkin_date  = formData.get('checkin_date') as string
  const checkout_date = formData.get('checkout_date') as string
  const source        = (formData.get('source') as BookingSource) || 'manual'
  const notes         = (formData.get('notes') as string)?.trim() || null

  if (!property_id)   return { error: 'Property is required' }
  if (!checkin_date)  return { error: 'Check-in date is required' }
  if (!checkout_date) return { error: 'Check-out date is required' }
  if (checkout_date <= checkin_date) return { error: 'Check-out must be after check-in' }

  // Verify property belongs to this org
  const { data: property } = await supabase
    .from('properties')
    .select('id, name, checkin_time, checkout_time')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  const { data: booking, error } = await supabase
    .from('bookings')
    .insert({
      property_id,
      org_id:       membership.org_id,
      guest_name,
      checkin_date,
      checkout_date,
      checkin_time:  property.checkin_time  ?? null,
      checkout_time: property.checkout_time ?? null,
      source,
      status:        'confirmed',
      notes,
    })
    .select('id')
    .single()

  if (error) {
    // bookings_manual_dates_unique — double-submit or network retry
    if (error.code === '23505') {
      return { error: 'A booking already exists for these dates at this property.' }
    }
    console.error('[createBooking]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'booking.created',
    targetType: 'booking',
    targetId:   booking.id,
    metadata:   { property_id, checkin_date, checkout_date, source, guest_name },
  })

  // Fire booking/detected so Inngest auto-generates a turnover
  await inngest.send({
    name: 'booking/detected',
    data: {
      booking_id:    booking.id,
      property_id,
      org_id:        membership.org_id,
      guest_name:    guest_name ?? null,
      guest_email:   null,
      checkin_date,
      checkout_date,
    },
  })

  revalidatePath('/bookings')
  revalidatePath('/turnovers')
  return { success: true }
}

// ── Cancel / delete booking ──────────────────────────────────────────────────

export async function cancelBooking(
  bookingId: string
): Promise<{ error?: string }> {
  const { user, supabase, membership } = await requireOrgMember()

  // 1. Cancel the booking
  const { error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[cancelBooking]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'booking.cancelled',
    targetType: 'booking',
    targetId:   bookingId,
  })

  // 2. Cancel pending/assigned turnovers tied to this booking
  await supabase
    .from('turnovers')
    .update({ status: 'cancelled' })
    .eq('booking_id', bookingId)
    .eq('org_id', membership.org_id)
    .in('status', ['pending_assignment', 'assigned'])

  // 3. Post a revenue reversal if a booking revenue transaction exists.
  //    Soft reversal (new expense row) preserves the audit trail. Uses a
  //    distinct `source` so it doesn't collide with the original
  //    UNIQUE(source_reference_id, source) row.
  const { data: txn } = await supabase
    .from('owner_transactions')
    .select('id, amount, property_id')
    .eq('source_reference_id', bookingId)
    .in('source', ['booking_revenue', 'uplisting_booking'])
    .maybeSingle()

  if (txn) {
    const { count } = await supabase
      .from('owner_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('source_reference_id', bookingId)
      .eq('source', 'booking_cancellation')

    if ((count ?? 0) === 0) {
      await supabase.from('owner_transactions').insert({
        property_id:         txn.property_id,
        org_id:              membership.org_id,
        source:              'booking_cancellation',
        source_reference_id: bookingId,
        transaction_type:    'expense',
        category:            'booking_revenue',
        amount:              txn.amount,
        description:         'Booking cancelled — revenue reversal',
        transaction_date:    new Date().toISOString().split('T')[0],
        visible_to_owner:    true,
      })
    }
  }

  revalidatePath('/bookings')
  revalidatePath('/turnovers')
  return {}
}

// ── Trigger manual iCal sync ─────────────────────────────────────────────────

export async function triggerSync(): Promise<void> {
  await inngest.send({ name: 'ical/sync.all.requested', data: {} })
}
