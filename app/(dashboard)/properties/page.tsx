import { asBooleanMap } from '@/lib/json'
import { requireOrgMember } from '@/lib/auth'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { NudgeBanner } from '@/components/nudge-banner'
import { PropertiesGrid } from './properties-grid'
import { Card } from '@/components/ui/Card'
import { buttonVariantClass } from '@/components/ui/Button'
import type { Metadata } from 'next'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'

/** All three ops-badge reads select only this, and are counted per property. */
interface PropertyIdRow { property_id: string }

export const metadata: Metadata = { title: 'Properties' }

export default async function PropertiesPage() {
  const { supabase, membership } = await requireOrgMember()

  // The three ops-badge reads below are PAGINATED, and the reason is worth
  // stating once for all of them: each fetches one row per matching record and
  // counts them per property in the `bump()` loop underneath. That is a
  // GROUP BY done in JavaScript, so the row count is the org's whole open
  // backlog, not its property count.
  //
  // unassignedTurnovers is the one that actually gets there. It is the only
  // read on this page that grows with TIME rather than with org size: at ~2
  // turnovers per property per week, a 100-property portfolio generates ~200 a
  // week, so roughly five weeks of un-actioned queue crosses PostgREST's
  // max_rows = 1000. Nothing self-corrects — the badge just starts
  // undercounting, and it undercounts on exactly the properties the PM has
  // been neglecting, which is when the number matters most.
  //
  // All three are done together because they are the same three lines with
  // different tables, and fixing one would leave the identical defect twice.
  const [
    { data: properties, error: propertiesError },
    { count: ownerPortalTokenCount },
    openWOs,
    unassignedTOs,
    erroredFeeds,
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

    fetchAllRows<PropertyIdRow>(
      (rangeFrom, rangeTo) => supabase
        .from('work_orders')
        .select('property_id')
        .eq('org_id', membership.org_id)
        .not('status', 'in', '("completed","cancelled")')
        .order('property_id')
        .range(rangeFrom, rangeTo),
      { label: 'page.properties.openWorkOrders' },
    ),

    fetchAllRows<PropertyIdRow>(
      (rangeFrom, rangeTo) => supabase
        .from('turnovers')
        .select('property_id')
        .eq('org_id', membership.org_id)
        .eq('status', 'pending_assignment')
        .order('property_id')
        .range(rangeFrom, rangeTo),
      { label: 'page.properties.unassignedTurnovers' },
    ),

    fetchAllRows<PropertyIdRow>(
      (rangeFrom, rangeTo) => supabase
        .from('ical_feeds')
        .select('property_id')
        .eq('org_id', membership.org_id)
        .eq('last_sync_status', 'error')
        .order('property_id')
        .range(rangeFrom, rangeTo),
      { label: 'page.properties.erroredFeeds' },
    ),
  ])

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  // erroredFeeds is in here for the same reason as the other three: it drives
  // the per-property sync-error badge, so a failed read renders a confident
  // "0 sync errors" on properties whose calendars are actually broken.
  // The three ops-badge reads are no longer threaded through here: fetchAllRows
  // THROWS on error, which reaches the same error.tsx this call routes to. The
  // reason they were listed — a failed read rendering a confident "0" on
  // properties whose work orders or calendars are actually broken — is
  // unchanged and still satisfied.
  throwIfAnyQueryFailed(
    { site: 'page.properties', orgId: membership.org_id },
    propertiesError,
  )

  const opsCountsByProperty: Record<string, { openWorkOrders: number; unassignedTurnovers: number; syncErrors: number }> = {}
  const bump = (propertyId: string, key: 'openWorkOrders' | 'unassignedTurnovers' | 'syncErrors') => {
    opsCountsByProperty[propertyId] ??= { openWorkOrders: 0, unassignedTurnovers: 0, syncErrors: 0 }
    opsCountsByProperty[propertyId][key]++
  }
  for (const wo of openWOs)       bump(wo.property_id, 'openWorkOrders')
  for (const to of unassignedTOs) bump(to.property_id, 'unassignedTurnovers')
  for (const f of erroredFeeds)   bump(f.property_id, 'syncErrors')

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
        <PropertiesGrid
          // This page selects a narrow subset of `properties`, so it resolves
          // just those columns' own DEFAULTs rather than the whole-row helper.
          properties={properties.map((p) => ({
            ...p,
            property_type:         p.property_type ?? 'house',
            bedrooms:              p.bedrooms      ?? 1,
            bathrooms:             p.bathrooms     ?? 1,
            setup_steps_completed: asBooleanMap(p.setup_steps_completed),
          }))}
          opsCountsByProperty={opsCountsByProperty}
        />
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
