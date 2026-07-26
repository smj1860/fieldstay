import { Inngest, EventSchemas } from 'inngest'
import type { FieldStayEvents } from './events'

/**
 * Inngest client — single instance shared across all functions.
 * Import this wherever you need to send events or define functions.
 */
export const inngest = new Inngest({
  id: 'fieldstay',
  name: 'FieldStay',
  schemas: new EventSchemas().fromRecord<FieldStayEvents>(),
})

/**
 * Fire-and-forget event send for user-facing mutations whose DB write has
 * already committed by the time this is called: the caller returns success
 * to the user without blocking on — or failing because of — event delivery.
 * inngest.send() still retries internally (5x, exponential backoff) against
 * the real Inngest ingest endpoint; this just keeps that off the request's
 * critical path so a slow/unreachable Inngest doesn't turn an already-
 * successful mutation into a stalled or user-facing-error request. A
 * delivery failure is logged, not thrown — there is nothing left in the
 * request to roll back or retry synchronously.
 */
export function sendEventAsync(...args: Parameters<typeof inngest.send>): void {
  inngest.send(...args).catch((err: unknown) => {
    console.error('[inngest.send] fire-and-forget send failed', err)
  })
}
