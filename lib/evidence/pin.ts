// lib/evidence/pin.ts
//
// The newest crew check-in for a property, for "Use last check-in" on the
// property details page. Read by the page (to label and enable the button) and
// by the server action (the authority), through the same function, so what the
// PM was shown is what the action validates.
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { unwrapList } from '@/lib/supabase/unwrap'

export interface PropertyCheckin {
  id:         string
  lat:        number
  lng:        number
  accuracyFt: number | null
  capturedAt: string
}

export async function latestPropertyCheckin(
  supabase: SupabaseClient, orgId: string, propertyId: string,
): Promise<PropertyCheckin | null> {
  const res = await supabase
    .from('evidence_events')
    .select('id, lat, lng, gps_accuracy_ft, captured_at')
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .eq('kind', 'checkin')
    .order('captured_at', { ascending: false })
    .limit(1)
  const row = unwrapList(res, { site: 'lib.evidence.pin.latestCheckin', orgId })[0]
  if (!row || row.lat === null || row.lng === null) return null
  return { id: row.id, lat: row.lat, lng: row.lng, accuracyFt: row.gps_accuracy_ft, capturedAt: row.captured_at }
}
