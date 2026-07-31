import { requireOrgMember } from '@/lib/auth'
import type { Metadata } from 'next'
import { AssetManager } from './asset-manager'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Assets' }

export default async function AssetsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties, error: propertiesError },
    { data: assets, error: assetsError },
    { data: standards, error: standardsError },
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

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.assets', orgId: membership.org_id }, propertiesError, assetsError, standardsError)

  return (
    <AssetManager
      orgId={membership.org_id}
      properties={properties ?? []}
      assets={assets ?? []}
      standards={standards ?? []}
    />
  )
}
