import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CrewManageClient } from './crew-manage-client'
import type { CrewMember } from '@/types/database'

export const metadata: Metadata = { title: 'Crew' }

export default async function CrewManagePage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, phone, preferred_contact, specialty, is_active, notes, user_id, invite_sent_at, invite_accepted_at')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Crew</h1>
        <p className="page-subtitle">Manage your cleaning and maintenance crew members</p>
      </div>
      <CrewManageClient crew={(crew ?? []) as unknown as CrewMember[]} />
    </div>
  )
}
