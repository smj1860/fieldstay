import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { markStepComplete } from '../actions'
import { PowerUpsStep } from './power-ups-step'

export default async function PowerUpsPage() {
  const { membership } = await requireOrgMember()

  const admin = createServiceClient({ authorizedBy: membership })
  const { data: krogerConnection } = await admin
    .from('integration_connections')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('provider_id', 'kroger')
    .eq('status', 'active')
    .maybeSingle()

  async function finishAction() {
    'use server'
    await markStepComplete('power_ups', '/ops')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          You&apos;re All Set
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Your PMS is already connected from an earlier step, and your templates have a
          head start. Kroger is the one optional integration left — everything else below
          is just worth knowing about, not something to finish right now.
        </p>
      </div>

      <PowerUpsStep krogerConnected={!!krogerConnection} finishAction={finishAction} />
    </div>
  )
}
