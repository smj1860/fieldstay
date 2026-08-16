import type { Metadata }       from 'next'
import { Suspense }            from 'react'
import Link                    from 'next/link'
import { requireOrgMember }    from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { IntegrationsClient }  from './integrations-client'
import { ChannelHealthTable }  from './channel-health-table'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export const metadata: Metadata = { title: 'Integrations — FieldStay' }

// Fixed platform registry (a handful of providers today); the explicit bound
// documents that and keeps it out of the unbounded-select class.
const INTEGRATION_PROVIDERS_LIMIT = 200

export default async function IntegrationsPage() {
  const { membership } = await requireOrgMember()

  const admin = createServiceClient({ authorizedBy: membership })

  // Read BEFORE the provider registry: which providers this org is connected
  // to decides which provider rows the page needs.
  const { data: connections, error: connectionsError } = await admin
    .from('integration_connections')
    .select('id, provider_id, status, external_user_id, created_at, metadata')
    .eq('org_id', membership.org_id)


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.settings.integrations', orgId: membership.org_id }, connectionsError)

  // Active providers, PLUS any provider this org actually holds a connection
  // to even if it is no longer offered for new connections.
  //
  // Filtering on is_active alone made an existing connection to a deactivated
  // provider invisible AND unmanageable: no card renders, so there is no
  // Disconnect button, and the only way to remove a live Vault-backed
  // connection is direct DB access. Hostex hit this immediately — it ships
  // is_active = false while its sync is built, but its OAuth route works and
  // is reachable by direct URL. Guesty and Hostaway have the same shape.
  //
  // is_active still governs what can be CONNECTED — the client renders no
  // Connect button for an inactive provider. This only governs visibility.
  const connectedProviderIds = [...new Set((connections ?? []).map((c) => c.provider_id))]

  const providersQuery = admin
    .from('integration_providers')
    .select('id, display_name, auth_type, is_active')
    .order('display_name')
    .limit(INTEGRATION_PROVIDERS_LIMIT)

  // PostgREST .or() takes an unquoted comma-joined list for in.(); provider
  // ids are our own slugs (registry keys), never user input.
  const { data: providers, error: providersError } = connectedProviderIds.length
    ? await providersQuery.or(`is_active.eq.true,id.in.(${connectedProviderIds.join(',')})`)
    : await providersQuery.eq('is_active', true)


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.settings.integrations', orgId: membership.org_id }, providersError)
  const { data: icalFeeds, error: icalFeedsError } = await admin
    .from('ical_feeds')
    .select('id, property_id, name, source, last_synced_at, last_sync_status, last_sync_error, properties ( name )')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.settings.integrations', orgId: membership.org_id }, icalFeedsError)
  const connectionsByProvider = Object.fromEntries(
    (connections ?? []).map((c) => [c.provider_id, c])
  )

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Link href="/settings" className="text-sm text-muted-themed hover:text-secondary-themed">
          Settings
        </Link>
        <span className="text-muted-themed">/</span>
        <span className="text-sm text-secondary-themed">Integrations</span>
      </div>

      <div className="page-header mb-6">
        <h1 className="page-title">Integrations</h1>
        <p className="page-subtitle">
          Connect third-party platforms to automatically sync bookings and properties.
        </p>
      </div>

      <Suspense fallback={null}>
        <IntegrationsClient
          providers={providers ?? []}
          connectionsByProvider={connectionsByProvider}
          canDisconnect={['owner', 'admin'].includes(membership.role)}
        />
      </Suspense>

      <ChannelHealthTable feeds={(icalFeeds ?? []) as never} />
    </div>
  )
}