import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { markStepComplete } from '../actions'
import { PowerUpsStep } from './power-ups-step'

const POWER_UP_DEFS = [
  {
    providerId: 'ownerrez',
    title: 'OwnerRez',
    description: 'Sync bookings and properties automatically from OwnerRez.',
    href: '/settings/integrations',
  },
  {
    providerId: 'kroger',
    title: 'Kroger',
    description: 'Automatically build a Kroger cart when inventory drops below par.',
    href: '/settings/integrations',
  },
]

export default async function PowerUpsPage() {
  const { membership } = await requireOrgMember()

  const admin = createServiceClient()
  const { data: connections } = await admin
    .from('integration_connections')
    .select('provider_id, status')
    .eq('org_id', membership.org_id)
    .eq('status', 'active')

  const connectedIds = new Set((connections ?? []).map((c) => c.provider_id))

  const powerUps = POWER_UP_DEFS.map((def) => ({
    title: def.title,
    description: def.description,
    href: def.href,
    connected: connectedIds.has(def.providerId),
  }))

  async function finishAction() {
    'use server'
    await markStepComplete('power_ups', '/ops')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Power-Ups
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Optional integrations that automate more of your workflow. Skip for now and connect later.
        </p>
      </div>

      <PowerUpsStep powerUps={powerUps} finishAction={finishAction} />
    </div>
  )
}
