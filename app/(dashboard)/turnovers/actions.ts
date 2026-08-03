'use server'

import { revalidatePath } from 'next/cache'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest, sendEventAsync } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError, tryUnwrap, tryUnwrapList } from '@/lib/supabase/unwrap'
import type { TablesUpdate } from '@/types/database'

export type TurnoverActionState = { error?: string; success?: boolean; warning?: string }

// ── Suggestion-override tracking shared by assignCrew/addCrewToTurnover ─────
//
// Neither crew-assignment path previously looked at a turnover's suggestion
// state at all. This closes that gap: if a turnover had a pending suggestion
// for different crew, flip it to 'overridden' instead of leaving it stuck at
// 'pending' forever, and make sure whoever actually gets assigned has an
// assignment_outcomes row — even if they were never suggested — so
// duration/rating scoring has something to update later.
async function trackAssignmentAgainstSuggestions(
  orgId:        string,
  crewMemberId: string,
  crewName:     string,
  turnovers:    { id: string; property_id: string; suggestion_status?: string | null; suggested_crew_ids?: string[] | null }[],
  propertyBedrooms: Record<string, number | null>
): Promise<void> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const service = createServiceClient({ system: 'action:turnover-suggestion-tracking' })

    const overridden = turnovers.filter(t =>
      t.suggestion_status === 'pending' &&
      !(t.suggested_crew_ids ?? []).includes(crewMemberId)
    )

    if (overridden.length > 0) {
      const { error: overrideError } = await service.from('turnovers')
        .update({ suggestion_status: 'overridden' })
        .eq('org_id', orgId)
        .in('id', overridden.map(t => t.id))
      if (overrideError) {
        console.error('[trackAssignmentAgainstSuggestions] override update failed', overrideError)
        reportError(overrideError, { site: 'serverAction.turnovers.trackAssignmentAgainstSuggestions.override', orgId })
      }

      const priorSuggestionRows = overridden.flatMap(t =>
        (t.suggested_crew_ids ?? []).map(suggestedCrewId => ({
          turnover_id:      t.id,
          org_id:           orgId,
          crew_member_id:   suggestedCrewId,
          was_accepted:     false,
          override_reason:  `${crewName} assigned instead of the suggestion`,
        }))
      )
      if (priorSuggestionRows.length > 0) {
        const { error: priorSuggestionError } = await service.from('assignment_outcomes').upsert(priorSuggestionRows, {
          onConflict:       'turnover_id,crew_member_id',
          ignoreDuplicates: false,
        })
        if (priorSuggestionError) {
          console.error('[trackAssignmentAgainstSuggestions] prior-suggestion upsert failed', priorSuggestionError)
          reportError(priorSuggestionError, { site: 'serverAction.turnovers.trackAssignmentAgainstSuggestions.priorSuggestion', orgId })
        }
      }
    }

    const ensureRows = turnovers.map(t => ({
      turnover_id:        t.id,
      org_id:             orgId,
      crew_member_id:     crewMemberId,
      was_suggestion:     (t.suggested_crew_ids ?? []).includes(crewMemberId),
      property_bedrooms:  propertyBedrooms[t.property_id] ?? null,
    }))
    // ignoreDuplicates — don't clobber a row the suggestion algorithm already
    // scored (suggested_score/score_breakdown) just because it's being
    // touched again here.
    const { error: ensureError } = await service.from('assignment_outcomes').upsert(ensureRows, {
      onConflict:       'turnover_id,crew_member_id',
      ignoreDuplicates: true,
    })
    if (ensureError) {
      console.error('[trackAssignmentAgainstSuggestions] ensure-rows upsert failed', ensureError)
      reportError(ensureError, { site: 'serverAction.turnovers.trackAssignmentAgainstSuggestions.ensureRows', orgId })
    }
  } catch (err) {
    // Suggestion-state/outcome tracking must never break the actual assignment —
    // this catches thrown exceptions (network errors, bugs); the {error}-shaped
    // Supabase failures above are logged individually since a query failing at
    // the DB level resolves normally rather than throwing.
    console.error('[trackAssignmentAgainstSuggestions]', err)
    reportError(err, { site: 'serverAction.turnovers.trackAssignmentAgainstSuggestions', orgId })
  }
}

// Shared by assignCrew/addCrewToTurnover — fire-and-forget, since the
// assignment is already committed by the time either caller reaches this;
// a slow/unreachable Inngest shouldn't stall or fail the action for the PM.
function notifyCrewAssigned(orgId: string, crewMemberId: string, turnoverIds: string[]): void {
  sendEventAsync({
    name: 'turnover/crew-assigned',
    data: {
      crew_member_id: crewMemberId,
      turnover_ids:   turnoverIds,
      org_id:         orgId,
    },
  })
}

/**
 * fetchAllRows, degrading to null instead of throwing.
 *
 * Every read below is bounded by an .in() list or a single parent, so none of
 * them is a platform scan — but "unlikely to truncate" is not the same as
 * bounded, and a short page here reads as "no time off" / "no conflict" /
 * "not yet assigned", which is precisely the class of silence this whole pass
 * is removing. Pagination makes truncation impossible; the null return lets
 * each caller keep its own fail-vs-degrade decision rather than inheriting
 * fetchAllRows' throw.
 */
async function tryFetchAll<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  site:      string,
  orgId:     string,
): Promise<T[] | null> {
  try {
    return await fetchAllRows<T>(fetchPage, { label: site })
  } catch (err) {
    console.error(`[${site}]`, err)
    reportError(err, { site, orgId })
    return null
  }
}

// ── Crew assignment ──────────────────────────────────────────────────────────

