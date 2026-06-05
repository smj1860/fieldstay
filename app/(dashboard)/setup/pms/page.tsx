import Link from 'next/link'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'

export default async function OnboardingPmsPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: connection } = await supabase
    .from('integration_connections')
    .select('id, connected_at, external_user_id')
    .eq('org_id' as never, membership.org_id)
    .eq('provider_id', 'ownerrez')
    .eq('status', 'active')
    .maybeSingle()

  const { data: properties } = connection
    ? await supabase
        .from('properties')
        .select('id, name, city, state')
        .eq('org_id', membership.org_id)
        .eq('is_active', true)
        .order('name')
    : { data: [] }

  async function continueAction() {
    'use server'
    await markStepComplete('pms', '/setup/crew')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Connect Your PMS
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Connect OwnerRez to automatically import your properties and sync bookings.
        </p>
      </div>

      {connection ? (
        <>
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium"
            style={{ background: 'var(--accent-green-dim)', color: 'var(--accent-green)' }}
          >
            <span className="text-base">✓</span>
            OwnerRez connected
            {connection.external_user_id && (
              <span className="ml-1 text-xs opacity-70">· User {connection.external_user_id}</span>
            )}
          </div>

          {properties && properties.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                {properties.length} propert{properties.length !== 1 ? 'ies' : 'y'} imported
              </p>
              <div className="border border-themed rounded-xl overflow-hidden">
                {properties.map((p) => (
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

          <form action={continueAction}>
            <button type="submit" className="btn-primary">
              Continue →
            </button>
          </form>
        </>
      ) : (
        <div className="card p-6 text-center space-y-4">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto text-2xl"
            style={{ background: 'var(--bg-raised)' }}
          >
            🔗
          </div>
          <div>
            <h3 className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
              OwnerRez not connected
            </h3>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Connect your OwnerRez account to automatically import properties and sync bookings in real time.
            </p>
          </div>
          <Link href="/api/integrations/ownerrez/connect" className="btn-primary inline-flex">
            Connect OwnerRez
          </Link>
          <div>
            <form action={continueAction}>
              <button type="submit" className="btn-ghost text-xs" style={{ color: 'var(--text-muted)' }}>
                Skip for now →
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
