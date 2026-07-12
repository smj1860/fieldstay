import { requireOrgMember } from '@/lib/auth'
import type { Metadata } from 'next'
import { AssetManager } from './asset-manager'

export const metadata: Metadata = { title: 'Assets' }

export default async function AssetsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties },
    { data: assets },
    { data: standards },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name, city, state')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('property_assets')
      .select('*')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('created_at', { ascending: false }),

    supabase
      .from('asset_type_standards')
      .select('*')
      .order('display_name'),
  ])

  return (
    <AssetManager
      orgId={membership.org_id}
      properties={properties ?? []}
      assets={assets ?? []}
      standards={standards ?? []}
    />
  )
}
