import { NextRequest, NextResponse } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { loadCrewTurnoverContext } from '@/lib/turnovers/crew-route-context'
import { logAuditEvent } from '@/lib/audit'

/**
 * POST /api/crew/turnovers/[id]/start
 *
 * Called by the Dexie SyncEngine outbox when a crew member taps
 * "Start Turnover" in the crew PWA. Routes through the server so
 * started_at is set authoritatively (not from client clock) and the
 * transition is validated against crew membership.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: turnover_id } = await params

  // Auth, org-scoped load and the assignment check all live in one place —
  // see lib/turnovers/crew-route-context.ts for why they are not inlined here.
  const ctx = await loadCrewTurnoverContext<{ id: string; org_id: string; status: string }>(
    turnover_id,
    'id, org_id, status',
    'api.crew.turnovers.start',
  )
  if (!ctx.ok) return ctx.response

  const { user, supabase, crew } = ctx.auth
  const turnover = ctx.turnover

  // Already in progress or further along — no-op (safe for retried uploads)
  if (turnover.status !== 'assigned') {
    return NextResponse.json({ success: true })
  }

  const startedAt = new Date().toISOString()

  // The WHERE clause (not the earlier read) is the real guard against a
  // concurrent duplicate request starting the turnover twice — .eq('status',
  // 'assigned') ensures only one racing request's UPDATE actually matches a row.
  const { data: updated, error } = await supabase
    .from('turnovers')
    .update({
      status:     'in_progress',
      started_at: startedAt,
    })
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .eq('status', 'assigned')
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[CrewTurnoverStart]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // Lost the race to a concurrent request — it already started this
  // turnover and will fire the event, so don't re-fire it here.
  if (!updated) {
    return NextResponse.json({ success: true })
  }

  await inngest.send({
    name: 'turnover/started',
    data: {
      turnover_id,
      org_id:             turnover.org_id,
      started_by_crew_id: crew.id,
      started_at:         startedAt,
    },
  })

  await logAuditEvent({
    orgId:      turnover.org_id,
    actorId:    user.id,
    action:     'turnover.started',
    targetType: 'turnover',
    targetId:   turnover_id,
  })

  return NextResponse.json({ success: true })
}
