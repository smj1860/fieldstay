// lib/integrations/providers/hospitable-message-store.ts
// ============================================================================
// Stores one Hospitable guest/host message, straight from the webhook payload.
//
// WHY THERE IS NO FETCH HERE.
//
// message.created used to dispatch an Inngest run that called
// GET /reservations/{uuid}/messages and upserted the thread. A real payload
// captured on 2026-08-20 shows why that could never work:
//
//   "data": {
//     "id": 1262483200,                 ← the MESSAGE's id, and NUMERIC
//     "reservation_id": null,           ← genuinely absent, see below
//     "conversation_id": "52f34b56-…",  ← a UUID, always present
//     "body": "Hi Sravan, …",           ← the message itself is RIGHT HERE
//     "sender_type": "host",
//     "created_at": "2026-08-20T05:16:12Z",
//     "property": { "id": "2a0edb20-…", … },
//     "attachments": [], "content_type": "text/plain", "platform": "airbnb"
//   }
//
// Three consequences, in order of how much they cost:
//
//  1. The payload is COMPLETE. Every column reservation_messages stores is in
//     it. The fetch was re-requesting data we had already been handed — and
//     that fetch is what 400'd, what burned 5 retries × 10m41s against an
//     endpoint capped at 2 requests/minute per reservation, and what held one
//     of eight Inngest concurrency slots while doing it.
//
//  2. reservation_id: null is CORRECT, not a gap. This is a pre-booking
//     inquiry — a guest asking about a property that has no reservation yet.
//     A design that can only store messages belonging to a reservation drops
//     every inquiry, permanently, which is the half of the inbox a PM most
//     needs to answer.
//
//  3. conversation_id is the real thread key. reservation_id is an optional
//     attribute of a thread, not its identity.
//
// Written inline from the webhook rather than dispatched to Inngest, for one
// reason beyond simplicity: an Inngest event carrying `body` would copy every
// guest message into a third-party job queue's retained event history. The
// route is already built for an inline write that can fail — a throw here
// releases the dedup claim and returns 500, so Hospitable's own retry
// redelivers (see app/api/webhooks/[provider]/route.ts).
// ============================================================================

import { createServiceClient } from '@/lib/supabase/server'
import { resolveHospitableOrg } from '@/lib/integrations/providers/hospitable-owner'
import { reportError } from '@/lib/observability/report-error'
import { isUuid } from '@/lib/validation/uuid'
import type { Json } from '@/types/database'

const PROVIDER = 'hospitable'

/**
 * The subset of Hospitable's message webhook body this module reads.
 *
 * Deliberately narrower than HospitableMessage in hospitable.types.ts: that
 * type describes the REST list response, and the two shapes differ — the
 * webhook carries `id`, `property` and `listing`, which the list response does
 * not. Typed loosely on purpose (the payload is unverified external input) and
 * narrowed by the guards below rather than by a cast.
 */
export interface HospitableWebhookMessage {
  id?:              unknown
  body?:            unknown
  source?:          unknown
  platform?:        unknown
  platform_id?:     unknown
  sender_type?:     unknown
  content_type?:    unknown
  created_at?:      unknown
  attachments?:     unknown
  reservation_id?:  unknown
  conversation_id?: unknown
  sender?:          { full_name?: unknown; first_name?: unknown } | null
  property?:        { id?: unknown } | null
  user?:            { id?: unknown } | null
}

export type StoreMessageOutcome =
  | { stored: true;  orgId: string }
  | { stored: false; reason: 'unusable_payload' | 'no_active_connection' }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * A stable, exact dedup key.
 *
 * Hospitable's REST list response exposes no per-message id, which is why the
 * old path hashed conversation_id + created_at + sender_type + body. The
 * WEBHOOK does expose one (`data.id`), so a message that arrives twice — a
 * redelivery, or a message.updated for an edit — lands on the same row instead
 * of relying on every hashed field being byte-identical.
 *
 * Prefixed and namespaced so it cannot collide with the 57 rows already stored
 * under the old sha256 scheme. Those rows are not migrated: nothing will
 * re-deliver them, and rewriting historical keys to a scheme they were not
 * written with buys nothing.
 */
function dedupKeyFor(messageId: string): string {
  return `hosp:msg:${messageId}`
}

/**
 * Writes one message. Idempotent.
 *
 * @returns what happened, for the caller to log. Never throws for a payload
 *          problem — only for a genuine infrastructure failure, which the
 *          webhook route turns into a 500 and a provider retry.
 */
