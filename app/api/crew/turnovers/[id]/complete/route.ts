import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { resolveTurnoverCompletedAt } from '@/lib/turnovers/completion'
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

  const { data: turnover } = await supabase
    .from('turnovers')
    .select('id, property_id, org_id, status, inventory_confirmed_complete_at')
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .single()

  if (!turnover) return NextResponse.json({ error: 'Turnover not found' }, { status: 404 })

  // Already completed (e.g. retried upload) — no-op, don't re-fire the event.
  if (turnover.status === 'completed') {
    return NextResponse.json({ success: true })
  }

  const { data: checklistInstance } = await supabase
    .from('checklist_instances')
    .select('completed_at')
    .eq('turnover_id', turnover_id)
    .maybeSingle()

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
