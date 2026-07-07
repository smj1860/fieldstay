import Link                    from 'next/link'
import { Check }                from 'lucide-react'
import { requireOrgMember }    from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { markStepComplete }    from '../actions'
import { Card }                from '@/components/ui/Card'
import { Badge }                from '@/components/ui/Badge'
import { Button }               from '@/components/ui/Button'

// All PMS provider IDs — excludes non-PMS integrations (e.g. kroger, repuguard)
// 'guesty' is commented out: it's registered as oauth2 in integration_providers but
// not yet wired into lib/integrations/registry.ts or connectWithApiKey() — the
// Connect button would 404. Re-add once that backend support lands.
const PMS_PROVIDER_IDS = ['ownerrez', 'hostaway' /* , 'guesty' */] as const

export default async function OnboardingPmsPage() {
  const { membership } = await requireOrgMember()
  const admin = createServiceClient()

  const { data: providers } = await admin
    .from('integration_providers')
    .select('id, display_name, auth_type')
    .in('id', PMS_PROVIDER_IDS)
    .eq('is_active', true)
    .order('display_name')

  const { data: connections } = await admin
    .from('integration_connections')
    .select('id, provider_id, status, external_user_id')
    .eq('org_id', membership.org_id)
    .in('provider_id', PMS_PROVIDER_IDS)

  const connectionsByProvider = Object.fromEntries(
    (connections ?? []).map((c) => [c.provider_id, c])
  )

  // Count active connections across all PMS providers
  const activeConnections = (connections ?? []).filter((c) => c.status === 'active')

  const { data: properties } = activeConnections.length
    ? await admin
        .from('properties')
        .select('id, name, city, state')
        .eq('org_id', membership.org_id)
        .eq('is_active', true)
        .order('name')
        .limit(10)
    : { data: [] }

  async function continueAction() {
    'use server'
    await markStepComplete('pms', '/setup/crew')
  }

  const anyConnected = activeConnections.length > 0

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Connect Your PMS
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Connect your property management system to automatically import properties and sync bookings.
        </p>
      </div>

      {anyConnected && (
        <div
          className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
          style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}
        >
          <Check className="w-4 h-4" />
          {activeConnections.length === 1
            ? `${(providers ?? []).find((p) => p.id === activeConnections[0].provider_id)?.display_name ?? 'PMS'} connected`
            : `${activeConnections.length} integrations connected`}
        </div>
      )}

      {/* Provider cards */}
      <div className="space-y-3">
        {(providers ?? []).map((provider) => {
          const connection = connectionsByProvider[provider.id]
          const isConnected = connection?.status === 'active'

          // api_key providers: open credential modal in settings/integrations
          // oauth2 providers: kick off OAuth redirect directly
          const connectHref = provider.auth_type === 'api_key'
            ? `/settings/integrations?connect=${provider.id}`
            : `/api/integrations/${provider.id}/connect`

          return (
            <Card
              key={provider.id}
              className="flex items-center justify-between gap-4"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                    {provider.display_name}
                  </span>
                  {isConnected && (
                    <Badge tone="green" className="text-xs">Connected</Badge>
                  )}
                </div>
                {isConnected && connection.external_user_id && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Account: {connection.external_user_id}
                  </p>
                )}
              </div>

              {!isConnected && (
                <Link href={connectHref} className="btn-secondary text-sm shrink-0">
                  Connect
                </Link>
              )}
            </Card>
          )
        })}
      </div>

      {/* Properties preview if any are imported */}
      {(properties ?? []).length > 0 && (
        <div>
          <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
            {properties!.length} propert{properties!.length !== 1 ? 'ies' : 'y'} imported
          </p>
          <div className="border border-themed rounded-xl overflow-hidden">
            {properties!.map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-themed last:border-0">
                <span className="text-sm font-medium text-primary-themed">{p.name}</span>
                {(p.city || p.state) && (
                  <span className="text-xs text-muted-themed">
                    {[p.city, p.state].filter(Boolean).join(', ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <form action={continueAction}>
          <Button type="submit">
            {anyConnected ? 'Continue →' : 'Skip for now →'}
          </Button>
        </form>
      </div>
    </div>
  )
}
