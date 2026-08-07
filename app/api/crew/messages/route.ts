import { NextRequest, NextResponse, after } from 'next/server'
import { safeFetch } from '@/lib/security/url-guard'
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
/**
 * Non-fatal Slack ping when a crew member messages the PM, if the org has
 * configured an Incoming Webhook URL.
 *
 * RESTORED 2026-08-05. This lived in sendMessageToPM, the Server Action this
 * route replaced — and when messaging moved to the outbox it was the only
 * caller of postToSlack(), which was the only reader of
 * organizations.slack_webhook_url. So the notification silently stopped while
 * Settings kept showing (and saving) a "Slack Webhook URL" field that did
 * nothing. Only found because deleting the dead action orphaned the helper.
 *
 * Two things the original did NOT do, and must:
 *
 *  • safeFetch, not fetch. slack_webhook_url is TENANT-SUPPLIED — a PM types
 *    it into Settings — so a raw fetch is a server-side request forgery
 *    primitive pointed at whatever they enter (link-local metadata, an
 *    internal address, a plaintext downgrade via redirect). safeFetch
 *    re-validates every redirect hop and carries its own timeout budget; a
 *    bare fetch had neither.
 *  • Read the webhook with the SERVICE client. Crew are not members of the
 *    org, so they have no RLS visibility into `organizations` — the original
 *    read it with the caller's client, which worked only because a PM was the
 *    caller.
 *
 * Never logs message content: a crew message is free text.
 */
async function notifyPmSlack(
  admin:   ReturnType<typeof createServiceClient>,
  orgId:   string,
  crewId:  string,
  content: string,
): Promise<void> {
  try {
    const [{ data: org, error: orgError }, { data: crewRow, error: crewError }] = await Promise.all([
      admin.from('organizations').select('slack_webhook_url').eq('id', orgId).maybeSingle(),
      admin.from('crew_members').select('name').eq('id', crewId).eq('org_id', orgId).maybeSingle(),
    ])

    if (orgError) {
      console.error('[CrewMessageSend] slack webhook lookup failed:', orgError.code)
      reportError(new Error(`slack webhook lookup failed: ${orgError.code}`), {
        site: 'api.crew.messages.slack', orgId,
      })
      return
    }
    if (!org?.slack_webhook_url) return

    // The name is cosmetic and has a fallback, but "the read failed" and "the
    // crew row has no name" are still different facts — the first is worth
    // knowing about, and collapsing them is the defect this whole ratchet
    // exists to stop.
    if (crewError) {
      console.error('[CrewMessageSend] crew name lookup failed:', crewError.code)
      reportError(new Error(`crew name lookup failed: ${crewError.code}`), {
        site: 'api.crew.messages.slack', orgId,
      })
    }
    const name = crewRow?.name ?? 'A crew member'

    await safeFetch(org.slack_webhook_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text: `\u{1F4AC} *${name}* sent you a message on FieldStay:\n>${content}`,
      }),
    })
  } catch (err) {
    // Non-fatal in every direction — the message is already committed, and a
    // misconfigured or hostile webhook URL must not fail a crew member's send.
    console.error('[CrewMessageSend] slack notify failed')
    reportError(err, { site: 'api.crew.messages.slack', orgId })
  }
}

/**
 * messages.id is a `uuid` column, so a non-uuid messageId does not fail a type
 * check — it reaches Postgres, raises 22P02, and is answered with a 500. That
 * matters here more than it looks: lib/dexie/net.ts treats >=500 as TRANSIENT,
 * so the outbox would retry that send FOREVER — never draining, keeping the
 * logout "unsynced work" warning armed permanently, and staying invisible to
 * the dead-letter banner because a transport failure never sets the `failed`
 * flag.
 *
 * Not reachable from our own client (queueMessageToPM uses crypto.randomUUID),
 * which is exactly why it is worth asserting at the boundary rather than
 * assuming: the sibling crew route that takes a client-generated id
 * (/api/crew/inventory-count) already validates its own, and this one is the
 * copy that did not.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `content` is unbounded `text` in the database and has no maxLength on the
 * composer, so a paste is stored verbatim AND pushed into the Slack webhook
 * body. Bounded at the boundary, with a matching maxLength on the textarea so
 * a crew member is stopped while typing rather than after tapping send.
 */
const MAX_MESSAGE_LENGTH = 2000

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)

  const messageId = typeof body?.messageId === 'string' ? body.messageId : null
  const content   = typeof body?.content === 'string' ? body.content.trim() : ''

  if (!messageId) return NextResponse.json({ error: 'Missing messageId' }, { status: 400 })
  if (!UUID_RE.test(messageId)) {
    return NextResponse.json({ error: 'Invalid messageId' }, { status: 400 })
  }
  if (!content)   return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400 })
  if (content.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Message is too long — please keep it under ${MAX_MESSAGE_LENGTH} characters.` },
      { status: 400 },
    )
  }

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

  // after(): the message is committed and the crew device is waiting on this
  // response to clear its outbox — a slow webhook must not hold that open.
  after(() => notifyPmSlack(admin, crew.org_id, crew.id, content))

  return NextResponse.json({ success: true })
}
