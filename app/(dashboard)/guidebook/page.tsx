import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { GuidebookClient } from './guidebook-client'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Guidebook' }

export default async function GuidebookPage() {
  const { membership } = await requireOrgMember()
  const supabase        = createServiceClient()

  const [sponsorsResult, configResult, propertiesResult] = await Promise.all([
    supabase
      .from('guidebook_sponsors')
      .select('*')
      .eq('org_id', membership.org_id)
      .order('slot_number'),

    supabase
      .from('guidebook_configurations')
      .select('*')
      .eq('org_id', membership.org_id)
      .maybeSingle(),

    supabase
      .from('properties')
      .select('id, name, address, lat, lng')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  const sponsors   = sponsorsResult.data   ?? []
  const config      = configResult.data     ?? null
  const properties = propertiesResult.data ?? []

  const activeSponsorCount = sponsors.filter((s) => s.status === 'active').length

  return (
    <GuidebookClient
      orgId={membership.org_id}
      initialSponsors={sponsors}
      initialConfig={config}
      initialActiveSponsorCount={activeSponsorCount}
      properties={properties}
      appUrl={process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'}
    />
  )
}
