'use server'

import { revalidatePath } from 'next/cache'

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { applySafetyTemplate, rebaseSafetySchedules } from '@/lib/inspections/apply-safety-template'
import { readSafetyTemplate, type SafetyFrequency } from '@/lib/inspections/safety-template'

/**
 * §2's other half: the safety cadence, changeable after onboarding.
 *
 * Deliberately a Server Action rather than anything the Dexie layer touches.
 * The inspections page is a shell that renders from the local cache so a walk
 * can be STARTED with no signal, and the cadence editor is the opposite kind of
 * thing — a setting, edited rarely, online. Caching it would mean showing a PM
 * a stale answer they might act on; not caching it means the card simply is not
 * there offline, which is honest and needs no explaining.
 */

export interface SafetyCadenceResult {
  error?:    string
  /** Existing schedules whose due date moved. Shown back so the change is visible. */
  retimed?:  number
  /** Properties that had no safety schedule and just got one. */
  created?:  number
}

const FREQUENCIES: readonly SafetyFrequency[] = ['semi_annual', 'annual']

export async function loadSafetyCadence(): Promise<{
  frequency: SafetyFrequency | null
  startMonth: number | null
  propertyCount: number
} | { error: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const [orgRes, countRes] = await Promise.all([
      supabase
        .from('organizations')
        .select('inspection_safety_frequency, inspection_safety_start_month')
        .eq('id', membership.org_id)
        .maybeSingle(),
      supabase
        .from('properties')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', membership.org_id)
        .eq('is_active', true),
    ])

    if (orgRes.error || countRes.error) {
      reportError(orgRes.error ?? countRes.error, {
        site: 'serverAction.inspections.loadSafetyCadence', orgId: membership.org_id,
      })
      return { error: 'Could not load the inspection schedule.' }
    }

    const template = orgRes.data ? readSafetyTemplate(orgRes.data) : null
    return {
      frequency:     template?.frequency  ?? null,
      startMonth:    template?.startMonth ?? null,
      propertyCount: countRes.count ?? 0,
    }
  } catch (err) {
    console.error('[loadSafetyCadence]', err)
    reportError(err, { site: 'serverAction.inspections.loadSafetyCadence' })
    return { error: 'Could not load the inspection schedule.' }
  }
}

/**
 * Saves a changed cadence and applies it.
 *
 * ORDER MATTERS AND IS THE SAME AS ONBOARDING'S: the template is the durable
 * answer the nightly pass reads, so it is written first. A rebase that fails
 * afterwards leaves an org whose stored intent is correct and whose schedules
 * the cron will reconcile, rather than schedules nothing has a record of.
 */
export async function saveSafetyCadence(
  frequency:  SafetyFrequency,
  startMonth: number,
): Promise<SafetyCadenceResult> {
  try {
    // requireOrgRole(['admin']) — organizations' RLS UPDATE policy is
    // admin-and-owner only, so a manager's write would match zero rows, which
    // RLS reports as success rather than as a denial.
    const { user, supabase, membership } = await requireOrgRole(['admin'])

    // Validated here rather than trusted: these arrive from a client component,
    // and the DB CHECK would reject a bad pair with a 23514 the PM cannot read.
    if (!FREQUENCIES.includes(frequency)) {
      return { error: 'Pick how often the safety walk should run.' }
    }
    if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
      return { error: 'Pick a starting month.' }
    }

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
      console.error('[saveSafetyCadence]', error)
      reportError(error, { site: 'serverAction.inspections.saveSafetyCadence', orgId: membership.org_id })
      return { error: 'Could not save. Please try again.' }
    }
    // Zero rows is a refusal, not a no-op — without this the audit row below
    // would assert a change RLS declined.
    if (!updated) {
      return { error: 'You do not have permission to change this.' }
    }

    const template = { frequency, startMonth }

    // Both are non-fatal for the same reason as onboarding's fan-out: the
    // template is saved, and the nightly pass creates anything missing. A
    // failure here costs at most a day, and must not tell the PM their change
    // did not stick when it did.
    let retimed = 0
    let created = 0
    try {
      retimed = (await rebaseSafetySchedules(supabase, membership.org_id, template)).retimed
      created = (await applySafetyTemplate(supabase, membership.org_id, { template })).created
    } catch (err) {
      console.error('[saveSafetyCadence] apply failed', err)
      reportError(err, { site: 'serverAction.inspections.saveSafetyCadence.apply', orgId: membership.org_id })
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'org.inspection_template.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { frequency, start_month: startMonth, retimed, schedules_created: created },
    })

    revalidatePath('/maintenance/inspections')
    revalidatePath('/maintenance')
    return { retimed, created }
  } catch (err) {
    console.error('[saveSafetyCadence]', err)
    reportError(err, { site: 'serverAction.inspections.saveSafetyCadence' })
    return { error: 'Operation failed. Please try again.' }
  }
}
