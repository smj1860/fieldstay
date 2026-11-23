'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapCount, unwrapList } from '@/lib/supabase/unwrap'
import type { Json } from '@/types/database.generated'
import { centralDayStart, isTeamRunnable } from '@/lib/gtm/policy'
import { loadTeamSettings } from '@/lib/gtm/tasks'
import { applyAction, outcomesJson, type ActionOutcome } from '@/lib/gtm/manager/apply'
import {
  INSTRUCTION_HISTORY_LIMIT,
  checkInstructionText,
  isActionKind,
  learnFromHistory,
  mayOfferStanding,
  readStoredProposal,
  recordsFromRows,
  type InstructionHistoryRow,
} from '@/lib/gtm/manager/instructions'

/**
 * Server Actions behind replying to the manager's brief.
 *
 * Three things a person can do, and the order they happen in:
 *   1. submitManagerInstruction: write a reply. The manager reads it and writes
 *      a PROPOSAL onto the row. Nothing is queued yet.
 *   2. decideManagerInstruction: approve or reject that proposal. Approving is
 *      what carries it out, through the same applyAction() a standing run uses.
 *   3. setStandingPermission: let the manager repeat an instruction type on its
 *      own. Allowed only for a type the person has approved often enough for the
 *      manager to have offered it, and revocable at any time.
 *
 * Writes go through the service role AFTER requirePlatformAdmin(): `authenticated`
 * has SELECT only on these tables, so this is the only way a row changes.
 */

const PATH = '/admin/prospects'
const MAX_INSTRUCTIONS_PER_DAY = 30
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function submitManagerInstruction(
  text: string,
  briefId: string | null,
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const checked = checkInstructionText(text)
    if ('error' in checked) return { error: checked.error }

    const settings = await loadTeamSettings(supabase)
    if (!isTeamRunnable(settings, 'manager')) {
      return { error: 'The manager is switched off. Turn it on under Teams and limits so it can read your reply.' }
    }

    const sinceRes = await supabase
      .from('manager_instructions')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'human')
      .eq('requested_by', user.id)
      .gte('created_at', centralDayStart(new Date()).toISOString())
    if (unwrapCount(sinceRes, { site: 'serverAction.admin.prospects.submitInstruction.count' }) >= MAX_INSTRUCTIONS_PER_DAY) {
      return { error: 'That is a lot of replies for one day. Try again tomorrow.' }
    }

    const service = createServiceClient({ platformAdmin: { id: user.id } })
    const { data, error } = await service
      .from('manager_instructions')
      .insert({
        source:       'human',
        instruction:  checked.text,
        brief_id:     briefId && UUID.test(briefId) ? briefId : null,
        requested_by: user.id,
      })
      .select('id')
      .single()
    if (error) throw error

    try {
      await inngest.send({ name: 'gtm/manager.instruction.submitted', data: { instruction_id: data.id } })
    } catch (sendErr) {
      // The row would sit as "reading" for ever. Say so on the row and to the person.
      reportError(sendErr, { site: 'serverAction.admin.prospects.submitInstruction.send' })
      const marked = await service.from('manager_instructions')
        .update({ status: 'unclear', reply: 'I could not be woken to read this. Nothing was done. Please send it again.' })
        .eq('id', data.id)
      if (marked.error) reportError(marked.error, { site: 'serverAction.admin.prospects.submitInstruction.mark' })
      return { error: 'Could not reach the manager. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_manager.instruction_submitted',
      targetType: 'manager_instructions',
      targetId:   data.id,
    })
    revalidatePath(PATH)
    return {}
  } catch (err) {
    console.error('[submitManagerInstruction]', err)
    reportError(err, { site: 'serverAction.admin.prospects.submitManagerInstruction' })
    return { error: 'Could not send your reply. Please try again.' }
  }
}

function runFailed(kind: ActionOutcome['kind']): ActionOutcome {
  return { kind, ok: false, summary: 'Something went wrong carrying this out. Nothing further was done for it.' }
}

type ServiceClient = ReturnType<typeof createServiceClient>

