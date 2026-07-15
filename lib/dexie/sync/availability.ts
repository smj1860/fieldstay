// lib/dexie/sync/availability.ts
//
// Pulls this crew member's own availability window into Dexie. Extracted
// out of DexieProvider's mount effect (lib/dexie/context.tsx).

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type CrewAvailabilityRow } from '../schema'

export async function syncCrewAvailability(
  supabase: DexieSupabaseClient,
  userId: string,
  crewMemberId: string,
): Promise<void> {
  const db = getDexieDb(userId)

  // Only fetch this crew member's own availability — not other crew members'.
  // Tenant isolation: org_id is implicitly enforced via crew_member_id FK.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().split('T')[0]!
  const oneYearAhead  = new Date(Date.now() + 365 * 86_400_000).toISOString().split('T')[0]!

  const { data: availability, error } = await supabase
    .from('crew_availability')
    .select('id, org_id, crew_member_id, available_date, is_available, notes, created_at')
    .eq('crew_member_id', crewMemberId)  // own rows only — critical isolation guard
    .gte('available_date', thirtyDaysAgo)
    .lte('available_date', oneYearAhead)
    .order('available_date', { ascending: true })
  if (error) {
    console.error('[availability sync] crew_availability fetch failed:', error)
    return
  }

  if (availability?.length) {
    const normalized = availability.map((row: Record<string, unknown>) => ({
      ...row,
      is_available: row.is_available ? 1 : 0,
      notes:        row.notes ?? '',
    }))
    await db.crew_availability.bulkPut(normalized as CrewAvailabilityRow[])
  }
}
