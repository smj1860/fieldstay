import { requireOrgMember } from '@/lib/auth'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { NudgeBanner } from '@/components/nudge-banner'
import { PropertiesGrid } from './properties-grid'
import { Card } from '@/components/ui/Card'
import { buttonVariantClass } from '@/components/ui/Button'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Properties' }

export default async function PropertiesPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: properties },
    { count: ownerPortalTokenCount },
    { data: openWOs },
    { data: unassignedTOs },
    { data: erroredFeeds },
  ] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name, address, city, state, property_type, bedrooms, bathrooms, setup_steps_completed, is_active')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('owner_portal_tokens')
      .select('id, property_owners!inner(org_id)', { count: 'exact', head: true })
      .eq('property_owners.org_id', membership.org_id),

    supabase
      .from('work_orders')
      .select('property_id')
      .eq('org_id', membership.org_id)
      .not('status', 'in', '("completed","cancelled")'),

    supabase
      .from('turnovers')
      .select('property_id')
      .eq('org_id', membership.org_id)
      .eq('status', 'pending_assignment'),

    supabase
      .from('ical_feeds')
      .select('property_id')
      .eq('org_id', membership.org_id)
      .eq('last_sync_status', 'error'),
  ])

  const opsCountsByProperty: Record<string, { openWorkOrders: number; unassignedTurnovers: number; syncErrors: number }> = {}
  const bump = (propertyId: string, key: 'openWorkOrders' | 'unassignedTurnovers' | 'syncErrors') => {
    opsCountsByProperty[propertyId] ??= { openWorkOrders: 0, unassignedTurnovers: 0, syncErrors: 0 }
    opsCountsByProperty[propertyId][key]++
  }
  for (const wo of openWOs ?? [])       bump(wo.property_id, 'openWorkOrders')
  for (const to of unassignedTOs ?? []) bump(to.property_id, 'unassignedTurnovers')
  for (const f of erroredFeeds ?? [])   bump(f.property_id, 'syncErrors')

  const atLimit            = (properties?.length ?? 0) >= membership.org.max_properties
  const showOwnerPortalNudge = (ownerPortalTokenCount ?? 0) === 0

  return (
    <div>
      {showOwnerPortalNudge && (
        <NudgeBanner
          id="owner-portal-intro"
          message="Give property owners real-time financial visibility without any extra work on your end."
          href="/owners"
          linkText="Enable owner portal"
        />
      )}

      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Properties</h1>
          <p className="page-subtitle">
            {properties?.length ?? 0} of {membership.org.max_properties} properties
          </p>
        </div>
        {atLimit ? (
          <span className={buttonVariantClass('secondary') + ' opacity-60 cursor-not-allowed text-xs'}>
            Upgrade to add more
          </span>
        ) : (
          <Link href="/properties/new" className={buttonVariantClass('primary')}>
            <Plus className="w-4 h-4" />
            Add Property
          </Link>
        )}
      </div>

      {!properties?.length ? (
        <EmptyState />
      ) : (
        <PropertiesGrid properties={properties} opsCountsByProperty={opsCountsByProperty} />
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <Card className="text-center py-16 max-w-md mx-auto mt-8">
      <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4" style={{ background: 'var(--accent-gold-dim)' }}>
        <Plus className="w-6 h-6" style={{ color: 'var(--accent-gold)' }} />
      </div>
      <h3 className="font-semibold text-primary-themed mb-1">Add your first property</h3>
      <p className="text-sm text-muted-themed mb-6">
        Connect your Airbnb or VRBO calendar and FieldStay handles the rest.
      </p>
      <Link href="/properties/new" className={buttonVariantClass('primary')}>
        Add Property
      </Link>
    </Card>
  )
}
