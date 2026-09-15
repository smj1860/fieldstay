'use server'

import { revalidatePath } from 'next/cache'

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError } from '@/lib/supabase/unwrap'
import { acquireLock, releaseLock } from '@/lib/cache/single-flight'
import type { MemberRole } from '@/types/database'
import { acceptSuggestion } from '../turnovers/actions'

export type FrictionActionState = { error?: string; success?: boolean }

/**
 * Matches pre_flight_friction's `_manage` policy exactly, so a viewer gets a
 * real permission error instead of a write that RLS refuses with 0 rows and no
 * error. `owner` passes automatically inside is_org_member().
 */
const FRICTION_WRITE_ROLES: MemberRole[] = ['admin', 'manager']

const NOTHING_UPDATED =
  'You do not have permission to make this change, or this flag no longer exists.'

/**
 * Accept the Smart Fix on a flagged turnover.
 *
 * This deliberately does NOT assign anyone itself. It writes the Smart Fix
 * into the turnover's own suggestion columns and then calls acceptSuggestion()
 * — the same action the turnover board's Accept button calls — which owns the
 * crew-belongs-to-this-org check, the assignment upsert, the status advance,
 * the assignment_outcomes learning signal and the audit row. A second
 * assignment path here would be a copy of all five, and the copy is what
 * eventually misses one: acceptSuggestion's org check on suggested_crew_ids
 * was itself added after that exact gap was found.
 */
export async function acceptSmartFix(frictionId: string): Promise<FrictionActionState> {
  try {
    const { supabase, membership } = await requireOrgRole(FRICTION_WRITE_ROLES)

    const frictionRes = await supabase
      .from('pre_flight_friction')
      .select('id, turnover_id, smart_fix_crew_id, smart_fix_reasoning, status')
      .eq('id', frictionId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(frictionRes.error, { site: 'serverAction.ops.acceptSmartFix', orgId: membership.org_id })) {
      return { error: 'Could not load that flag. Please try again.' }
    }

    const friction = frictionRes.data
    if (!friction) return { error: 'That flag no longer exists.' }
    if (!friction.smart_fix_crew_id) return { error: 'There is no Smart Fix to accept on this turnover.' }

    // LOCKED, not merely CAS'd — this used to claim "compare-and-swap on the
    // column being written, same shape as dismissSuggestion", which was never
    // true: dismissSuggestion is ONE atomic UPDATE with a real precondition in
    // its WHERE clause, but staging here, acceptSuggestion() and the resolve
    // below are THREE separate writes with nothing tying them together — the
    // stage write below had no precondition at all, so two managers double-
    // clicking (or one stale tab) would both pass it and both run the full
    // accept pipeline, exactly the "later click silently overwrites the
    // earlier decision" scenario the comment claimed was already prevented.
    //
    // A single WHERE-clause precondition cannot cover a three-write sequence,
    // so this locks the whole thing per friction flag instead — the same
    // pattern already used for applyStandardInventoryToProperty and
    // syncChecklistRoomCounts's own check-then-write races. Resolving
    // pre_flight_friction stays LAST regardless: resolving first would clear
    // the flag off the panel for an assignment that had not landed yet.
    const lockKey = `smart-fix-accept:${frictionId}`
    if (!(await acquireLock(lockKey))) {
      // Someone else is already accepting this exact flag. Their pipeline
      // covers it — running a second one would duplicate the assignment
      // upsert (harmless, it's an upsert) but could also stage a SECOND,
      // possibly stale, copy of the same suggestion on top of the first.
      return { error: NOTHING_UPDATED }
    }

    try {
      const { data: staged, error: stageError } = await supabase
        .from('turnovers')
        .update({
          suggested_crew_ids:   [friction.smart_fix_crew_id],
          suggestion_reasoning: friction.smart_fix_reasoning,
          suggestion_status:    'pending',
        })
        .eq('id', friction.turnover_id)
        .eq('org_id', membership.org_id)
        .select('id')
        .maybeSingle()

      if (stageError) {
        console.error('[acceptSmartFix] stage', stageError)
        reportError(stageError, { site: 'serverAction.ops.acceptSmartFix.stage', orgId: membership.org_id })
        return { error: 'Failed to accept the Smart Fix. Please try again.' }
      }
      if (!staged) return { error: NOTHING_UPDATED }

      // The shared accept path. Its own guards (terminal turnover statuses,
      // crew-in-org) run here, so a turnover completed since the 2am score
      // refuses with a real message rather than being reopened.
      const accepted = await acceptSuggestion(friction.turnover_id)
      if (accepted.error) return { error: accepted.error }

      // Only after the assignment actually landed. Resolving first would clear
      // the flag off the panel for an assignment that never happened.
      const { data: resolved, error: resolveError } = await supabase
        .from('pre_flight_friction')
        .update({ status: 'resolved' })
        .eq('id', frictionId)
        .eq('org_id', membership.org_id)
        .eq('status', 'flagged')
        .select('id')
        .maybeSingle()

      if (resolveError) {
        console.error('[acceptSmartFix] resolve', resolveError)
        reportError(resolveError, { site: 'serverAction.ops.acceptSmartFix.resolve', orgId: membership.org_id })
        // The crew IS assigned at this point — reporting failure would invite a
        // retry that assigns nobody new and confuses the PM about what happened.
        // The flag simply stays until the next 2am rescore clears it.
      }

      // No audit row here on purpose: acceptSuggestion() already wrote
      // 'turnover.suggestion.accepted' for this turnover. A second row for the
      // same act would read, to whoever is working an incident, as two
      // acceptances.
      if (!resolved) {
        console.warn('[acceptSmartFix] flag not resolved; next rescore will clear it', { frictionId })
      }

      revalidatePath('/ops')
      revalidatePath('/turnovers')
      return { success: true }
    } finally {
      await releaseLock(lockKey)
    }
  } catch (err) {
    console.error('[acceptSmartFix]', err)
    reportError(err, { site: 'serverAction.ops.acceptSmartFix.outer' })
    return { error: 'Failed to accept the Smart Fix. Please try again.' }
  }
}

/**
 * Dismiss a flag. No other side effect — the turnover is untouched, and the
 * next 2am rescore re-flags it only if the situation got worse (see
 * nextStatus() in the cron), so dismissing is a judgement about today rather
 * than a permanent mute.
 */
export async function dismissFrictionFlag(frictionId: string): Promise<FrictionActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(FRICTION_WRITE_ROLES)

    // Precondition on the column being written makes a double-click
    // idempotent and stops a dismissal from overwriting an accept that landed
    // between render and click.
    const { data: dismissed, error } = await supabase
      .from('pre_flight_friction')
      .update({ status: 'dismissed' })
      .eq('id', frictionId)
      .eq('org_id', membership.org_id)
      .eq('status', 'flagged')
      .select('id, turnover_id')
      .maybeSingle()

    if (error) {
      console.error('[dismissFrictionFlag]', error)
      reportError(error, { site: 'serverAction.ops.dismissFrictionFlag', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!dismissed) return { error: NOTHING_UPDATED }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.suggestion.dismissed',
      targetType: 'turnover',
      targetId:   dismissed.turnover_id,
      metadata:   { source: 'pre_flight_friction', friction_id: frictionId },
    })

    revalidatePath('/ops')
    return { success: true }
  } catch (err) {
    console.error('[dismissFrictionFlag]', err)
    reportError(err, { site: 'serverAction.ops.dismissFrictionFlag.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}
