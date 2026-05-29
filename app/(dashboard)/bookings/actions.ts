'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import type { BookingSource } from '@/types/database'

export type BookingActionState = { error?: string; success?: boolean }

// ── Create manual booking ────────────────────────────────────────────────────

export async function createBooking(
  _prev: BookingActionState | null,
  formData: FormData
): Promise<BookingActionState> {
  const { supabase, membership } = await requireOrgMember()

  const property_id   = formData.get('property_id')  as string
  const guest_name    = (formData.get('guest_name')  as string)?.trim() || null
  const guest_email   = (formData.get('guest_email') as string)?.trim() || null
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
      guest_email,
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

  if (error) return { error: error.message }

  // Fire booking/detected so Inngest auto-generates a turnover
  await inngest.send({
    name: 'booking/detected',
    data: {
      booking_id:    booking.id,
      property_id,
      org_id:        membership.org_id,
      guest_name:    guest_name ?? null,
      guest_email:   guest_email ?? null,
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
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/bookings')
  return {}
}

// ── Trigger manual iCal sync ─────────────────────────────────────────────────

export async function triggerSync(): Promise<void> {
  await inngest.send({ name: 'ical/sync.all.requested', data: {} })
}
