import 'server-only'
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { sealCheckin, notifyCheckin } from '@/lib/evidence/checkin'
import type { CheckinBody } from '@/lib/evidence/validate'
import type { CrewAuthContext } from '@/lib/crew-auth'

/**
 * The tail shared by the two crew routes that record a visit check-in (Start
 * Turnover and a later re-check-in): seal the fix into the ledger, raise the
 * PM bells it earns, and audit it.
 *
 * Returns a response only on failure. A 500 here is deliberate: the outbox
 * retries it, and the check-in insert is idempotent on its storage path, so a
 * replay recovers the row instead of writing a second one.
 */
export async function recordCrewCheckin(input: {
  auth:     CrewAuthContext
  turnover: { id: string; org_id: string; property_id: string }
  fix:      CheckinBody
}): Promise<NextResponse | null> {
  const { auth, turnover, fix } = input
  const service = createServiceClient({ crew: auth.crew })

  const result = await sealCheckin(service, {
    orgId: turnover.org_id, propertyId: turnover.property_id, turnoverId: turnover.id, crewId: auth.crew.id, fix,
  })
  if (!result.ok) return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })

  if (!result.duplicate) {
    await notifyCheckin(service, {
      orgId: turnover.org_id, propertyId: turnover.property_id, turnoverId: turnover.id, crewId: auth.crew.id, result,
    })
    await logAuditEvent({
      orgId: turnover.org_id, actorId: auth.user.id, action: 'evidence.checkin',
      targetType: 'evidence_event', targetId: result.eventId, dedupeKey: `evidence-checkin-${result.eventId}`,
      metadata: { attempt: fix.attempt, offsite: result.offsite },
    })
  }
  return null
}
