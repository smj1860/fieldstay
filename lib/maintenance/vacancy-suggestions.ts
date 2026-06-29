import type { SupabaseClient } from '@supabase/supabase-js'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'

const LOOKAHEAD_DAYS = 90

export interface MaintenanceCandidate {
  id:                 string
  name:               string
  next_due_date:      string
  estimated_cost:     number | null
  assigned_vendor_id: string | null
}

/**
 * Finds maintenance schedule items whose next_due_date falls within a known
 * or inferred vacancy window for a property.
 *
 * Used by:
 *  - Phase 18 cron (inferred booking-to-booking gaps in maintenance-schedules.ts)
 *  - Phase 30 real-time path (explicit owner blocks in incremental-sync.ts)
 *
 * windowEnd is the next checkin date (or null when no booking follows).
 * The effective end is capped at LOOKAHEAD_DAYS from windowStart in either case.
 */
export async function findMaintenanceCandidatesForWindow(
  supabase:    SupabaseClient,
  propertyId:  string,
  windowStart: string,
  windowEnd:   string | null
): Promise<MaintenanceCandidate[]> {
  const startMs = new Date(windowStart).getTime()
  const capMs   = startMs + LOOKAHEAD_DAYS * 86_400_000

  const effectiveEnd = windowEnd
    ? new Date(Math.min(new Date(windowEnd).getTime(), capMs))
    : new Date(capMs)

  const { data: candidates } = await supabase
    .from('maintenance_schedules')
    .select('id, name, next_due_date, estimated_cost, assigned_vendor_id, active_from_month, active_to_month')
    .eq('property_id', propertyId)
    .eq('is_active', true)
    .lte('next_due_date', effectiveEnd.toISOString().split('T')[0])

  return (candidates ?? []).filter((c) =>
    isMaintenanceItemActiveThisMonth(c.active_from_month ?? null, c.active_to_month ?? null)
  )
}
