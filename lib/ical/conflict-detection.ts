import type { createServiceClient } from '@/lib/supabase/server'

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
  source:       string
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
  const { data: bookings } = await supabase
    .from('bookings')
    .select('id, checkin_date, checkout_date, source, guest_name, has_overlap_conflict')
    .eq('property_id', propertyId)
    .eq('status', 'confirmed')

  if (!bookings || bookings.length === 0) return []

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
