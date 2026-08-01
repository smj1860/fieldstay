import type { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'

// Tied to the real factory's return type rather than a literal `any` —
// createClient()/createServiceClient({ system: 'lib/ical/conflict-detection' }) both omit the <Database> generic
// (see the comment in lib/supabase/server.ts: the hand-written Database
// type doesn't satisfy postgrest-js's GenericSchema constraint), so this
// stays correct automatically if that's ever fixed, instead of hardcoding
// the workaround here too. This function is called with either client
// interchangeably — both factories return the same shape.
type DBClient = ReturnType<typeof createServiceClient>

export interface FlaggedBooking {
  id:           string
  /**
   * Nullable to match the column. bookings.source has a DEFAULT of 'other'
   * but is NOT NULL-constrained, so an explicit null insert stores one — the
   * previous non-null type here was only ever satisfied because the read was
   * untyped.
   */
  source:       string | null
  guestName:    string | null
  checkinDate:  string
  checkoutDate: string
}

/**
 * Scans all confirmed bookings for a property, flags any whose date range
 * overlaps another confirmed booking (regardless of source/feed), and
 * clears the flag on any booking that's no longer in conflict (e.g. the
 * other side was cancelled). Same-day turnovers (checkout == checkin) are
 * NOT a conflict.
 *
 * Returns only the bookings that were newly flagged in this call — use
 * this to decide whether to alert the PM, so already-known conflicts don't
 * re-trigger an email on every sync.
 */
export async function detectAndFlagOverlaps(
  supabase: DBClient,
  propertyId: string
): Promise<FlaggedBooking[]> {
  // Every confirmed booking for this property, over its whole history — the
  // input to the pairwise overlap scan below. Both failure modes here end the
  // same way, with a real double-booking never surfaced to the PM:
  //
  //   - Truncation. At max_rows = 1000 PostgREST returns the first 1000 with a
  //     200 and no signal, so any overlap involving a booking past the cap is
  //     invisible.
  //   - The discarded error. A failed read returned [], which this function
  //     reports as "no conflicts found" — indistinguishable from a clean
  //     calendar. fetchAllRows logs, reports, and throws instead.
  const bookings = await fetchAllRows<{
    id: string; checkin_date: string; checkout_date: string
    source: string | null; guest_name: string | null; has_overlap_conflict: boolean | null
  }>(
    (from, to) => supabase
      .from('bookings')
      .select('id, checkin_date, checkout_date, source, guest_name, has_overlap_conflict')
      .eq('property_id', propertyId)
      .eq('status', 'confirmed')
      .order('id')
      .range(from, to),
    { label: 'conflict-detection.bookings' },
  )

  if (bookings.length === 0) return []

  const overlapping = new Set<string>()

  for (let i = 0; i < bookings.length; i++) {
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i]
      const b = bookings[j]
      const datesOverlap = a.checkin_date < b.checkout_date && b.checkin_date < a.checkout_date
      if (datesOverlap) {
        overlapping.add(a.id)
        overlapping.add(b.id)
      }
    }
  }

  const toFlag  = bookings.filter(b => overlapping.has(b.id) && !b.has_overlap_conflict)
  const toClear = bookings.filter(b => !overlapping.has(b.id) && b.has_overlap_conflict)

  if (toFlag.length > 0) {
    await supabase.from('bookings').update({ has_overlap_conflict: true })
      .in('id', toFlag.map(b => b.id))
  }
  if (toClear.length > 0) {
    await supabase.from('bookings').update({ has_overlap_conflict: false })
      .in('id', toClear.map(b => b.id))
  }

  return toFlag.map(b => ({
    id:           b.id,
    source:       b.source,
    guestName:    b.guest_name,
    checkinDate:  b.checkin_date,
    checkoutDate: b.checkout_date,
  }))
}
