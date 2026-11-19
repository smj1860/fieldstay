'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { centralDayStart, isTeamRunnable } from '@/lib/gtm/policy'
import { enqueueTask, loadTeamSettings, type EnqueueResult } from '@/lib/gtm/tasks'
import { CALL_BRIEF_TASK_TYPE } from '@/lib/gtm/teams/sales-ops-calls'
import { statusAfterManualCall, statusAfterManualSend } from '@/lib/gtm/teams/sales-ops-eligibility'
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

type AdminClient = Awaited<ReturnType<typeof requirePlatformAdmin>>['supabase']

type ManualKind = 'emailed' | 'called'

const MANUAL_TOUCH: Record<ManualKind, { note: string; next: (current: string) => 'emailed' | 'called' | null }> = {
  emailed: { note: 'Follow-up sent (drafted by Sales Ops, sent by hand).', next: statusAfterManualSend },
  called:  { note: 'Call made by hand (brief prepared by Sales Ops).',      next: statusAfterManualCall },
}

/**
 * Puts a hand-made email or call on the account's record: the touch, the
 * last-touch time the follow-up queue sorts on, and the stage if it had not been
 * reached yet. Returns false if any of it could not be written, so the caller can
 * say so.
 */
async function recordManualTouch(supabase: AdminClient, actorId: string, prospectId: string | null, kind: ManualKind): Promise<boolean> {
  if (!prospectId) return true

  const { data: current, error: readError } = await supabase
    .from('prospect_accounts').select('status').eq('id', prospectId).maybeSingle()
  if (readError || !current) {
    reportError(readError ?? new Error('account missing'), { site: 'serverAction.admin.prospects.manualTouch.read', extra: { prospectId, kind } })
    return false
  }

  const nextStatus = MANUAL_TOUCH[kind].next(current.status)
  const { error: updateError } = await supabase
    .from('prospect_accounts')
    .update({ last_touch_at: new Date().toISOString(), ...(nextStatus ? { status: nextStatus } : {}) })
    .eq('id', prospectId)
  if (updateError) {
    reportError(updateError, { site: 'serverAction.admin.prospects.manualTouch.account', extra: { prospectId, kind } })
    return false
  }

  const { error: touchError } = await supabase.from('prospect_touches').insert({
    prospect_id: prospectId,
    touch_type:  kind,
    note:        MANUAL_TOUCH[kind].note,
    actor_id:    actorId,
  })
  if (touchError) {
    reportError(touchError, { site: 'serverAction.admin.prospects.manualTouch.touch', extra: { prospectId, kind } })
    return false
  }
  return true
}

/**
 * "I sent this": a person tells FieldStay they sent an approved draft themselves.
 * FieldStay sends nothing. This closes the task and puts the email on the record.
 *
 * The task is closed FIRST, by an UPDATE that only matches while it is still
 * 'approved', so a double click (or two tabs) records one send. If the record
 * then cannot be written, the person is told, because the task is already closed
 * and the touch would otherwise be lost without anyone knowing.
 */
export async function markDraftSent(taskId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data: task, error } = await supabase
      .from('agent_tasks')
      .update({ status: 'done' })
      .eq('id', taskId)
      .eq('team', 'sales_ops')
      .eq('task_type', 'draft_outreach')
      .eq('status', 'approved')
      .select('id, prospect_id')
      .maybeSingle()

    if (error) {
      console.error('[markDraftSent]', error)
      reportError(error, { site: 'serverAction.admin.prospects.markDraftSent' })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!task) return { error: 'That draft was already handled.' }

    const recorded = await recordManualTouch(supabase, user.id, task.prospect_id, 'emailed')

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_draft.marked_sent',
      targetType: 'agent_tasks',
      targetId:   task.id,
    })

    revalidatePath(PATH)
    return recorded ? {} : { error: 'Marked as sent, but the account could not be updated. Log the email on the account by hand.' }
  } catch (err) {
    console.error('[markDraftSent]', err)
    reportError(err, { site: 'serverAction.admin.prospects.markDraftSent' })
    return { error: 'Operation failed. Please try again.' }
  }
}

