'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { inngest } from '@/lib/inngest/client'
import { isTeamRunnable } from '@/lib/gtm/policy'
import { loadTeamSettings } from '@/lib/gtm/tasks'
import {
  DECISION_RULES,
  MAX_DECISION_NOTE_CHARS,
  buildSettingsUpdate,
  isDecision,
  type SettingsPatchInput,
} from '@/lib/gtm/validate'

/**
 * Server Actions behind the Agents view of the Prospecting Funnel. Everything an
 * admin can do to the agents is here, and nothing else can do it: the tables
 * give `authenticated` UPDATE on the queue and the settings but no INSERT or
 * DELETE, so the only writes a person can make are the ones validated below.
 */

const PATH = '/admin/prospects'

/**
 * Approve, reject or cancel one task.
 *
 * The status filter on the UPDATE is the guard, not a check before it: two
 * admins (or one admin with two tabs) can both see the same draft, and only the
 * first write still matches `status IN (...)`. The second finds nothing to
 * change and is told so, instead of overwriting a decision somebody just made.
 */
export async function decideAgentTask(
  taskId: string,
  decision: string,
  note?: string,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    if (!isDecision(decision)) return { error: 'Unknown decision.' }
    const rule = DECISION_RULES[decision]
    const trimmed = note?.trim().slice(0, MAX_DECISION_NOTE_CHARS) || null

    const { data, error } = await supabase
      .from('agent_tasks')
      .update({
        status:        rule.to,
        decided_by:    user.id,
        decided_at:    new Date().toISOString(),
        decision_note: trimmed,
      })
      .eq('id', taskId)
      .in('status', [...rule.from])
      .select('id, team, task_type')
      .maybeSingle()

    if (error) {
      console.error('[decideAgentTask]', error)
      reportError(error, { site: 'serverAction.admin.prospects.decideAgentTask' })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'That item was already handled.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_task.decided',
      targetType: 'agent_tasks',
      targetId:   data.id,
      // Team and type only: never the draft itself, which may name a person.
      metadata:   { decision, team: data.team, task_type: data.task_type },
    })

    if (decision === 'approve') {
      // A wake-up hint. The approval is already saved, so a send failure is
      // reported and the owning team still finds the task on its next claim.
      try {
        await inngest.send({
          name: 'gtm/task.approved',
          data: { task_id: data.id, team: data.team, task_type: data.task_type, decided_by: user.id },
        })
      } catch (err) {
        reportError(err, { site: 'serverAction.admin.prospects.decideAgentTask.send', level: 'warning' })
      }
    }

    revalidatePath(PATH)
    return {}
  } catch (err) {
    console.error('[decideAgentTask]', err)
    reportError(err, { site: 'serverAction.admin.prospects.decideAgentTask' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/** Turns a team on or off, or changes its autonomy and daily caps. */
export async function updateTeamSettings(
  team: string,
  patch: SettingsPatchInput,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const built = buildSettingsUpdate(team, patch)
    if ('error' in built) return { error: built.error }

    const { data, error } = await supabase
      .from('gtm_team_settings')
      .update({ ...built.update, updated_by: user.id })
      .eq('team', built.team)
      .select('team')
      .maybeSingle()

    if (error) {
      console.error('[updateTeamSettings]', error)
      reportError(error, { site: 'serverAction.admin.prospects.updateTeamSettings' })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'That team has no settings row.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_team.updated',
      targetType: 'gtm_team_settings',
      targetId:   built.team,
      metadata:   { fields: Object.keys(built.update), ...built.update },
    })

    revalidatePath(PATH)
    return {}
  } catch (err) {
    console.error('[updateTeamSettings]', err)
    reportError(err, { site: 'serverAction.admin.prospects.updateTeamSettings' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/** "Run manager now": asks for a brief outside the schedule. */
export async function requestManagerRun(): Promise<{ error?: string }> {
  try {
    const { user } = await requirePlatformAdmin()

    await inngest.send({ name: 'gtm/manager.run.requested', data: { requested_by: user.id } })

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_manager.run_requested',
      targetType: 'gtm_team_settings',
      targetId:   'manager',
    })

    return {}
  } catch (err) {
    console.error('[requestManagerRun]', err)
    reportError(err, { site: 'serverAction.admin.prospects.requestManagerRun' })
    return { error: 'Could not start the manager. Please try again.' }
  }
}

/**
 * "Run report now" on the Rev Ops card. Refused up front when Rev Ops cannot
 * run, because the alternative is a button that looks like it worked: the task
 * would be refused at the queue and nothing would ever appear.
 */
export async function requestRevOpsReport(): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const settings = await loadTeamSettings(supabase)
    if (!isTeamRunnable(settings, 'rev_ops')) {
      return { error: 'Turn on the master switch and Rev Ops first.' }
    }

    await inngest.send({ name: 'gtm/rev-ops.report.requested', data: { requested_by: user.id } })

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_rev_ops.report_requested',
      targetType: 'gtm_team_settings',
      targetId:   'rev_ops',
    })

    return {}
  } catch (err) {
    console.error('[requestRevOpsReport]', err)
    reportError(err, { site: 'serverAction.admin.prospects.requestRevOpsReport' })
    return { error: 'Could not request the report. Please try again.' }
  }
}
