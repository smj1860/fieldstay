// Thumbtack Request Flow Widget postMessage events — pure logic, no DOM/React,
// so origin validation and event-shape parsing can be unit tested directly
// rather than only through a rendered component. See components/thumbtack/
// RequestFlowModal.tsx for the useEffect that calls resolveThumbtackMessage().

export type ThumbtackRfEvent =
  | { type: 'THUMBTACK_RF_START'; data: { category_pk: string; zip_code: string; business_pk: string; business_name: string } }
  | { type: 'THUMBTACK_RF_REQUEST_CREATED'; data: {
      businesses_contacted: { business_pk: string; business_name: string }[]
      category_pk: string
      zip_code: string
      user_pk: string
      created_at: number
      is_existing_user: boolean
      search_id: string
      request_pk: string
    } }
  | { type: 'THUMBTACK_RF_CLOSE' }

type StartData = Extract<ThumbtackRfEvent, { type: 'THUMBTACK_RF_START' }>['data']
type RequestCreatedData = Extract<ThumbtackRfEvent, { type: 'THUMBTACK_RF_REQUEST_CREATED' }>['data']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isStartData(data: unknown): data is StartData {
  return (
    isRecord(data) &&
    typeof data.category_pk === 'string' &&
    typeof data.zip_code === 'string' &&
    typeof data.business_pk === 'string' &&
    typeof data.business_name === 'string'
  )
}

function isRequestCreatedData(data: unknown): data is RequestCreatedData {
  return (
    isRecord(data) &&
    Array.isArray(data.businesses_contacted) &&
    data.businesses_contacted.every((b) =>
      isRecord(b) && typeof b.business_pk === 'string' && typeof b.business_name === 'string',
    ) &&
    typeof data.category_pk === 'string' &&
    typeof data.zip_code === 'string' &&
    typeof data.user_pk === 'string' &&
    typeof data.created_at === 'number' &&
    typeof data.is_existing_user === 'boolean' &&
    typeof data.search_id === 'string' &&
    typeof data.request_pk === 'string'
  )
}

/**
 * Validates BOTH the `type` discriminant AND the shape of `data` for it —
 * not just the discriminant. A `THUMBTACK_RF_REQUEST_CREATED` event whose
 * `data` is missing or malformed used to pass this guard on the strength of
 * its `type` string alone, then reach recordThumbtackRequestCreatedAction
 * (lib/integrations/thumbtack-actions.ts), which reads
 * `event.businesses_contacted.map(...)` and several other fields directly —
 * a Server Action crash from a same-origin but malformed postMessage, not
 * merely a client-side display bug.
 */
export function isThumbtackRfEvent(data: unknown): data is ThumbtackRfEvent {
  if (!isRecord(data) || typeof data.type !== 'string') return false

  switch (data.type) {
    case 'THUMBTACK_RF_START':            return isStartData(data.data)
    case 'THUMBTACK_RF_REQUEST_CREATED':  return isRequestCreatedData(data.data)
    case 'THUMBTACK_RF_CLOSE':            return true
    default:                              return false
  }
}

/**
 * Validates a `message` event's origin against the iframe's own URL origin
 * (never a separately-configured value, which could drift from what's
 * actually loaded) and parses its Thumbtack event shape. Returns `null` for
 * anything that fails either check — a message from an unrelated frame, or
 * one that merely resembles the shape without matching it.
 */
export function resolveThumbtackMessage(
  event: { origin: string; data: unknown },
  expectedOrigin: string,
): ThumbtackRfEvent | null {
  if (event.origin !== expectedOrigin) return null
  if (!isThumbtackRfEvent(event.data)) return null
  return event.data
}