const CLOSED_STAGES = ['won', 'lost', 'disqualified']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const ENQUEUE_MESSAGES: Record<Extract<EnqueueResult, { ok: false }>['reason'], string> = {
  team_off:  'Turn on the master switch and Sales Ops first.',
  too_deep:  'This task is too many handoffs deep.',
  task_cap:  'Sales Ops has reached its daily task cap.',
  cost_cap:  'Sales Ops has reached its daily spend cap.',
  duplicate: 'A call brief for this account was already requested today. Check the approval inbox.',
}

/**
 * Asks Sales Ops to prepare a call brief for one account. It refuses up front
 * when the team is off or the account is closed, because a button that looks like
 * it worked while the queue refused the task is worse than none. One per account
 * per Central Time day (the dedupe key), so a double click queues one.
 */
export async function requestCallBrief(prospectId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()
    if (!UUID.test(prospectId)) return { error: 'Unknown account.' }

    const settings = await loadTeamSettings(supabase)
    if (!isTeamRunnable(settings, 'sales_ops')) return { error: ENQUEUE_MESSAGES.team_off }

    const { data: account, error: readError } = await supabase
      .from('prospect_accounts').select('id, status').eq('id', prospectId).maybeSingle()
    if (readError) throw readError
    if (!account) return { error: 'That account no longer exists.' }
    if (CLOSED_STAGES.includes(account.status)) return { error: 'That account is closed, so there is nothing to prepare.' }

    const day = centralDayStart(new Date()).toISOString().slice(0, 10)
    const queued = await enqueueTask(createServiceClient({ platformAdmin: { id: user.id } }), {
      team:             'sales_ops',
      taskType:         CALL_BRIEF_TASK_TYPE,
      origin:           'human',
      prospectId,
      priority:         60,
      requiresApproval: true,
      dedupeKey:        `sales_ops:call_brief:${prospectId}:${day}`,
    })
    if (!queued.ok) return { error: ENQUEUE_MESSAGES[queued.reason] }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_call_brief.requested',
      targetType: 'agent_tasks',
      targetId:   queued.id,
    })
    revalidatePath(PATH)
    return {}
  } catch (err) {
    console.error('[requestCallBrief]', err)
    reportError(err, { site: 'serverAction.admin.prospects.requestCallBrief' })
    return { error: 'Could not prepare the brief. Please try again.' }
  }
}

/**
 * "I called": a person tells FieldStay they made the call themselves. FieldStay
 * dials nothing. Same shape as markDraftSent: the task is closed FIRST by an
 * UPDATE that only matches while it is still 'approved', so a double click
 * records one call.
 */
export async function markCallMade(taskId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data: task, error } = await supabase
      .from('agent_tasks')
      .update({ status: 'done' })
      .eq('id', taskId)
      .eq('team', 'sales_ops')
      .eq('task_type', CALL_BRIEF_TASK_TYPE)
      .eq('status', 'approved')
      .select('id, prospect_id')
      .maybeSingle()

    if (error) {
      console.error('[markCallMade]', error)
      reportError(error, { site: 'serverAction.admin.prospects.markCallMade' })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!task) return { error: 'That brief was already handled.' }

    const recorded = await recordManualTouch(supabase, user.id, task.prospect_id, 'called')

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_call.marked_made',
      targetType: 'agent_tasks',
      targetId:   task.id,
    })

    revalidatePath(PATH)
    return recorded ? {} : { error: 'Marked as called, but the account could not be updated. Log the call on the account by hand.' }
  } catch (err) {
    console.error('[markCallMade]', err)
    reportError(err, { site: 'serverAction.admin.prospects.markCallMade' })
    return { error: 'Operation failed. Please try again.' }
  }
}
