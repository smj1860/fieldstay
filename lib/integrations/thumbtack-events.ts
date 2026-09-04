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

export function isThumbtackRfEvent(data: unknown): data is ThumbtackRfEvent {
  return (
    typeof data === 'object' && data !== null && 'type' in data &&
    typeof (data as { type: unknown }).type === 'string' &&
    (data as { type: string }).type.startsWith('THUMBTACK_RF_')
  )
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
