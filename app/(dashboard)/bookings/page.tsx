import type { Metadata } from 'next'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { requireOrgMember } from '@/lib/auth'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import type { MaintenanceCandidate } from '@/lib/maintenance/vacancy-suggestions'
import { BookingsClient } from './bookings-client'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Bookings' }

const GAP_THRESHOLD_DAYS = 14 // matches Phase 19's LIGHT_GAP_DAYS
const LOOKAHEAD_DAYS     = 90 // matches findMaintenanceCandidatesForWindow's cap

export interface VacancyGap {
  property_id: string
  gap_start:   string
  gap_end:     string
  candidates:  MaintenanceCandidate[]
}

export interface ScheduleRow {
  id:                 string
  property_id:        string
  name:               string
  next_due_date:      string | null
  estimated_cost:     number | null
  assigned_vendor_id: string | null
  active_from_month:  number | null
  active_to_month:    number | null
}

// Computed once per page load against the already-fetched booking window —
// not per-cell, not on scroll. Every property's maintenance_schedules is
// batch-fetched by the caller up front (mirrors the cron fix in
// lib/inngest/functions/cron/maintenance-schedules.ts), so this does zero
// DB round trips instead of one query per gap.
export function computeVacancyGaps(
  bookings:            { property_id: string; checkin_date: string; checkout_date: string; status: string }[],
  properties:          { id: string }[],
  schedulesByProperty: Map<string, ScheduleRow[]>,
): VacancyGap[] {
  const gaps: VacancyGap[] = []

  for (const property of properties) {
    const propertyBookings = bookings
      .filter((b) => b.property_id === property.id && b.status !== 'cancelled')
      .sort((a, b) => a.checkin_date.localeCompare(b.checkin_date))
    const schedules = schedulesByProperty.get(property.id) ?? []

    for (let i = 0; i < propertyBookings.length - 1; i++) {
      const checkout = propertyBookings[i]!.checkout_date
      const nextCheckin = propertyBookings[i + 1]!.checkin_date
      const gapDays = Math.round(
        (new Date(nextCheckin).getTime() - new Date(checkout).getTime()) / 86_400_000
      )
      if (gapDays < GAP_THRESHOLD_DAYS) continue

      const capMs         = new Date(checkout).getTime() + LOOKAHEAD_DAYS * 86_400_000
      const effectiveEnd  = new Date(Math.min(new Date(nextCheckin).getTime(), capMs))
        .toISOString().split('T')[0]!

      const candidates: MaintenanceCandidate[] = schedules
        .filter((s) =>
          s.next_due_date !== null &&
          s.next_due_date <= effectiveEnd &&
          isMaintenanceItemActiveThisMonth(s.active_from_month, s.active_to_month)
        )
        .map((s) => ({
          id:                 s.id,
          name:               s.name,
          next_due_date:      s.next_due_date!,
          estimated_cost:     s.estimated_cost,
          assigned_vendor_id: s.assigned_vendor_id,
        }))

      if (candidates.length > 0) {
        gaps.push({ property_id: property.id, gap_start: checkout, gap_end: nextCheckin, candidates })
      }
    }
  }

  return gaps
}

/**
 * The subset of the bookings select this PAGE reads directly. The full row
 * (embeds included) is handed to BookingsClient, which types it itself — this
 * exists so computeVacancyGaps gets a real shape instead of a bare Record,
 * which is what a loose generic on the paginated read silently produced.
 */
interface BookingRow {
  property_id:   string
  checkin_date:  string
  checkout_date: string
  status:        string
}

export default async function BookingsPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch bookings: 60 days back → 180 days forward
  const from = new Date()
  from.setDate(from.getDate() - 60)
  const to = new Date()
  to.setDate(to.getDate() + 180)

  const [
    bookings,
    { data: properties, error: propertiesError },
    { data: connections, error: connectionsError },
  ] = await Promise.all([
    // PAGINATED. The date window bounds the DAYS, not the row count: this is a
    // cross product of properties x bookings-in-window. A 240-day window (60
    // back, 180 forward) over a 100-property portfolio at ~7-night stays is
    // roughly 3,400 rows, comfortably past PostgREST's max_rows = 1000 — and
    // the survivors would be an arbitrary prefix, so the calendar would simply
    // omit stays with no indication anything was missing.
    //
    // Also replaces a silent failure: the previous `if (bookingsError)` branch
    // only console.error'd and rendered an empty calendar, which is exactly the
    // "an outage must not look like empty data" case the comment below it
    // warns about. fetchAllRows throws, landing in the segment's error.tsx.
    //
    // Callback params are named rangeFrom/rangeTo deliberately — `from` and
    // `to` above are the DATE bounds used inside this same callback, and the
    // conventional (from, to) would shadow them.
    fetchAllRows<BookingRow>(
      (rangeFrom, rangeTo) => supabase
      .from('bookings')
      .select(`
        id, property_id, guest_name, guest_email,
        checkin_date, checkout_date, checkin_time, checkout_time,
        source, status, notes, has_overlap_conflict, created_at,
        ical_feed_id, external_source, stay_type,
        properties ( id, name, city, state ),
        turnovers:turnovers!turnovers_booking_id_fkey ( id, status, checkout_datetime )
      `)
      .eq('org_id', membership.org_id)
      .gte('checkout_date', from.toISOString().split('T')[0])
      .lte('checkin_date',  to.toISOString().split('T')[0])
      .order('checkin_date', { ascending: true })
      .range(rangeFrom, rangeTo),
      { label: 'page.bookings.bookings' },
    ),

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

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.bookings', orgId: membership.org_id }, propertiesError, connectionsError)

  const propertyIds = (properties ?? []).map((p) => p.id)

  // Paginated: ONE-TO-MANY over this org's properties, so the row count scales
  // with properties x schedules-per-property rather than with a single parent.
  // A truncated read silently drops maintenance off the later properties'
  // booking calendar — the page renders as though they have none scheduled.
  const allSchedules = propertyIds.length
    ? await fetchAllRows<ScheduleRow>(
        (from, to) => supabase
          .from('maintenance_schedules')
          .select('id, property_id, name, next_due_date, estimated_cost, assigned_vendor_id, active_from_month, active_to_month')
          .in('property_id', propertyIds)
          .eq('is_active', true)
          .order('id')
          .range(from, to),
        { label: 'page.bookings.maintenanceSchedules' },
      )
    : []

  const schedulesByProperty = new Map<string, ScheduleRow[]>()
  for (const schedule of allSchedules) {
    const existing = schedulesByProperty.get(schedule.property_id) ?? []
    existing.push(schedule)
    schedulesByProperty.set(schedule.property_id, existing)
  }

  const vacancyGaps = computeVacancyGaps(bookings, properties ?? [], schedulesByProperty)

  return (
    <BookingsClient
      bookings={bookings as never}
      properties={properties ?? []}
      connections={connections ?? []}
      vacancyGaps={vacancyGaps}
    />
  )
}