export async function storeHospitableWebhookMessage(
  data:   HospitableWebhookMessage,
  action: string,
): Promise<StoreMessageOutcome> {
  // `data.id` is the message id. Numeric in the observed payload, so it is
  // normalised rather than type-checked — the old code's `as string` cast over
  // exactly this field is what put 1262483200 into a URL path.
  const messageId =
    typeof data.id === 'number' ? String(data.id) : str(data.id)

  const conversationId = str(data.conversation_id)
  const createdAt      = str(data.created_at)
  const senderType     = data.sender_type === 'host' || data.sender_type === 'guest'
    ? data.sender_type
    : null

  if (!messageId || !conversationId || !createdAt || !senderType) {
    // Field NAMES and TYPES only — this payload carries guest message content.
    const shape = ['id', 'conversation_id', 'created_at', 'sender_type', 'reservation_id', 'property']
      .map((f) => `${f}:${f in data ? typeof (data as Record<string, unknown>)[f] : 'absent'}`)
      .join(', ')

    console.warn(`[Hospitable ${action}] unusable message payload — ${shape}`)
    reportError(new Error('Hospitable message webhook missing required fields'), {
      site:  'lib.integrations.providers.hospitable-message-store',
      extra: { action, shape },
    })
    return { stored: false, reason: 'unusable_payload' }
  }

  // Attribution goes through the shared resolver, never by picking an active
  // connection here. The PROPERTY id is the entity to resolve on: it is the
  // only id in this payload that names something we also store, and on an
  // inquiry there is no reservation to resolve against at all.
  //
  // externalUserId is passed so the resolver's direct-attribution step
  // short-circuits before any lookup — it is `data.user.id`, the same value
  // integration_connections.external_user_id holds from OAuth.
  const propertyId = str(data.property?.id)
  if (!propertyId) {
    console.warn(`[Hospitable ${action}] message has no property id — cannot attribute to an org`)
    reportError(new Error('Hospitable message webhook has no property id'), {
      site:  'lib.integrations.providers.hospitable-message-store',
      extra: { action },
    })
    return { stored: false, reason: 'unusable_payload' }
  }

  const owner = await resolveHospitableOrg({
    entityKind:     'property',
    externalId:     propertyId,
    externalUserId: str(data.user?.id) ?? undefined,
  })

  if (!owner) return { stored: false, reason: 'no_active_connection' }

  const supabase = createServiceClient({ publicSurface: 'hospitable-message-webhook' })

  // Only a real reservation UUID is stored. `null` is the normal value for an
  // inquiry, and the column is nullable for exactly that reason
  // (20260820163000). isUuid, not a truthiness check: the whole incident this
  // module replaces began with a non-UUID being trusted as a reservation id.
  const reservationId = isUuid(data.reservation_id) ? data.reservation_id : null

  // Linked to a booking only when one exists AND belongs to the resolved org.
  // An unscoped lookup would match a co-hosted twin in another customer's org.
  let bookingId: string | null = null
  if (reservationId) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('id')
      .eq('org_id',          owner.orgId)
      .eq('external_id',     reservationId)
      .eq('external_source', PROVIDER)
      .maybeSingle()

    // Thrown, not swallowed: a failed read here previously stored the message
    // with a null booking_id, detached from the stay it belongs to, and
    // nothing re-links it afterwards.
    if (error) throw new Error(`booking lookup failed: ${error.message}`)
    bookingId = booking?.id ?? null
  }

  const attachments = Array.isArray(data.attachments) ? (data.attachments as Json[]) : null

  const { error: upsertErr } = await supabase
    .from('reservation_messages')
    .upsert({
      org_id:                  owner.orgId,
      booking_id:              bookingId,
      external_reservation_id: reservationId,
      external_source:         PROVIDER,
      conversation_id:         conversationId,
      platform:                str(data.platform),
      sender_type:             senderType,
      sender_name:             str(data.sender?.full_name) ?? str(data.sender?.first_name),
      content_type:            str(data.content_type),
      body:                    str(data.body),
      attachments,
      source:                  str(data.source),
      message_created_at:      createdAt,
      dedup_key:               dedupKeyFor(messageId),
    }, {
      // ignoreDuplicates: false, unlike the path this replaces. message.updated
      // carries the same data.id as its message.created, so an edited message
      // must overwrite its row rather than be discarded as a duplicate.
      onConflict:       'org_id,dedup_key',
      ignoreDuplicates: false,
    })

  if (upsertErr) throw new Error(`reservation_messages upsert failed: ${upsertErr.message}`)

  return { stored: true, orgId: owner.orgId }
}
