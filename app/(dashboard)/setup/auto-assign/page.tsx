import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '../actions'
import { AutoAssignWizardStep } from './auto-assign-step'

type AutoAssignMode = 'disabled' | 'suggest' | 'autopilot'

export default async function AutoAssignPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org } = await supabase
    .from('organizations')
    .select('auto_assign_mode')
    .eq('id', membership.org_id)
    .single()

  const currentMode: AutoAssignMode =
    (org?.auto_assign_mode as AutoAssignMode | null) ?? 'suggest'

  async function continueAction(mode: AutoAssignMode) {
    'use server'
    const { supabase, membership } = await requireOrgMember()
    await supabase
      .from('organizations')
      .update({ auto_assign_mode: mode })
      .eq('id', membership.org_id)
    await markStepComplete('auto_assign', '/setup/vendors')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Auto-Assign Mode
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Choose how FieldStay assigns crew members when a turnover is confirmed.
          You can change this any time in Settings.
        </p>
      </div>

      <AutoAssignWizardStep
        initialMode={currentMode}
        continueAction={continueAction}
      />
    </div>
  )
}