/** Runs each approved action and records what happened on the row. One action failing does not stop the next. */
async function carryOut(service: ServiceClient, instructionId: string, proposal: Json): Promise<ActionOutcome[]> {
  const now = new Date()
  const outcomes: ActionOutcome[] = []
  for (const action of readStoredProposal(proposal)) {
    try {
      outcomes.push(await applyAction(service, action, { now, origin: 'manager' }))
    } catch (applyErr) {
      reportError(applyErr, { site: 'serverAction.admin.prospects.decideManagerInstruction.apply', extra: { kind: action.kind } })
      outcomes.push(runFailed(action.kind))
    }
  }
  const failed = outcomes.length === 0 || outcomes.some((o) => !o.ok)
  const finish = await service
    .from('manager_instructions')
    .update({
      status:     failed ? 'failed' : 'applied',
      result:     outcomesJson(outcomes),
      applied_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', instructionId)
  if (finish.error) throw finish.error
  return outcomes
}

export async function decideManagerInstruction(
  instructionId: string,
  decision: 'approve' | 'reject',
): Promise<{ error?: string; summary?: string }> {
  try {
    const { user } = await requirePlatformAdmin()
    if (decision !== 'approve' && decision !== 'reject') return { error: 'Unknown decision.' }

    const service = createServiceClient({ platformAdmin: { id: user.id } })
    const decidedAt = new Date().toISOString()

    // The status filter on the UPDATE is the guard, not a check before it: two
    // tabs can show the same proposal, and only the first write still matches.
    const { data: claimed, error: claimError } = await service
      .from('manager_instructions')
      .update({
        status:     decision === 'approve' ? 'applying' : 'rejected',
        decided_by: user.id,
        decided_at: decidedAt,
        updated_at: decidedAt,
      })
      .eq('id', instructionId)
      .eq('source', 'human')
      .eq('status', 'proposed')
      .select('id, proposal')
      .maybeSingle()
    if (claimError) throw claimError
    if (!claimed) return { error: 'This was already decided, or is no longer waiting.' }

    const outcomes = decision === 'approve' ? await carryOut(service, instructionId, claimed.proposal) : []

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_manager.instruction_decided',
      targetType: 'manager_instructions',
      targetId:   instructionId,
      metadata:   { decision, actions: outcomes.length },
    })
    revalidatePath(PATH)
    return { summary: outcomes.map((o) => o.summary).join(' ') || undefined }
  } catch (err) {
    console.error('[decideManagerInstruction]', err)
    reportError(err, { site: 'serverAction.admin.prospects.decideManagerInstruction' })
    return { error: 'Could not record that decision. Please try again.' }
  }
}

export async function setStandingPermission(kind: string, enabled: boolean): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()
    if (!isActionKind(kind)) return { error: 'Unknown instruction type.' }

    if (enabled) {
      // The offer is made by the manager, but the rule is enforced here: a
      // hand-built request cannot grant a type nobody has approved enough.
      const historyRes = await supabase.from('manager_instructions')
        .select('source, status, action_kinds, decided_at')
        .eq('source', 'human')
        .order('created_at', { ascending: false })
        .limit(INSTRUCTION_HISTORY_LIMIT)
      const history = unwrapList<InstructionHistoryRow>(historyRes, { site: 'serverAction.admin.prospects.setStandingPermission.history' })
      const learned = learnFromHistory(recordsFromRows(history)).find((l) => l.kind === kind)
      if (!learned || !mayOfferStanding(learned)) {
        return { error: 'You have not approved this type often enough yet for the manager to take it over.' }
      }
    }

    const now = new Date().toISOString()
    const service = createServiceClient({ platformAdmin: { id: user.id } })
    const { error } = await service.from('manager_playbook').upsert(
      {
        action_kind: kind,
        standing:    enabled,
        granted_by:  enabled ? user.id : null,
        granted_at:  enabled ? now : null,
        updated_at:  now,
      },
      { onConflict: 'action_kind' },
    )
    if (error) throw error

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.gtm_manager.standing_changed',
      targetType: 'manager_playbook',
      targetId:   kind,
      metadata:   { enabled },
    })
    revalidatePath(PATH)
    return {}
  } catch (err) {
    console.error('[setStandingPermission]', err)
    reportError(err, { site: 'serverAction.admin.prospects.setStandingPermission' })
    return { error: 'Could not change that. Please try again.' }
  }
}
