import { requireOrgMember } from '@/lib/auth'
import type { AssetTypeStandard } from '@/types/database'
import { fetchAllRows } from '@/lib/inngest/paginate'
import type { Metadata } from 'next'
import { AssetManager } from './asset-manager'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Assets' }

export default async function AssetsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties, error: propertiesError },
    { data: assets, error: assetsError },
    standards,
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

    // Platform catalog (21 rows). Paginated rather than left bare so the read
    // can never silently truncate; at this size it is exactly one request.
    // fetchAllRows throws on error, which lands in the same error.tsx that
    // throwIfAnyQueryFailed below routes the other two failures to.
    fetchAllRows<AssetTypeStandard>(
      (from, to) => supabase
        .from('asset_type_standards')
        .select('*')
        .order('display_name')
        .range(from, to),
      { label: 'page.assets.assetTypeStandards' },
    ),
  ])

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.assets', orgId: membership.org_id }, propertiesError, assetsError)

  return (
    <AssetManager
      orgId={membership.org_id}
      properties={properties ?? []}
      assets={assets ?? []}
      standards={standards ?? []}
    />
  )
}
