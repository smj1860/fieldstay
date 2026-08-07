import { tryUnwrap } from '@/lib/supabase/unwrap'
import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { resolveTurnoverCompletedAt } from '@/lib/turnovers/completion'
import { isCrewAssignedToTurnover } from '@/lib/turnovers/assignment'
import { logAuditEvent } from '@/lib/audit'

/**
 * POST /api/crew/turnovers/[id]/complete
 *
 * Called by the Dexie SyncEngine outbox when a crew member marks a
 * turnover complete from the crew PWA. A direct client-side Supabase write
 * can't fire Inngest events, so this route performs the status update and
 * sends `turnover/completed` (cleaning-fee posting, PM notification,
 * crew-duration tracking) — the same pipeline `updateTurnoverStatus` runs
 * for PM-initiated completions.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: turnover_id } = await params
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { user, supabase, crew } = auth

  const turnoverRes = await supabase
    .from('turnovers')
    .select('id, property_id, org_id, status, inventory_confirmed_complete_at')
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .maybeSingle()

  // 503, not 404, when the READ fails — the sibling start route was fixed for
  // exactly this and this one was not. lib/dexie/net.ts classifies 4xx as
  // TERMINAL and >=500 as transient, so answering a transient DB error with a
  // 404 DEAD-LETTERED the crew member's queued completion permanently. That is
  // worse here than on start: completion is the end of the work, so the job was
  // done, the PM never saw it finish, and the cleaning fee never posted.
  // `.single()` made it likelier still, since it raises PGRST116 for zero rows
  // and so could not be told apart from a real failure.
  const turnoverOut = tryUnwrap(turnoverRes, { site: 'api.crew.turnovers.complete', orgId: crew.org_id })
  if (!turnoverOut.ok) {
    return NextResponse.json({ error: 'Could not load the turnover. Please try again.' }, { status: 503 })
  }

  const turnover = turnoverOut.data
  if (!turnover) return NextResponse.json({ error: 'Turnover not found' }, { status: 404 })

  if (!(await isCrewAssignedToTurnover(supabase, turnover_id, crew.id))) {
    return NextResponse.json({ error: 'Turnover not found' }, { status: 404 })
  }

  // Already completed (e.g. retried upload) — no-op, don't re-fire the event.
  if (turnover.status === 'completed') {
    return NextResponse.json({ success: true })
  }

  // A cancelled turnover must not be completable. Nothing removes a cancelled
  // turnover from the crew's Dexie cache and no crew screen checks the status,
  // so a PM cancelling a job the crew already has offline left it looking
  // perfectly normal and tappable. Completing it fired turnover/completed,
  // which posts a cleaning_fee to the owner's ledger — a real charge for work
  // that was called off. Production holds 6 cancelled turnovers, so this is a
  // reachable state, not a theoretical one.
  //
  // 409, deliberately: lib/dexie/net.ts treats 4xx as terminal, and that is
  // correct here — replaying this can never succeed. It dead-letters into the
  // failed-sync banner where the crew member can see WHY, which is the honest
  // outcome. Silently answering success would tell them the job was recorded.
  if (turnover.status === 'cancelled') {
    return NextResponse.json(
      { error: 'This turnover was cancelled. Check with your manager before doing any more work on it.' },
      { status: 409 },
    )
  }

  const checklistRes = await supabase
    .from('checklist_instances')
    .select('completed_at')
    .eq('turnover_id', turnover_id)
    .maybeSingle()

  // Also 503 rather than a swallowed null: a failed read here silently changed
  // the RECORDED COMPLETION TIME. resolveTurnoverCompletedAt falls back to
  // wall-clock when either confirmation timestamp is missing, so a transient
  // error would have stamped "now" instead of when the crew actually finished
  // — and that timestamp is what crew duration, assignment_outcomes and crew
  // scoring are all derived from.
  const checklistOut = tryUnwrap(checklistRes, { site: 'api.crew.turnovers.complete.checklist', orgId: crew.org_id })
  if (!checklistOut.ok) {
    return NextResponse.json({ error: 'Could not load the turnover. Please try again.' }, { status: 503 })
  }
  const checklistInstance = checklistOut.data

  // When completion was driven by both the "Confirm Checklist Complete"
  // and "Confirm Inventory Complete" checkboxes, completed_at should
  // reflect whichever of those two was confirmed LAST — not the wall-clock
  // moment this route happened to run, which lags behind by however long
  // it took a device to notice the second confirmation (network latency,
  // or the crew tapping the still-present manual button afterward).
  const completedAt = resolveTurnoverCompletedAt(
    checklistInstance?.completed_at ?? null,
    turnover.inventory_confirmed_complete_at ?? null,
  )

  // The WHERE clause (not the earlier read) is the real guard against a
  // concurrent duplicate request completing the turnover twice — .neq
  // ensures only one racing request's UPDATE actually matches a row.
  const { data: updated, error } = await supabase
    .from('turnovers')
    .update({ status: 'completed', completed_at: completedAt })
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .neq('status', 'completed')
    // Belt to the early return above's braces: the status could change between
    // that read and this write, and a cancel is exactly the change that races.
    .neq('status', 'cancelled')
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[CrewTurnoverComplete]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // Lost the race to a concurrent request — it already completed this
  // turnover and will fire the event, so don't re-fire it here.
  if (!updated) {
    return NextResponse.json({ success: true })
  }

  await inngest.send({
    name: 'turnover/completed',
    data: {
      turnover_id,
      property_id:          turnover.property_id,
      org_id:               turnover.org_id,
      completed_by_crew_id: crew.id,
      completed_at:         completedAt,
    },
  })

  await logAuditEvent({
    orgId:      turnover.org_id,
    actorId:    user.id,
    action:     'turnover.completed',
    targetType: 'turnover',
    targetId:   turnover_id,
  })

  return NextResponse.json({ success: true })
}
