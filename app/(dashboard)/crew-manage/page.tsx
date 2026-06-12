import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CrewManageClient } from './crew-manage-client'
import type { CrewMember } from '@/types/database'

export const metadata: Metadata = { title: 'Crew' }

export default async function CrewManagePage() {
  const { supabase, membership } = await requireOrgMember()

  const today    = new Date().toISOString().split('T')[0]!
  const in14days = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]! })()

  const [{ data: crew }, { data: availability }] = await Promise.all([
    supabase
      .from('crew_members')
      .select('id, name, email, phone, preferred_contact, specialty, role, is_active, notes, user_id, invite_sent_at, invite_accepted_at')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
    supabase
      .from('crew_availability')
      .select('crew_member_id, available_date, is_available')
      .gte('available_date', today)
      .lte('available_date', in14days),
  ])

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Crew</h1>
        <p className="page-subtitle">Manage your cleaning and maintenance crew members</p>
      </div>
      <CrewManageClient crew={(crew ?? []) as unknown as CrewMember[]} availabilityRows={availability ?? []} />
    </div>
  )
}
