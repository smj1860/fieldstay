import { NextRequest, NextResponse } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { loadCrewTurnoverContext } from '@/lib/turnovers/crew-route-context'
import { recordCrewCheckin } from '@/lib/turnovers/crew-checkin'
import { parseCheckinBody } from '@/lib/evidence/validate'
import { logAuditEvent } from '@/lib/audit'
import type { CrewAuthContext } from '@/lib/crew-auth'

/**
 * POST /api/crew/turnovers/[id]/start
 *
 * Called by the Dexie SyncEngine outbox when a crew member taps
 * "Start Turnover" in the crew PWA. Routes through the server so
 * started_at is set authoritatively (not from client clock) and the
 * transition is validated against crew membership.
 *
 * The body carries the visit CHECK-IN: the device's location fix at the tap.
 * A turnover does not start without one, because the check-in is what turns the
 * photos taken during the visit into evidence that the crew was at the property.
 * The fix is recorded in the evidence ledger; see lib/evidence/checkin.ts.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: turnover_id } = await params

  // Auth, org-scoped load and the assignment check all live in one place —
  // see lib/turnovers/crew-route-context.ts for why they are not inlined here.
  const ctx = await loadCrewTurnoverContext<{ id: string; org_id: string; status: string; property_id: string }>(
    turnover_id,
    'id, org_id, status, property_id',
    'api.crew.turnovers.start',
  )
  if (!ctx.ok) return ctx.response

  const { user, supabase, crew } = ctx.auth
  const turnover = ctx.turnover

  // 400 is TERMINAL for the outbox, which is the point for a start queued by a
  // build that predates check-ins: it dead-letters visibly rather than starting
  // a turnover with no record of where the crew was.
  const body = await request.json().catch(() => null)
  const fix = parseCheckinBody((body as { checkin?: unknown } | null)?.checkin)
  if (!fix) return NextResponse.json({ error: 'Check-in location required' }, { status: 400 })

  // Cancelled or completed: nothing to start and nothing to check in to.
  if (turnover.status !== 'assigned' && turnover.status !== 'in_progress') {
    return NextResponse.json({ success: true })
  }

  if (turnover.status === 'assigned') {
    const started = await startTurnoverRow({ supabase, turnover_id, orgId: crew.org_id })
    if (started === 'error') return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
    if (started.startedAt) {
      await inngest.send({
        name: 'turnover/started',
        data: {
          turnover_id,
          org_id:             turnover.org_id,
          started_by_crew_id: crew.id,
          started_at:         started.startedAt,
        },
      })
      await logAuditEvent({
        orgId:      turnover.org_id,
        actorId:    user.id,
        action:     'turnover.started',
        targetType: 'turnover',
        targetId:   turnover_id,
      })
    }
  }

  // Always attempted, even when the turnover was already in progress: if an
  // earlier attempt landed the status change and then failed to record the
  // check-in, this retry is the only thing that ever will. The insert collides
  // on its storage path and is recovered, so a replay writes nothing twice.
  const failed = await recordCrewCheckin({
    auth: { user, supabase, crew }, turnover: { id: turnover_id, org_id: turnover.org_id, property_id: turnover.property_id }, fix,
  })
  if (failed) return failed

  return NextResponse.json({ success: true })
}

/**
 * The WHERE clause (not the earlier read) is the real guard against a
 * concurrent duplicate request starting the turnover twice: only one racing
 * request's UPDATE actually matches a row. `startedAt` is null when this
 * request lost that race, so it does not fire the event a second time.
 */
async function startTurnoverRow(input: {
  supabase: CrewAuthContext['supabase']; turnover_id: string; orgId: string
}): Promise<'error' | { startedAt: string | null }> {
  const startedAt = new Date().toISOString()
  const { data: updated, error } = await input.supabase
    .from('turnovers')
    .update({ status: 'in_progress', started_at: startedAt })
    .eq('id', input.turnover_id)
    .eq('org_id', input.orgId)
    .eq('status', 'assigned')
    .select('id')
    .maybeSingle()
  if (error) {
    console.error('[CrewTurnoverStart]', error)
    return 'error'
  }
  return { startedAt: updated ? startedAt : null }
}
