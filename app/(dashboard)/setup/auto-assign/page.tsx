import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { markStepComplete } from '../actions'
import { AutoAssignWizardStep } from './auto-assign-step'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

type AutoAssignMode = 'disabled' | 'suggest' | 'autopilot'

export default async function AutoAssignPage() {
  const { supabase, membership } = await requireOrgMember()

  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('auto_assign_mode')
    .eq('id', membership.org_id)
    .single()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.setup.auto-assign', orgId: membership.org_id }, orgError)
  const currentMode: AutoAssignMode =
    (org?.auto_assign_mode as AutoAssignMode | null) ?? 'suggest'

  // Same defect markStepComplete carried, with one extra consequence.
  // organizations' RLS UPDATE policy is is_org_member(id, ARRAY['admin']) —
  // admin and owner only — and this ran under requireOrgMember() (any member)
  // while discarding the update result. For anyone else the write matched zero
  // rows, which under RLS is not an error, and the code then wrote an audit row
  // asserting the mode HAD been changed. A false audit entry is worse than a
  // silent no-op: that log is what someone reads while investigating why
  // turnovers stopped auto-assigning, and it would have pointed at an
  // innocent person and a change that never happened.
  //
  // The audit call now sits after a verified write, so it can only describe
  // something that actually landed.
  async function continueAction(mode: AutoAssignMode) {
    'use server'
    const { user, supabase, membership } = await requireOrgRole(['admin'])

    const { data: updated, error } = await supabase
      .from('organizations')
      .update({ auto_assign_mode: mode })
      .eq('id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[setup.autoAssign]', error)
      reportError(error, { site: 'serverAction.setup.autoAssign', orgId: membership.org_id })
      throw new Error('Could not save your auto-assign choice. Please try again.')
    }
    if (!updated) {
      const denial = new Error(`auto_assign_mode write matched no row for org ${membership.org_id}`)
      reportError(denial, { site: 'serverAction.setup.autoAssign.denied', orgId: membership.org_id })
      throw new Error('Could not save your auto-assign choice. Please try again.')
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.auto_assign_mode.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { mode },
    })

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
