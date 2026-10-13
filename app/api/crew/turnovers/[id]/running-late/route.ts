import { NextRequest, NextResponse } from 'next/server'
import { loadCrewTurnoverContext } from '@/lib/turnovers/crew-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { logAuditEvent } from '@/lib/audit'

/**
 * POST /api/crew/turnovers/[id]/running-late
 *
 * The crew member's own "I am running late" tap, drained from the Dexie
 * outbox. The other direction from the cascade alert: that one INFERS lateness
 * from a checklist that is behind, this is the person saying so before any
 * inference could know.
 *
 * Routed through the server rather than written straight to the table because
 * it has a side effect the crew client cannot perform: the PM notification.
 * Same reason /start and /complete are routes.
 */

/**
 * How far back a queued signal may claim to have been raised.
 *
 * The timestamp comes from the CLIENT, deliberately: a tap made in a basement
 * with no signal may not reach us for hours, and stamping it with the server
 * clock on arrival would tell the PM a cleaner raised a flag at noon when they
 * raised it at ten. What the client cannot be trusted with is an arbitrary
 * value, so it is clamped into a plausible window and anything outside falls
 * back to now.
 */
const MAX_SIGNAL_AGE_MS = 24 * 60 * 60 * 1000

function raisedAtFrom(body: unknown): string {
  const now = Date.now()
  const claimed = (body as { crew_running_late_at?: unknown } | null)?.crew_running_late_at

  if (typeof claimed !== 'string') return new Date(now).toISOString()

  const parsed = Date.parse(claimed)
  if (Number.isNaN(parsed)) return new Date(now).toISOString()
  // A future timestamp is a wrong device clock, not a prediction.
  if (parsed > now) return new Date(now).toISOString()
  if (now - parsed > MAX_SIGNAL_AGE_MS) return new Date(now).toISOString()

  return new Date(parsed).toISOString()
}

interface TurnoverRow {
  id:                   string
  org_id:               string
  crew_running_late_at: string | null
  properties: { name: string | null } | { name: string | null }[] | null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: turnover_id } = await params

  const ctx = await loadCrewTurnoverContext<TurnoverRow>(
    turnover_id,
    'id, org_id, crew_running_late_at, properties ( name )',
    'api.crew.turnovers.running-late',
  )
  if (!ctx.ok) return ctx.response

  const { user, supabase, crew } = ctx.auth
  const turnover = ctx.turnover

  // Already flagged — a retried upload, or a second tap. Idempotent: the FIRST
  // raise is the one that matters, and re-notifying a PM who has already been
  // told adds noise without adding information.
  if (turnover.crew_running_late_at) {
    return NextResponse.json({ success: true })
  }

  const body = await request.json().catch(() => null)
  const raisedAt = raisedAtFrom(body)

  // .is('crew_running_late_at', null) in the WHERE, not just the read above:
  // the read cannot stop two concurrent uploads from both passing the check,
  // and this makes exactly one of them match a row.
  const { data: updated, error } = await supabase
    .from('turnovers')
    .update({
      crew_running_late_at:                raisedAt,
      crew_running_late_by_crew_member_id: crew.id,
    })
    .eq('id', turnover_id)
    .eq('org_id', crew.org_id)
    .is('crew_running_late_at', null)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[CrewTurnoverRunningLate]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  // Lost the race to a concurrent request, which has already notified.
  if (!updated) return NextResponse.json({ success: true })

  // Service role for the notification only: `notifications` is system-inserted
  // and org members hold no write path to it (see 20260824001028).
  const property = unwrapJoin(turnover.properties)
  await createPmNotification(createServiceClient({ crew }), {
    orgId:    turnover.org_id,
    type:     'turnover.crew_running_late',
    // The property leads, not the crew member: the PM's question is which job
    // is at risk. requireCrewMember's context carries no name, and a lookup
    // just to put one in a title is a round trip for decoration.
    title:    property?.name
      ? `${property.name}: crew flagged running late`
      : 'A crew member flagged running late',
    subtitle: 'They raised it themselves, so this is ahead of anything the checklist shows. Open the turnover to see where it stands.',
    href:      `/turnovers/${turnover_id}`,
    severity:  'amber',
    // One per turnover, not per day: a second tap on the same job carries no
    // information the first did not.
    dedupeKey: `crew-late:${turnover_id}`,
  })

  await logAuditEvent({
    orgId:      turnover.org_id,
    actorId:    user.id,
    action:     'turnover.crew_running_late',
    targetType: 'turnover',
    targetId:   turnover_id,
  })

  return NextResponse.json({ success: true })
}