/**
 * Shared preamble for the two crew-assignment actions.
 *
 * assignCrew and addCrewToTurnover both prove the client-supplied turnover ids
 * and crew id belong to the caller's org before touching anything, and both
 * grew a second branch per read once the discarded errors were handled.
 * Extracting it keeps each action under the cognitive-complexity ceiling and
 * leaves one definition of "verified" instead of two copies that can drift.
 *
 * Fails closed and reports: a failed verification is never the same answer as
 * "you don't own these".
 */
/**
 * Best-effort "New Assignment" push to the crew member. Extracted from
 * assignCrew both to keep that action under the cognitive-complexity ceiling
 * and because every failure mode in here is deliberately swallowed — the push
 * must never fail an assignment that already committed.
 *
 * Both reads use tryUnwrap*, so a failure is reported rather than silently
 * degrading to "this crew member has no devices registered".
 */
async function sendAssignmentPush(
  orgId:        string,
  crewMemberId: string,
  turnovers:    { id: string }[],
): Promise<void> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const serviceClient = createServiceClient({ system: 'action:turnover-suggestion-tracking' })

    // org_id filtered explicitly: this is a service-role client, so RLS is not
    // scoping it. Filtering on crew_member_id alone was sound only via a
    // non-local invariant (the id was org-checked by loadAssignmentTargets),
    // and these rows are push endpoints — a mis-scoped read pushes another
    // tenant's crew.
    // Paginated as well as org-scoped: adding the org filter moved this read
    // into the ladder's org-scoped tier, and a tier change is still a new
    // finding because the read was never actually bounded. One crew member's
    // devices is a handful of rows, but nothing in the query said so.
    const subs = await fetchAllRows<{ endpoint: string; p256dh: string; auth: string }>(
      (from, to) => serviceClient
        .from('push_subscriptions')
        .select('endpoint, p256dh, auth')
        .eq('org_id', orgId)
        .eq('crew_member_id', crewMemberId)
        .order('endpoint')
        .range(from, to),
      { label: 'serverAction.turnovers.assignCrew.pushSubs' },
    )
    if (subs.length === 0) return

    const { sendPushToCrewMember } = await import('@/lib/push/client')

    const firstRes = await serviceClient
      .from('turnovers')
      .select('checkout_datetime, properties(name)')
      .eq('org_id', orgId)
      .eq('id', turnovers[0]!.id)
      .maybeSingle()

    const firstOut = tryUnwrap(firstRes, { site: 'serverAction.turnovers.assignCrew.pushBody', orgId })
    const firstTurnover = firstOut.ok ? firstOut.data : null
    const propName = unwrapJoin(firstTurnover?.properties)?.name

    const count = turnovers.length
    const body = count === 1 && propName
      ? `${propName} — ${new Date(firstTurnover!.checkout_datetime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
      : `${count} new assignment${count !== 1 ? 's' : ''} added`

    await sendPushToCrewMember(subs, { title: 'New Assignment', body, url: '/crew' })
  } catch (err) {
    // Push failure must never break the assignment
    console.error('[push] failed to notify crew member:', err)
    reportError(err, { site: 'serverAction.turnovers.assignCrew.inner', orgId })
  }
}

/**
 * Counts overlaps between the turnovers being assigned and the ones this crew
 * member already holds. Pure — extracted from addCrewToTurnover so the nested
 * date-window comparison stops contributing to that action's complexity.
 *
 * Each turnover occupies [checkout_datetime, checkin_datetime); a turnover
 * compared against itself is skipped, since re-assigning the same one is not a
 * conflict.
 */
function countScheduleConflicts(
  incoming: { id: string; checkout_datetime: string; checkin_datetime: string }[],
  existing: { turnover_id: string; turnovers: unknown }[],
): number {
  let conflicts = 0
  for (const newT of incoming) {
    const newStart = new Date(newT.checkout_datetime).getTime()
    const newEnd   = new Date(newT.checkin_datetime ?? newT.checkout_datetime).getTime()
    for (const a of existing) {
      if (a.turnover_id === newT.id) continue
      const other = unwrapJoin(a.turnovers as { checkout_datetime: string; checkin_datetime: string } | { checkout_datetime: string; checkin_datetime: string }[] | null)
      if (!other) continue
      const existStart = new Date(other.checkout_datetime).getTime()
      const existEnd   = new Date(other.checkin_datetime).getTime()
      if (newStart < existEnd && newEnd > existStart) conflicts++
    }
  }
  return conflicts
}

type AssignmentTargets<T> =
  | { ok: false; error: string }
  | { ok: true;  turnovers: T[]; crew: { id: string; name: string } }

async function loadAssignmentTargets<T>(
  supabase:     Awaited<ReturnType<typeof requireOrgMember>>['supabase'],
  orgId:        string,
  turnoverIds:  string[],
  crewMemberId: string,
  select:       string,
): Promise<AssignmentTargets<T>> {
  const turnoverRows = await tryFetchAll<T>(
    (from, to) => supabase
      .from('turnovers')
      .select(select)
      .in('id', turnoverIds)
      .eq('org_id', orgId)
      .order('id')
      .range(from, to) as never,
    'serverAction.turnovers.loadAssignmentTargets.turnovers', orgId,
  )
  if (turnoverRows === null) return { ok: false, error: 'Could not load those turnovers. Please try again.' }
  if (!turnoverRows.length) return { ok: false, error: 'Turnovers not found' }
  const turnovers = turnoverRows

  // maybeSingle: with .single() a nonexistent crew id came back as a PGRST116
  // ERROR, not as null — the not-found branch was only reachable because that
  // error was discarded. Handling the error without switching the terminator
  // would turn every bad id into a thrown 500.
  const crewRes = await supabase
    .from('crew_members')
    .select('id, name')
    .eq('id', crewMemberId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (reportQueryError(crewRes.error, { site: 'serverAction.turnovers.loadAssignmentTargets.crew', orgId })) {
    return { ok: false, error: 'Could not verify that crew member. Please try again.' }
  }
  if (!crewRes.data) return { ok: false, error: 'Crew member not found' }

  return { ok: true, turnovers, crew: crewRes.data }
}

export async function assignCrew(
  turnoverIds: string[],
  crewMemberId: string
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const targets = await loadAssignmentTargets<{
      id: string; property_id: string; checkout_datetime: string
      suggestion_status: string | null; suggested_crew_ids: string[] | null
    }>(
      supabase, membership.org_id, turnoverIds, crewMemberId,
      'id, property_id, checkout_datetime, suggestion_status, suggested_crew_ids',
    )
    if (!targets.ok) return { error: targets.error }
    const { turnovers, crew } = targets

    const ids = turnovers.map(t => t.id)

    // Time-off check — non-blocking, since a PM may want to override.
    //
    // "Non-blocking" means a KNOWN conflict doesn't block. It never meant an
    // UNKNOWN one counts as clean, which is what `timeOff?.length ?? 0` did: a
    // failed read produced zero, the PM was shown no warning at all, and the
    // crew member who booked that Saturday off got assigned it anyway. The
    // outcome now degrades to a warning that says we could not check.
    const turnoverDates = [...new Set(turnovers.map(t => t.checkout_datetime.split('T')[0]))]
    const timeOffRows = await tryFetchAll<{ available_date: string }>(
      (from, to) => supabase
        .from('crew_availability')
        .select('available_date')
        .eq('org_id', membership.org_id)
        .eq('crew_member_id', crewMemberId)
        .eq('is_available', false)
        .in('available_date', turnoverDates)
        .order('available_date')
        .range(from, to),
      'serverAction.turnovers.assignCrew.timeOff', membership.org_id,
    )
    const timeOffCount = timeOffRows?.length ?? 0

    // Batch: remove other-crew assignments across all turnovers in one query
    await supabase
      .from('turnover_assignments')
      .delete()
      .in('turnover_id', ids)
      .neq('crew_member_id', crewMemberId)

    // Batch: upsert this crew member for all turnovers at once
    const { error: assignError } = await supabase.from('turnover_assignments').upsert(
      ids.map(id => ({ turnover_id: id, crew_member_id: crewMemberId, org_id: membership.org_id })),
      { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: true }
    )
    if (assignError) {
      console.error('[assignCrew]', assignError)
      reportError(assignError, { site: 'serverAction.turnovers.assignCrew', orgId: membership.org_id })
      return { error: 'Failed to assign crew. Please try again.' }
    }

    // Batch: advance status for all pending_assignment turnovers at once
    await supabase
      .from('turnovers')
      .update({ status: 'assigned' })
      .in('id', ids)
      .eq('status', 'pending_assignment')

    const propertyIds = [...new Set(turnovers.map(t => t.property_id))]
    // Paginated: propertyIds is derived from a bulk turnover selection, and a
    // large portfolio's bulk action can list more properties than the cap.
    const propertyRows = await fetchAllRows<{ id: string; bedrooms: number | null }>(
      (from, to) => supabase
        .from('properties')
        .select('id, bedrooms')
        .in('id', propertyIds)
        .order('id')
        .range(from, to),
      { label: 'turnovers.actions.propertyBedrooms' },
    )
    const propertyBedrooms = Object.fromEntries(
      propertyRows.map(p => [p.id, p.bedrooms as number | null])
    )
    await trackAssignmentAgainstSuggestions(membership.org_id, crewMemberId, crew.name, turnovers, propertyBedrooms)

    notifyCrewAssigned(membership.org_id, crewMemberId, turnovers.map(t => t.id))

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.crew.assigned',
      targetType: 'crew_member',
      targetId:   crewMemberId,
      metadata:   { turnover_ids: turnovers.map(t => t.id) },
    })

    await sendAssignmentPush(membership.org_id, crewMemberId, turnovers)

    revalidatePath('/turnovers')
    const warnings: string[] = []
    if (timeOffRows === null) warnings.push(`Couldn't check ${crew.name}'s time off — please verify manually.`)
    if (timeOffCount > 0) warnings.push(`${crew.name} marked time off on ${timeOffCount} of the assigned date(s).`)

    if (warnings.length > 0) return { success: true, warning: warnings.join(' ') }
    return { success: true }
  } catch (err) {
    console.error('[assignCrew]', err)
    reportError(err, { site: 'serverAction.turnovers.assignCrew.outer' })
    return { error: 'Failed to assign crew. Please try again.' }
  }
}

// ── Split assignment — different crew per turnover, one submit ──────────────
//
// Groups the picks by crew member and calls the existing assignCrew() once
// per group, so every existing guarantee (org/crew validation, time-off
// warnings, push notifications, pending_assignment → assigned transition)
// stays in one place instead of being duplicated here.

export async function assignCrewIndividually(
  assignments: { turnoverId: string; crewMemberId: string }[]
): Promise<TurnoverActionState> {
  try {
    if (!assignments.length) return { error: 'No assignments to apply' }

    const groups = new Map<string, string[]>()
    for (const a of assignments) {
      const list = groups.get(a.crewMemberId) ?? []
      list.push(a.turnoverId)
      groups.set(a.crewMemberId, list)
    }

    const results = await Promise.all(
      Array.from(groups.entries()).map(([crewMemberId, turnoverIds]) =>
        assignCrew(turnoverIds, crewMemberId)
      )
    )

    const firstError = results.find((result) => result.error)
    if (firstError) return firstError

    const warnings = results
      .map((result) => result.warning)
      .filter((warning): warning is string => Boolean(warning))

    return warnings.length ? { success: true, warning: warnings.join(' ') } : { success: true }
  } catch (err) {
    console.error('[assignCrewIndividually]', err)
    reportError(err, { site: 'serverAction.turnovers.assignCrewIndividually' })
    return { error: 'Failed to assign crew. Please try again.' }
  }
}

// ── Status update ────────────────────────────────────────────────────────────

export async function updateTurnoverStatus(
  turnover_id: string,
  status: 'in_progress' | 'completed' | 'flagged' | 'cancelled',
  notes?: string
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const update: TablesUpdate<'turnovers'> = { status }
    const completedAt = new Date().toISOString()
    if (status === 'in_progress') {
      update.started_at = completedAt
    }
    if (status === 'completed') {
      update.completed_at     = completedAt
      update.completion_notes = notes ?? null
    }
    if (notes && status === 'flagged') {
      update.completion_notes = notes
    }

    // Completing is guarded by the WHERE clause, not by an earlier read.
    // This previously selected the current status, computed
    // `wasAlreadyCompleted`, then updated unconditionally — so two concurrent
    // completions both saw a non-completed status and both fired
    // turnover/completed. The money side was contained (the cleaning-fee
    // expense upserts on (source_reference_id, source) and the PM
    // notification has a dedupeKey), but emit-completion-metric
    // double-counted and the second write overwrote completed_at with a fresh
    // wall clock, corrupting the durations assignment_outcomes and crew
    // scoring are derived from. .neq('status', 'completed') makes exactly one
    // racing UPDATE match a row; the loser gets `updated === null`.
    // Same pattern as app/api/crew/turnovers/[id]/complete/route.ts.
    let query = supabase
      .from('turnovers')
      .update(update)
      .eq('id', turnover_id)
      .eq('org_id', membership.org_id)
    if (status === 'completed') {
      query = query.neq('status', 'completed')
    }

    const { data: updated, error } = await query.select('id, property_id, org_id').maybeSingle()

    if (error) {
      console.error('[updateTurnoverStatus]', error)
      reportError(error, { site: 'serverAction.turnovers.updateTurnoverStatus', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Fire completion event for PM notification. `updated === null` when
    // completing means the row was already completed — either by a concurrent
    // request that will fire the event itself, or by an earlier save whose
    // downstream automations already ran. Either way, don't re-fire.
    if (status === 'completed' && updated) {
      await inngest.send({
        name: 'turnover/completed',
        data: {
          turnover_id,
          property_id:        updated.property_id,
          org_id:             updated.org_id,
          completed_by_crew_id: '',
          completed_at:       completedAt,
        },
      })
    }

    // Fire flagged event to auto-create draft work order. The UPDATE above
    // already returned the row (org-scoped), so this no longer needs a second
    // — and previously un-org-filtered — read to find property_id.
    if (status === 'flagged' && notes && updated) {
      await inngest.send({
        name: 'turnover/flagged',
        data: {
          turnover_id,
          property_id: updated.property_id,
          org_id:      membership.org_id,
          flag_notes:  notes,
          flagged_by:  user.id,
        },
      })
    }

    revalidatePath('/turnovers')
    revalidatePath(`/turnovers/${turnover_id}`)
    return { success: true }
  } catch (err) {
    console.error('[updateTurnoverStatus]', err)
    reportError(err, { site: 'serverAction.turnovers.updateTurnoverStatus.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Manual turnover creation ─────────────────────────────────────────────────

export async function createManualTurnover(
  _prev: TurnoverActionState | null,
  formData: FormData
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const property_id        = formData.get('property_id') as string
    const checkout_date      = formData.get('checkout_date') as string
    const checkout_time      = formData.get('checkout_time') as string || '11:00'
    const checkin_date       = formData.get('checkin_date') as string
    const checkin_time       = formData.get('checkin_time') as string || '15:00'
    const notes              = (formData.get('notes') as string)?.trim() || null

    if (!property_id || !checkout_date || !checkin_date) {
      return { error: 'Property, checkout date, and check-in date are required' }
    }

    const checkoutDT = new Date(`${checkout_date}T${checkout_time}:00`)
    const checkinDT  = new Date(`${checkin_date}T${checkin_time}:00`)

    if (checkinDT <= checkoutDT) {
      return { error: 'Check-in must be after checkout' }
    }

    const windowMinutes = Math.round(
      (checkinDT.getTime() - checkoutDT.getTime()) / 60_000
    )
    const priority =
      windowMinutes < 120 ? 'urgent' :
      windowMinutes < 240 ? 'high'   : 'medium'

    // Verify property belongs to this org — property_id is client-supplied and
    // must not be trusted to already scope to the caller's org.
    const propertyRes = await supabase
      .from('properties')
      .select('id')
      .eq('id', property_id)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(propertyRes.error, { site: 'serverAction.turnovers.createManualTurnover.property', orgId: membership.org_id })) {
      return { error: 'Could not verify that property. Please try again.' }
    }
    if (!propertyRes.data) return { error: 'Property not found' }

    // Get default checklist template for the property.
    //
    // maybeSingle is required, not cosmetic: a property with no default
    // template is the ORDINARY case, and .single() reported that as a PGRST116
    // error. Only the discarded error made the no-template path work at all.
    // Fails closed on a real error — a turnover created with no checklist
    // reaches the crew PWA with nothing to complete, and nobody finds out until
    // someone is standing in the unit. Creation is trivially retryable.
    const templateRes = await supabase
      .from('checklist_templates')
      .select('id')
      .eq('property_id', property_id)
      .eq('is_default', true)
      .maybeSingle()

    if (reportQueryError(templateRes.error, { site: 'serverAction.turnovers.createManualTurnover.template', orgId: membership.org_id })) {
      return { error: "Could not load the property's checklist template. Please try again." }
    }
    const template = templateRes.data

    const { data: turnover, error } = await supabase
      .from('turnovers')
      .insert({
        property_id,
        org_id:               membership.org_id,
        checkout_datetime:    checkoutDT.toISOString(),
        checkin_datetime:     checkinDT.toISOString(),
        window_minutes:       windowMinutes,
        status:               'pending_assignment',
        priority:             priority as never,
        auto_generated:       false,
        notes,
        checklist_template_id: template?.id ?? null,
      })
      .select('id')
      .single()

    if (error) {
      console.error('[createManualTurnover]', error)
      reportError(error, { site: 'serverAction.turnovers.createManualTurnover', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // Fire-and-forget — the turnover row is already committed; a slow/
    // unreachable Inngest shouldn't stall or fail this action for the PM.
    sendEventAsync({
      name: 'turnover/created',
      data: {
        turnover_id:       turnover.id,
        property_id,
        org_id:            membership.org_id,
        checkout_datetime: checkoutDT.toISOString(),
        checkin_datetime:  checkinDT.toISOString(),
        window_minutes:    windowMinutes,
      },
    })

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[createManualTurnover]', err)
    reportError(err, { site: 'serverAction.turnovers.createManualTurnover.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Add crew to turnover (additive, no replace) ──────────────────────────────

export async function addCrewToTurnover(
  turnoverIds: string[],
  crewMemberId: string
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const targets = await loadAssignmentTargets<{
      id: string; property_id: string; status: string
      checkout_datetime: string; checkin_datetime: string
      suggestion_status: string | null; suggested_crew_ids: string[] | null
    }>(
      supabase, membership.org_id, turnoverIds, crewMemberId,
      'id, property_id, status, checkout_datetime, checkin_datetime, suggestion_status, suggested_crew_ids',
    )
    if (!targets.ok) return { error: targets.error }
    const { turnovers, crew } = targets

    const verifiedIds = turnovers.map(t => t.id)

    // Fetch all existing assignments for this crew + these turnovers in one query.
    //
    // Fails closed, before any write. A silent empty result here made
    // `alreadyAssigned` empty, so `toInsert` became EVERY id, the batch insert
    // collided with the pre-existing row, and the 23505 branch below returned
    // { success: true } — skipping the pending->assigned advance, suggestion
    // tracking, the crew push, and the audit row. The PM was told the
    // assignment worked; the genuinely-new turnovers in the batch were never
    // inserted at all, because the batch insert is all-or-nothing.
    const assignedRows = await tryFetchAll<{ turnover_id: string }>(
      (from, to) => supabase
        .from('turnover_assignments')
        .select('turnover_id')
        .in('turnover_id', verifiedIds)
        .eq('crew_member_id', crewMemberId)
        .order('turnover_id')
        .range(from, to),
      'serverAction.turnovers.addCrewToTurnover.existing', membership.org_id,
    )
    if (assignedRows === null) return { error: 'Could not check existing assignments. Please try again.' }
    const alreadyAssigned = new Set(assignedRows.map(a => a.turnover_id))

    // Batch insert only the missing assignments
    const toInsert = verifiedIds.filter(id => !alreadyAssigned.has(id))
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase.from('turnover_assignments').insert(
        toInsert.map(id => ({ turnover_id: id, crew_member_id: crewMemberId, org_id: membership.org_id }))
      )
      if (insertError) {
        // 23505 = unique_violation — assignment already exists (concurrent request)
        if (insertError.code === '23505') {
          return { success: true }
        }
        console.error('[addCrewToTurnover]', insertError)
        reportError(insertError, { site: 'serverAction.turnovers.addCrewToTurnover', orgId: membership.org_id })
        return { error: 'Failed to assign crew. Please try again.' }
      }
    }

    // Batch advance pending_assignment turnovers to assigned
    const pendingIds = turnovers
      .filter(t => t.status === 'pending_assignment')
      .map(t => t.id)
    if (pendingIds.length > 0) {
      await supabase.from('turnovers').update({ status: 'assigned' }).in('id', pendingIds)
    }

    const propertyIds = [...new Set(turnovers.map(t => t.property_id))]
    // Paginated: propertyIds is derived from a bulk turnover selection, and a
    // large portfolio's bulk action can list more properties than the cap.
    const propertyRows = await fetchAllRows<{ id: string; bedrooms: number | null }>(
      (from, to) => supabase
        .from('properties')
        .select('id, bedrooms')
        .in('id', propertyIds)
        .order('id')
        .range(from, to),
      { label: 'turnovers.actions.propertyBedrooms' },
    )
    const propertyBedrooms = Object.fromEntries(
      propertyRows.map(p => [p.id, p.bedrooms as number | null])
    )
    await trackAssignmentAgainstSuggestions(membership.org_id, crewMemberId, crew.name, turnovers, propertyBedrooms)

    notifyCrewAssigned(membership.org_id, crewMemberId, turnovers.map(t => t.id))

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.crew.assigned',
      targetType: 'crew_member',
      targetId:   crewMemberId,
      metadata:   { turnover_ids: turnovers.map(t => t.id) },
    })

    // Conflict detection — check for overlapping assignments for this crew member.
    //
    // This read runs AFTER the insert, so failing closed is not available — the
    // assignment is already committed. It therefore has to degrade loudly: an
    // empty result used to mean "no conflict", so a failed read double-booked
    // one cleaner into two overlapping windows and showed the PM a clean
    // success.
    const existingAssignments = await tryFetchAll<{ turnover_id: string; turnovers: unknown }>(
      (from, to) => supabase
        .from('turnover_assignments')
        .select('turnover_id, turnovers!inner(checkout_datetime, checkin_datetime, status)')
        .eq('crew_member_id', crewMemberId)
        .not('turnovers.status', 'in', '("completed","cancelled")')
        .order('turnover_id')
        .range(from, to),
      'serverAction.turnovers.addCrewToTurnover.conflicts', membership.org_id,
    )

    const conflictCount = countScheduleConflicts(turnovers, existingAssignments ?? [])

    // Time-off check — non-blocking (a known conflict doesn't block), but an
    // UNKNOWN one must not read as clean. See assignCrew for the full note.
    const turnoverDates = [...new Set(turnovers.map(t => t.checkout_datetime.split('T')[0]))]
    const timeOffRows = await tryFetchAll<{ available_date: string }>(
      (from, to) => supabase
        .from('crew_availability')
        .select('available_date')
        .eq('org_id', membership.org_id)
        .eq('crew_member_id', crewMemberId)
        .eq('is_available', false)
        .in('available_date', turnoverDates)
        .order('available_date')
        .range(from, to),
      'serverAction.turnovers.addCrewToTurnover.timeOff', membership.org_id,
    )
    const timeOffCount = timeOffRows?.length ?? 0

    revalidatePath('/turnovers')
    const warnings: string[] = []
    if (existingAssignments === null) warnings.push(`Couldn't check ${crew.name}'s other assignments for conflicts — please verify manually.`)
    if (conflictCount > 0) warnings.push(`${crew.name} may have a scheduling conflict with ${conflictCount} other turnover(s).`)
    if (timeOffRows === null) warnings.push(`Couldn't check ${crew.name}'s time off — please verify manually.`)
    if (timeOffCount > 0)  warnings.push(`${crew.name} marked time off on ${timeOffCount} of the assigned date(s).`)

    if (warnings.length > 0) return { success: true, warning: warnings.join(' ') }
    return { success: true }
  } catch (err) {
    console.error('[addCrewToTurnover]', err)
    reportError(err, { site: 'serverAction.turnovers.addCrewToTurnover.outer' })
    return { error: 'Failed to assign crew. Please try again.' }
  }
}

// ── Remove one crew member from a turnover ───────────────────────────────────

/** Return shape of the `remove_crew_from_turnover(uuid, uuid, uuid)` RPC. */
type RemoveCrewResult =
  | { ok: true;  remaining: number; reverted: boolean }
  | { ok: false; reason: 'turnover_not_found' | 'assignment_not_found' }

export async function removeCrewFromTurnover(
  turnoverId: string,
  crewMemberId: string
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // One RPC, not read-then-delete-then-count-then-update. Two concurrent
    // removals could each run their COUNT before the other's DELETE committed,
    // both see a non-zero remaining count, both skip the revert, and leave the
    // turnover `assigned` with zero crew — off the needs-assignment board, so
    // nobody is prompted to staff it. The function takes FOR UPDATE on the
    // turnover, making the whole decision atomic. The org scope is passed
    // explicitly because SECURITY DEFINER skips RLS inside the body.
    const { data: rpcResult, error: rpcError } = await supabase.rpc('remove_crew_from_turnover', {
      p_turnover_id:    turnoverId,
      p_crew_member_id: crewMemberId,
      p_org_id:         membership.org_id,
    })

    if (rpcError || !rpcResult) {
      console.error('[removeCrewFromTurnover] rpc', rpcError)
      reportError(rpcError ?? new Error('remove_crew_from_turnover returned no result'), {
        site: 'serverAction.turnovers.removeCrewFromTurnover.rpc',
      })
      return { error: 'Failed to remove crew member. Please try again.' }
    }

    const result = rpcResult as RemoveCrewResult

    // Previously a failed DELETE fell through to the count, saw the crew member
    // still present, skipped the revert, and returned success — telling the PM
    // someone was removed who was not. Now the two "nothing happened" cases are
    // distinguishable and both reported.
    if (!result.ok) {
      return {
        error: result.reason === 'turnover_not_found'
          ? 'Turnover not found'
          : 'That crew member is not assigned to this turnover.',
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.crew.removed',
      targetType: 'crew_member',
      targetId:   crewMemberId,
      metadata:   { turnover_id: turnoverId },
    })

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[removeCrewFromTurnover]', err)
    reportError(err, { site: 'serverAction.turnovers.removeCrewFromTurnover' })
    return { error: 'Failed to remove crew member. Please try again.' }
  }
}

// ── Bulk turnover status update ──────────────────────────────────────────────

export async function bulkUpdateTurnoverStatus(
  turnoverIds: string[],
  status: 'completed'
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership } = await requireOrgMember()

    // Eligibility is the WHERE clause, not an earlier read — the same fix
    // updateTurnoverStatus already carries (see the comment there). This
    // previously read `eligible`, then updated unconditionally with a fresh
    // completed_at, then fanned out per row: two concurrent bulk completions
    // both matched, both re-stamped completed_at, and both fired
    // turnover/completed, so emit-completion-metric double-counted and the
    // durations assignment_outcomes and crew scoring derive were corrupted.
    // Only rows this UPDATE actually claimed come back, and only those emit.
    const completedAt = new Date().toISOString()

    const { data: completed, error } = await supabase
      .from('turnovers')
      .update({ status, completed_at: completedAt })
      .in('id', turnoverIds)
      .eq('org_id', membership.org_id)
      .in('status', ['pending_assignment', 'assigned', 'in_progress', 'flagged'])
      .select('id, property_id, org_id')

    if (error) {
      console.error('[bulkUpdateTurnoverStatus]', error)
      reportError(error, { site: 'serverAction.turnovers.bulkUpdateTurnoverStatus', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    if (!completed?.length) return { success: true }

    // Fire the same automation event single-completion uses.
    // One event per turnover so each has its own Inngest retry path.
    await Promise.all(
      completed.map(t =>
        inngest.send({
          name: 'turnover/completed',
          data: {
            turnover_id:          t.id,
            property_id:          t.property_id,
            org_id:               t.org_id,
            completed_by_crew_id: '',  // PM-initiated bulk completion
            completed_at:         completedAt,
          },
        })
      )
    )

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[bulkUpdateTurnoverStatus]', err)
    reportError(err, { site: 'serverAction.turnovers.bulkUpdateTurnoverStatus.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Archive / unarchive turnovers ────────────────────────────────────────────

export async function archiveTurnover(
  turnoverIds: string[]
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    if (!turnoverIds.length) return { error: 'No turnovers selected' }

    // Only completed turnovers can be archived — guard at the query level so a
    // stale client can't archive an active turnover out from under the board.
    const { error } = await supabase
      .from('turnovers')
      .update({ is_archived: true })
      .in('id', turnoverIds)
      .eq('org_id', membership.org_id)
      .eq('status', 'completed')

    if (error) {
      console.error('[archiveTurnover]', error)
      reportError(error, { site: 'serverAction.turnovers.archiveTurnover', orgId: membership.org_id })
      return { error: 'Failed to archive turnover.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.archived',
      targetType: 'turnover',
      metadata:   { turnover_ids: turnoverIds },
    })

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[archiveTurnover]', err)
    reportError(err, { site: 'serverAction.turnovers.archiveTurnover.outer' })
    return { error: 'Failed to archive turnover.' }
  }
}

export async function unarchiveTurnover(
  turnoverIds: string[]
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    if (!turnoverIds.length) return { error: 'No turnovers selected' }

    const { error } = await supabase
      .from('turnovers')
      .update({ is_archived: false })
      .in('id', turnoverIds)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[unarchiveTurnover]', error)
      reportError(error, { site: 'serverAction.turnovers.unarchiveTurnover', orgId: membership.org_id })
      return { error: 'Failed to unarchive.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.unarchived',
      targetType: 'turnover',
      metadata:   { turnover_ids: turnoverIds },
    })

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[unarchiveTurnover]', err)
    reportError(err, { site: 'serverAction.turnovers.unarchiveTurnover.outer' })
    return { error: 'Failed to unarchive.' }
  }
}

// ── Trigger manual iCal sync ─────────────────────────────────────────────────

export async function triggerManualSync(): Promise<TurnoverActionState> {
  try {
    const { membership } = await requireOrgMember()
    await inngest.send({ name: 'ical/sync.all.requested', data: { org_id: membership.org_id } })
    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[triggerManualSync]', err)
    reportError(err, { site: 'serverAction.turnovers.triggerManualSync' })
    return { error: 'Could not start the calendar sync. Try again in a moment.' }
  }
}

// ── Accept auto-assignment suggestion ────────────────────────────────────────

export async function acceptSuggestion(turnoverId: string): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const turnoverRes = await supabase
      .from('turnovers')
      .select('id, property_id, status, suggested_crew_ids')
      .eq('id', turnoverId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(turnoverRes.error, { site: 'serverAction.turnovers.acceptSuggestion', orgId: membership.org_id })) {
      return { error: 'Could not load that turnover. Please try again.' }
    }
    const turnover = turnoverRes.data
    if (!turnover) return { error: 'Turnover not found' }

    const crewIds = (turnover.suggested_crew_ids as string[] | null) ?? []
    if (!crewIds.length) return { error: 'No suggestion to accept' }

    const { error: assignError } = await supabase.from('turnover_assignments').upsert(
      crewIds.map(crewId => ({ turnover_id: turnoverId, crew_member_id: crewId, org_id: membership.org_id })),
      { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: true }
    )
    if (assignError) {
      console.error('[acceptSuggestion]', assignError)
      reportError(assignError, { site: 'serverAction.turnovers.acceptSuggestion', orgId: membership.org_id })
      return { error: 'Failed to accept suggestion. Please try again.' }
    }

    await supabase
      .from('turnovers')
      .update({ status: 'assigned', suggestion_status: 'accepted' })
      .eq('id', turnoverId)

    try {
      // Optional: feeds property_bedrooms on the outcome rows, which already
      // tolerate null. tryUnwrap so a failure is reported rather than silently
      // degrading the crew-scoring feature set. maybeSingle so an absent
      // property isn't reported as an error.
      const propertyRes = await supabase
        .from('properties')
        .select('bedrooms')
        .eq('id', turnover.property_id)
        .maybeSingle()

      const propertyOut = tryUnwrap(propertyRes, { site: 'serverAction.turnovers.acceptSuggestion.bedrooms', orgId: membership.org_id })
      const property = propertyOut.ok ? propertyOut.data : null

      const { createServiceClient } = await import('@/lib/supabase/server')
      const service = createServiceClient({ system: 'action:turnover-suggestion-tracking' })
      const { error: outcomeError } = await service.from('assignment_outcomes').upsert(
        crewIds.map(crewId => ({
          turnover_id:        turnoverId,
          org_id:             membership.org_id,
          crew_member_id:     crewId,
          was_accepted:       true,
          was_suggestion:     true,
          property_bedrooms:  property?.bedrooms ?? null,
        })),
        { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: false }
      )
      if (outcomeError) throw outcomeError
    } catch (err) {
      // Non-blocking is correct — outcome recording must not break the
      // acceptance flow — but invisible is not. Without this, assignment_outcomes
      // writes can start failing and crew-suggestion quality degrades with zero
      // operator signal.
      console.error('[acceptSuggestion] outcome recording failed', err)
      reportError(err, {
        site: 'serverAction.turnovers.acceptSuggestion.outcome',
        orgId: membership.org_id,
        extra: { turnover_id: turnoverId, crew_count: crewIds.length },
      })
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.suggestion.accepted',
      targetType: 'turnover',
      targetId:   turnoverId,
      metadata:   { crew_ids: crewIds },
    })

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[acceptSuggestion]', err)
    reportError(err, { site: 'serverAction.turnovers.acceptSuggestion.outer' })
    return { error: 'Failed to accept suggestion. Please try again.' }
  }
}

// ── Dismiss auto-assignment suggestion ───────────────────────────────────────

export async function dismissSuggestion(turnoverId: string): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    // Fails closed BEFORE the dismissal write. A silent null here left
    // crewIds empty, so the negative training signal was never recorded and the
    // audit row below affirmatively logged `crew_ids: []` for a dismissal that
    // did have suggested crew — a wrong row in the log someone reads during an
    // incident. The update is idempotent, so returning early costs nothing and
    // a retry gets both the dismissal and the outcome rows.
    const turnoverRes = await supabase
      .from('turnovers')
      .select('property_id, suggested_crew_ids')
      .eq('id', turnoverId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(turnoverRes.error, { site: 'serverAction.turnovers.dismissSuggestion', orgId: membership.org_id })) {
      return { error: 'Could not load that turnover. Please try again.' }
    }
    const turnover = turnoverRes.data

    const { error } = await supabase
      .from('turnovers')
      .update({ suggestion_status: 'dismissed' })
      .eq('id', turnoverId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[dismissSuggestion]', error)
      reportError(error, { site: 'serverAction.turnovers.dismissSuggestion', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    const crewIds = (turnover?.suggested_crew_ids as string[] | null) ?? []
    if (crewIds.length) {
      try {
        // Same optional-bedrooms read as acceptSuggestion. Written as a plain
        // guarded await rather than a ternary: a PostgREST builder inside a
        // ternary arm reads as a discarded lazy query, which is a shape worth
        // not having in the tree even when this one was awaited.
        let property: { bedrooms: number | null } | null = null
        if (turnover?.property_id) {
          const propertyRes = await supabase
            .from('properties')
            .select('bedrooms')
            .eq('id', turnover.property_id)
            .maybeSingle()

          const propertyOut = tryUnwrap(propertyRes, { site: 'serverAction.turnovers.dismissSuggestion.bedrooms', orgId: membership.org_id })
          property = propertyOut.ok ? propertyOut.data : null
        }

        const { createServiceClient } = await import('@/lib/supabase/server')
        const service = createServiceClient({ system: 'action:turnover-suggestion-tracking' })
        const { error: outcomeError } = await service.from('assignment_outcomes').upsert(
          crewIds.map(crewId => ({
            turnover_id:        turnoverId,
            org_id:             membership.org_id,
            crew_member_id:     crewId,
            was_accepted:       false,
            was_suggestion:     true,
            property_bedrooms:  property?.bedrooms ?? null,
          })),
          { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: false }
        )
        if (outcomeError) throw outcomeError
      } catch (err) {
        // Non-blocking is correct — outcome recording must not break the
        // dismissal flow — but invisible is not. See acceptSuggestion above.
        console.error('[dismissSuggestion] outcome recording failed', err)
        reportError(err, {
          site: 'serverAction.turnovers.dismissSuggestion.outcome',
          orgId: membership.org_id,
          extra: { turnover_id: turnoverId, crew_count: crewIds.length },
        })
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.suggestion.dismissed',
      targetType: 'turnover',
      targetId:   turnoverId,
      metadata:   { crew_ids: crewIds },
    })

    revalidatePath('/turnovers')
    return { success: true }
  } catch (err) {
    console.error('[dismissSuggestion]', err)
    reportError(err, { site: 'serverAction.turnovers.dismissSuggestion.outer' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── PM rating for a completed turnover ───────────────────────────────────────
//
// Feeds assignment_outcomes.pm_rating, which the nightly crew-score-recompute
// cron reads to adjust reliability_score. One rating per turnover, applied to
// every crew member assigned to it — simpler than a per-crew-member rating
// UI, and most turnovers have exactly one assignee anyway.

export async function rateTurnoverCompletion(
  turnoverId: string,
  rating: number
): Promise<TurnoverActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return { error: 'Rating must be between 1 and 5' }
    }

    const turnoverRes = await supabase
      .from('turnovers')
      .select('id, status, turnover_assignments(crew_member_id)')
      .eq('id', turnoverId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(turnoverRes.error, { site: 'serverAction.turnovers.rateTurnoverCompletion', orgId: membership.org_id })) {
      return { error: 'Could not load that turnover. Please try again.' }
    }
    const turnover = turnoverRes.data
    if (!turnover) return { error: 'Turnover not found' }
    if (turnover.status !== 'completed') return { error: 'Only completed turnovers can be rated' }

    const crewIds = (turnover.turnover_assignments ?? []).map(a => a.crew_member_id)
    if (!crewIds.length) return { error: 'No crew assigned to rate' }

    const { createServiceClient } = await import('@/lib/supabase/server')
    const service = createServiceClient({ system: 'action:turnover-suggestion-tracking' })

    const { error } = await service.from('assignment_outcomes').upsert(
      crewIds.map(crewMemberId => ({
        turnover_id:    turnoverId,
        org_id:         membership.org_id,
        crew_member_id: crewMemberId,
        pm_rating:      rating,
      })),
      { onConflict: 'turnover_id,crew_member_id', ignoreDuplicates: false }
    )

    if (error) {
      console.error('[rateTurnoverCompletion]', error)
      reportError(error, { site: 'serverAction.turnovers.rateTurnoverCompletion', orgId: membership.org_id })
      return { error: 'Failed to save rating. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'turnover.pm_rating.submitted',
      targetType: 'turnover',
      targetId:   turnoverId,
      metadata:   { rating },
    })

    revalidatePath(`/turnovers/${turnoverId}`)
    return { success: true }
  } catch (err) {
    console.error('[rateTurnoverCompletion]', err)
    reportError(err, { site: 'serverAction.turnovers.rateTurnoverCompletion.outer' })
    return { error: 'Failed to save rating. Please try again.' }
  }
}
