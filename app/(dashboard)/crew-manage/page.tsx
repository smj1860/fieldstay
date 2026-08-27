import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CrewManageClient } from './crew-manage-client'
import type { CrewMember, CrewAvailabilityEntry } from '@/types/database'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Crew' }

export default async function CrewManagePage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: crew, error: crewError } = await supabase
    .from('crew_members')
    .select('id, name, email, phone, preferred_contact, specialty, role, is_active, notes, user_id, invite_sent_at, invite_accepted_at, auto_assign_eligible')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')
    // Bounded rather than left to PostgREST's silent max_rows = 1000, which
    // would drop crew off the roster with a 200 and no signal — a PM would read
    // that as someone having been deleted.
    //
    // Sized against the growth axis, per CLAUDE.md's -org-scoped tier note.
    // This filters is_active, so it grows with ORG SIZE, not with time:
    // deactivated crew accumulate but are excluded here. At the audited ~1.2
    // crew per property and a 100-property plan cap that is ~120 rows, so 500
    // is roughly 4x headroom and still a real ceiling.
    .limit(500)


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.crew-manage', orgId: membership.org_id }, crewError)
  // Cover current month + next month for the calendar overview
  const now        = new Date()
  const calStart   = new Date(now.getFullYear(), now.getMonth(), 1)
  const calEnd     = new Date(now.getFullYear(), now.getMonth() + 2, 0)
  const rangeStart = calStart.toISOString().split('T')[0]!
  const rangeEnd   = calEnd.toISOString().split('T')[0]!

  const { data: availabilityRows, error: availabilityRowsError } = await supabase
    .from('crew_availability')
    .select('crew_member_id, available_date, is_available, notes')
    .eq('org_id', membership.org_id)
    .gte('available_date', rangeStart)
    .lte('available_date', rangeEnd)
    .order('available_date', { ascending: true })


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.crew-manage', orgId: membership.org_id }, availabilityRowsError)
  // Build a lookup map: crew_member_id → sorted list of availability entries
  const availabilityMap: Record<string, CrewAvailabilityEntry[]> = {}
  for (const row of availabilityRows ?? []) {
    const key = row.crew_member_id as string
    if (!availabilityMap[key]) availabilityMap[key] = []
    availabilityMap[key]!.push({
      available_date: row.available_date as string,
      is_available:   row.is_available   as boolean,
      notes:          row.notes          as string | null,
    })
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Crew</h1>
        <p className="page-subtitle">Manage your cleaning and maintenance crew members</p>
      </div>
      <CrewManageClient
        crew={(crew ?? []) as unknown as CrewMember[]}
        availabilityMap={availabilityMap}
      />
    </div>
  )
}
