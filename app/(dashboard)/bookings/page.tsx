import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { BookingsClient } from './bookings-client'

export const metadata: Metadata = { title: 'Bookings' }

export default async function BookingsPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch bookings: 60 days back → 180 days forward
  const from = new Date()
  from.setDate(from.getDate() - 60)
  const to = new Date()
  to.setDate(to.getDate() + 180)

  const [
    { data: bookings, error: bookingsError },
    { data: properties },
    { data: connections },
  ] = await Promise.all([
    supabase
      .from('bookings')
      .select(`
        id, property_id, guest_name, guest_email,
        checkin_date, checkout_date, checkin_time, checkout_time,
        source, status, notes, has_overlap_conflict, created_at,
        properties ( id, name, city, state ),
        turnovers:turnovers!turnovers_booking_id_fkey ( id, status )
      `)
      .eq('org_id', membership.org_id)
      .gte('checkout_date', from.toISOString().split('T')[0])
      .lte('checkin_date',  to.toISOString().split('T')[0])
      .order('checkin_date', { ascending: true }),

    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('integration_connections')
      .select('provider_id, status, last_used_at, metadata')
      .eq('org_id', membership.org_id),
  ])

  if (bookingsError) {
    console.error('[BookingsPage] Failed to fetch bookings:', bookingsError.message)
  }

  return (
    <BookingsClient
      bookings={(bookings ?? []) as never}
      properties={properties ?? []}
      connections={connections ?? []}
    />
  )
}
