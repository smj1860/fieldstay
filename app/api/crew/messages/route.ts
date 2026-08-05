import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { getPmMembers } from '@/lib/inngest/helpers'
import { reportError } from '@/lib/observability/report-error'

/**
 * POST /api/crew/messages
 *
 * Drained by the Dexie outbox when a crew member sends a message.
 *
 * Messages used to be the one crew-facing action that was not offline-safe:
 * The previous `sendMessageToPM` Server Action sent inline, so a message
 * composed at a property with no signal simply failed, and the crew FAQ had an
 * entry telling crew not to trust that it queued. (That action was deleted
 * 2026-08-05 — this route is the only crew→PM send path.) Routing the send through the outbox makes
 * it behave like every other crew write — retried, backed off, and surfaced in
 * the failed-sync banner if it never lands.
 *
 * `messageId` is the client-generated primary key, so a replay after a dropped
 * response collides on the PK instead of sending the same message twice.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)

  const messageId = typeof body?.messageId === 'string' ? body.messageId : null
  const content   = typeof body?.content === 'string' ? body.content.trim() : ''

  if (!messageId) return NextResponse.json({ error: 'Missing messageId' }, { status: 400 })
  if (!content)   return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400 })

  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { supabase, crew } = auth

  // Crew members have no RLS visibility into organization_members (they are
  // not members of the org themselves), so resolving a recipient needs the
  // service client. getPmMembers() is the one place that applies the
  // invite_accepted_at filter AND the owner → admin → manager ordering — an
  // inline query with no ORDER BY would be free to route two messages minutes
  // apart to two different inboxes.
  const admin = createServiceClient({ crew })
  const [primaryPm] = await getPmMembers(admin, crew.org_id, {
    roles: ['owner', 'admin', 'manager'],
    limit: 1,
  })

  if (!primaryPm) {
    // 404 is deliberate: lib/dexie/net.ts treats 4xx as terminal, and an org
    // with no reachable operations contact will not start having one because
    // the device retried. It dead-letters into the failed-sync banner where
    // the crew member can see the message never went anywhere.
    return NextResponse.json({ error: 'No operations contact found' }, { status: 404 })
  }

  const { error } = await supabase
    .from('messages')
    .insert({
      id:           messageId,
      org_id:       crew.org_id,
      sender_id:    auth.user.id,
      recipient_id: primaryPm.userId,
      content,
    })

  if (error) {
    // 23505 = the outbox replayed a message that already landed (a dropped
    // 200, however much later the retry ran). Same id means same message.
    if (error.code === '23505') return NextResponse.json({ success: true, duplicate: true })
    // Deliberately does not log `content` — a crew message is free text.
    console.error('[CrewMessageSend] insert failed:', error.code, error.message)
    reportError(new Error(`crew message insert failed: ${error.code}`), {
      site:  'api.crew.messages',
      orgId: crew.org_id,
    })
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
