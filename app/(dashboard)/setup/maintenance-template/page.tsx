import { requireOrgMember } from '@/lib/auth'
import { MasterMaintenanceBuilder } from './master-maintenance-builder'
import { markStepComplete } from '../actions'

export default async function OnboardingMaintenanceTemplatePage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: existing } = await supabase
    .from('org_master_maintenance_schedules')
    .select('*')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('created_at')

  async function finishAction() {
    'use server'
    await markStepComplete('maintenance_template', '/ops')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Master Maintenance Schedule
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Define recurring maintenance tasks for your portfolio. These can be applied to individual properties.
        </p>
      </div>

      <MasterMaintenanceBuilder
        existingItems={(existing ?? []) as Array<{
          id: string
          title: string
          description: string | null
          frequency: string
          specialty: string | null
          estimated_cost: number | null
        }>}
        finishAction={finishAction}
      />
    </div>
  )
}
