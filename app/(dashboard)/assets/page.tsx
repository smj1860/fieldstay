import { requireOrgMember } from '@/lib/auth'
import type { Metadata } from 'next'
import { AssetsBoard } from './assets-board'

export const metadata: Metadata = { title: 'Asset Health' }

export default async function AssetsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: assets },
    { data: standards },
    { data: properties },
  ] = await Promise.all([
    supabase
      .from('property_assets')
      .select('id, property_id, name, asset_type, health_score, installation_date, make, model, health_score_updated_at, is_na')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('health_score', { ascending: true, nullsFirst: false }),

    supabase
      .from('asset_type_standards')
      .select('asset_type, display_name')
      .order('display_name'),

    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),
  ])

  return (
    <AssetsBoard
      orgId={membership.org_id}
      assets={assets ?? []}
      properties={properties ?? []}
      standards={standards ?? []}
    />
  )
}
