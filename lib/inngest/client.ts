import { Inngest, EventSchemas } from 'inngest'
import { after } from 'next/server'
import type { FieldStayEvents } from './events'

import { reportError } from '@/lib/observability/report-error'
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
 * successful mutation into a stalled or user-facing-error request.
 *
 * Scheduled via Next's after() (same pattern as the milestone-prompt write in
 * app/(dashboard)/layout.tsx), not a bare un-awaited promise — on Vercel, a
 * Server Action's serverless invocation can be frozen the moment its response
 * is sent, which would cut off an in-flight inngest.send() (and its retries)
 * before it ever reaches the ingest endpoint. after() keeps the invocation
 * alive for exactly this callback without blocking the response itself. Only
 * callable from a request-scoped Server Action/Route Handler — every current
 * call site is one.
 *
 * A delivery failure is logged, not thrown — there is nothing left in the
 * request to roll back or retry synchronously by the time after() runs.
 */
export function sendEventAsync(...args: Parameters<typeof inngest.send>): void {
  after(async () => {
    try {
      await inngest.send(...args)
    } catch (err) {
      console.error('[inngest.send] fire-and-forget send failed', err)
      reportError(err, { site: 'lib.inngest.client.sendEventAsync' })
    }
  })
}
