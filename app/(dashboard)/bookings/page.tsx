import type { Metadata } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireOrgMember } from '@/lib/auth'
import { findMaintenanceCandidatesForWindow } from '@/lib/maintenance/vacancy-suggestions'
import { BookingsClient } from './bookings-client'

export const metadata: Metadata = { title: 'Bookings' }

const GAP_THRESHOLD_DAYS = 14 // matches Phase 19's LIGHT_GAP_DAYS

export interface VacancyGap {
  property_id: string
  gap_start:   string
  gap_end:     string
  candidates:  Awaited<ReturnType<typeof findMaintenanceCandidatesForWindow>>
}

// Computed once per page load against the already-fetched booking window —
// not per-cell, not on scroll. Reuses Phase 30's candidate finder directly.
async function computeVacancyGaps(
  supabase:   SupabaseClient,
  bookings:   { property_id: string; checkin_date: string; checkout_date: string; status: string }[],
  properties: { id: string }[]
): Promise<VacancyGap[]> {
  const gaps: VacancyGap[] = []

  for (const property of properties) {
    const propertyBookings = bookings
      .filter((b) => b.property_id === property.id && b.status !== 'cancelled')
      .sort((a, b) => a.checkin_date.localeCompare(b.checkin_date))

    for (let i = 0; i < propertyBookings.length - 1; i++) {
      const checkout = propertyBookings[i]!.checkout_date
      const nextCheckin = propertyBookings[i + 1]!.checkin_date
      const gapDays = Math.round(
        (new Date(nextCheckin).getTime() - new Date(checkout).getTime()) / 86_400_000
      )
      if (gapDays < GAP_THRESHOLD_DAYS) continue

      const candidates = await findMaintenanceCandidatesForWindow(
        supabase, property.id, checkout, nextCheckin
      )
      if (candidates.length > 0) {
        gaps.push({ property_id: property.id, gap_start: checkout, gap_end: nextCheckin, candidates })
      }
    }
  }

  return gaps
}

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
        ical_feed_id, external_source,
        properties ( id, name, city, state ),
        turnovers:turnovers!turnovers_booking_id_fkey ( id, status, checkout_datetime )
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

  const vacancyGaps = await computeVacancyGaps(supabase, bookings ?? [], properties ?? [])

  return (
    <BookingsClient
      bookings={(bookings ?? []) as never}
      properties={properties ?? []}
      connections={connections ?? []}
      vacancyGaps={vacancyGaps}
    />
  )
}
