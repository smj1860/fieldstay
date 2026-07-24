import type { Metadata }       from 'next'
import { Suspense }            from 'react'
import Link                    from 'next/link'
import { requireOrgMember }    from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { IntegrationsClient }  from './integrations-client'
import { ChannelHealthTable }  from './channel-health-table'

export const metadata: Metadata = { title: 'Integrations — FieldStay' }

export default async function IntegrationsPage() {
  const { membership } = await requireOrgMember()

  const admin = createServiceClient({ authorizedBy: membership })

  const { data: providers } = await admin
    .from('integration_providers')
    .select('id, display_name, auth_type, is_active')
    .eq('is_active', true)
    .order('display_name')

  const { data: connections } = await admin
    .from('integration_connections')
    .select('id, provider_id, status, external_user_id, created_at, metadata')
    .eq('org_id', membership.org_id)

  const { data: icalFeeds } = await admin
    .from('ical_feeds')
    .select('id, property_id, name, source, last_synced_at, last_sync_status, last_sync_error, properties ( name )')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)

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
        />
      </Suspense>

      <ChannelHealthTable feeds={(icalFeeds ?? []) as never} />
    </div>
  )
}