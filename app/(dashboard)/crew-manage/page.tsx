import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CrewManageClient } from './crew-manage-client'
import type { CrewMember, CrewAvailabilityEntry } from '@/types/database'

export const metadata: Metadata = { title: 'Crew' }

export default async function CrewManagePage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, phone, preferred_contact, specialty, role, is_active, notes, user_id, invite_sent_at, invite_accepted_at')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  // Fetch next 30 days of availability for all crew in this org
  const today = new Date().toISOString().split('T')[0]!
  const in30  = new Date(Date.now() + 30 * 86_400_000).toISOString().split('T')[0]!

  const { data: availabilityRows } = await supabase
    .from('crew_availability')
    .select('crew_member_id, available_date, is_available, notes')
    .eq('org_id', membership.org_id)
    .gte('available_date', today)
    .lte('available_date', in30)
    .order('available_date', { ascending: true })

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
