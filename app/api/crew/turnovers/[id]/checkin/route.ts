import { NextRequest, NextResponse } from 'next/server'
import { loadCrewTurnoverContext } from '@/lib/turnovers/crew-route-context'
import { recordCrewCheckin } from '@/lib/turnovers/crew-checkin'
import { parseCheckinBody } from '@/lib/evidence/validate'
import { checkLimit, retryAfterSeconds, evidenceSealRatelimit } from '@/lib/rate-limit'

/**
 * POST /api/crew/turnovers/[id]/checkin
 *
 * A later check-in during a visit already under way ("Check in again"): a crew
 * member who started the turnover from the driveway and has since walked to the
 * unit, or whose first fix was poor. The first check-in rides on the start route.
 *
 * Only an in-progress turnover accepts one. 4xx is terminal for the outbox, so a
 * check-in against a turnover that finished while the device was offline
 * dead-letters visibly rather than being filed against a closed visit.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: turnover_id } = await params

  const ctx = await loadCrewTurnoverContext<{ id: string; org_id: string; status: string; property_id: string }>(
    turnover_id,
    'id, org_id, status, property_id',
    'api.crew.turnovers.checkin',
  )
  if (!ctx.ok) return ctx.response

  const { user, supabase, crew } = ctx.auth
  const turnover = ctx.turnover

  const body = await request.json().catch(() => null)
  const fix = parseCheckinBody((body as { checkin?: unknown } | null)?.checkin)
  if (!fix) return NextResponse.json({ error: 'Check-in location required' }, { status: 400 })

  const decision = await checkLimit(evidenceSealRatelimit, crew.id, {
    onError: 'allow',   // a Redis outage must not block an outbox drain
    site:    'route.crew.turnovers.checkin.POST',
  })
  if (!decision.allowed) {
    return NextResponse.json({ error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(decision)) } })
  }

  if (turnover.status !== 'in_progress') {
    return NextResponse.json({ error: 'Turnover is not in progress' }, { status: 409 })
  }

  const failed = await recordCrewCheckin({
    auth: { user, supabase, crew }, turnover: { id: turnover_id, org_id: turnover.org_id, property_id: turnover.property_id }, fix,
  })
  if (failed) return failed

  return NextResponse.json({ success: true })
}
