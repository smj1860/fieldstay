import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { markStepComplete } from '../actions'
import { PowerUpsStep } from './power-ups-step'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

export default async function PowerUpsPage() {
  const { membership } = await requireOrgMember()

  const admin = createServiceClient({ authorizedBy: membership })
  const { data: krogerConnection, error: krogerConnectionError } = await admin
    .from('integration_connections')
    .select('id')
    .eq('org_id', membership.org_id)
    .eq('provider_id', 'kroger')
    .eq('status', 'active')
    .maybeSingle()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.setup.power-ups', orgId: membership.org_id }, krogerConnectionError)
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
