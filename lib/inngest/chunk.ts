// lib/inngest/chunk.ts
// ============================================================================
// Shared chunking helpers for Inngest fan-out.
//
// Two distinct ceilings this file guards against, both silent when missed:
//
//   1. `step.sendEvent(id, events)` accepts an array, but Inngest's event API
//      has its own payload-size and per-request event-count limits. A cron
//      that fans out one event per tenant and grows past a few hundred
//      tenants can build a single sendEvent call large enough to be rejected
//      outright — which then fails the WHOLE dispatch step for every tenant,
//      not just the ones past some line. `sendEventsChunked` sends the same
//      events in bounded batches instead, each its own step so a failure or a
//      resumed run only re-sends the batches that did not land.
//
//   2. A Supabase `.in('col', ids)` clause has no hard client-side limit, but
//      an arbitrarily long IN-list is both a query-planning and a URL/payload
//      size risk once a platform-wide id set reaches five- or six-figures at
//      100x scale. `IN_CLAUSE_CHUNK_SIZE` is the standard chunk size for
//      splitting such a list before querying — pair with `fetchAllRows` per
//      chunk so pagination and IN-list chunking compose correctly instead of
//      one silently masking the other.
//
// `chunkArray` has no Inngest dependency and is deliberately a leaf function —
// nothing here reaches into `lib/supabase` or `lib/inngest/functions/**`.
// ============================================================================

import type { GetStepTools } from 'inngest'
import type { inngest } from '@/lib/inngest/client'

/** Default chunk size for a Supabase `.in('col', ids)` clause. */
export const IN_CLAUSE_CHUNK_SIZE = 300

/** Default chunk size for one `step.sendEvent(...)` call. */
export const SEND_EVENT_CHUNK_SIZE = 500

/**
 * Splits `items` into consecutive chunks of at most `size` elements each.
 * The last chunk may be shorter. `size` must be a positive integer.
 */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`chunkArray: size must be a positive integer, got ${size}`)
  }

  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

type Step = GetStepTools<typeof inngest>
type SendEventArg = Parameters<Step['sendEvent']>[1]

/**
 * Sends `events` to Inngest in batches of at most `chunkSize`, each as its
 * own `step.sendEvent(...)` call.
 *
 * `stepIdPrefix` becomes `${stepIdPrefix}-0`, `${stepIdPrefix}-1`, … — every
 * chunk needs a step id distinct from its siblings (Inngest memoizes on the
 * id), and distinct from any other step in the same function, which is why
 * this takes a prefix rather than inventing one.
 *
 * A run resumed after a crash or deploy re-enters this function from the top,
 * but every chunk that already sent is memoized and skipped — only the
 * chunks that had not yet been sent actually fire again.
 *
 * `Payload` is intentionally NOT re-checked here against the full
 * `FieldStayEvents` map: a generic chunking helper cannot re-derive that
 * union from an unconstrained type parameter. The real check belongs at each
 * caller's own typed event-name parameter (e.g. `ConnectionDispatchEvent` in
 * `lib/inngest/functions/shared/connection-dispatch.ts`) — same trade-off
 * that file's header comment already documents for the same reason.
 */
export async function sendEventsChunked<Payload extends { name: string; data: unknown; ts?: number }>(
  step: Step,
  stepIdPrefix: string,
  events: readonly Payload[],
  chunkSize: number = SEND_EVENT_CHUNK_SIZE,
): Promise<void> {
  if (events.length === 0) return

  const chunks = chunkArray(events, chunkSize)
  for (let i = 0; i < chunks.length; i++) {
    // Sequential and awaited in order (not Promise.all): each chunk is its
    // own Inngest step, and awaiting in order keeps a resumed run replaying
    // deterministically from the first un-memoized chunk.
    await step.sendEvent(`${stepIdPrefix}-${i}`, chunks[i] as SendEventArg)
  }
}
