import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { applySafetyTemplate } from '@/lib/inspections/apply-safety-template'
import { readSafetyTemplate, type SafetyFrequency } from '@/lib/inspections/safety-template'

import { markStepComplete } from '../actions'
import { InspectionsWizardStep } from './inspections-step'

/**
 * ONE QUESTION, AND THAT IS THE DESIGN.
 *
 * §2 of INSPECTIONS_SPEC puts inspection frequency in onboarding, but a
 * `maintenance_schedules` row is per PROPERTY — three forms across 29
 * properties is 87 rows, and a step that made a PM answer 87 times would be
 * worse than no step at all.
 *
 * Only SAFETY belongs here, because it is the only form that runs everywhere.
 * Indoor and Outdoor are per-property judgements — a studio condo and a
 * lakefront house with a dock and a well do not want the same walk, and the
 * outdoor form is heavily gated on assets a condo does not have — so the step
 * explains them in a sentence and points at recurring maintenance, which
 * already carries `creates = 'inspection'`.
 */
export default async function InspectionsSetupPage() {
  const { supabase, membership } = await requireOrgMember()

  const [orgRes, propertyCountRes] = await Promise.all([
    supabase
      .from('organizations')
      .select('inspection_safety_frequency, inspection_safety_start_month')
      .eq('id', membership.org_id)
      .single(),
    // head + exact count: the step tells the PM how many properties this is
    // about to schedule, and shipping the rows to count them would be waste.
    supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', membership.org_id),
  ])

  throwIfAnyQueryFailed(
    { site: 'page.setup.inspections', orgId: membership.org_id },
    orgRes.error, propertyCountRes.error,
  )

  const existing = orgRes.data ? readSafetyTemplate(orgRes.data) : null

  /**
   * Saves the template, then applies it.
   *
   * IN THAT ORDER, AND BOTH BEFORE THE STEP IS MARKED DONE. The template is the
   * durable answer — the nightly pass reads it to catch properties added later
   * — so persisting it first means a fan-out that fails still leaves the org in
   * a state the cron repairs on its own. The reverse order would create
   * schedules the org has no record of having asked for.
   */
  async function saveAction(frequency: SafetyFrequency, startMonth: number) {
    'use server'
    // requireOrgRole(['admin']), matching the auto-assign step: organizations'
    // RLS UPDATE policy is admin-and-owner only, and under requireOrgMember a
    // manager's write would match zero rows — which RLS reports as success.
    const { user, supabase, membership } = await requireOrgRole(['admin'])

    const { data: updated, error } = await supabase
      .from('organizations')
      .update({
        inspection_safety_frequency:   frequency,
        inspection_safety_start_month: startMonth,
      })
      .eq('id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[setup.inspections]', error)
      reportError(error, { site: 'serverAction.setup.inspections', orgId: membership.org_id })
      throw new Error('Could not save your inspection schedule. Please try again.')
    }
    // A refused UPDATE returns zero rows and NO error, so without this the
    // audit row below would assert a change RLS had silently declined.
    if (!updated) {
      const denial = new Error(`safety template write matched no row for org ${membership.org_id}`)
      reportError(denial, { site: 'serverAction.setup.inspections.denied', orgId: membership.org_id })
      throw new Error('Could not save your inspection schedule. Please try again.')
    }

    // Non-fatal. The template is saved, which is the part that persists; the
    // nightly pass applies it to every property either way, so a fan-out
    // failure costs at most a day and must not strand the PM on this step.
    let created = 0
    try {
      const result = await applySafetyTemplate(supabase, membership.org_id, {
        template: { frequency, startMonth },
      })
      created = result.created
    } catch (err) {
      console.error('[setup.inspections] fan-out failed', err)
      reportError(err, { site: 'serverAction.setup.inspections.fanout', orgId: membership.org_id })
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.inspection_template.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { frequency, start_month: startMonth, schedules_created: created },
    })

    await markStepComplete('inspections', '/setup/power-ups')
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          Safety Inspections
        </h2>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          A consistent inspection history is what an insurer will ask for, so this
          runs at every property on the same cadence. You can change it any time.
        </p>
      </div>

      <InspectionsWizardStep
        initialFrequency={existing?.frequency ?? 'semi_annual'}
        initialStartMonth={existing?.startMonth ?? new Date().getMonth() + 1}
        propertyCount={propertyCountRes.count ?? 0}
        saveAction={saveAction}
      />
    </div>
  )
}
