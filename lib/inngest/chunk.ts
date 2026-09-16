// lib/inngest/chunk.ts
// ============================================================================
// Chunking primitives for two shapes that silently break past a threshold
// nobody sees coming, surfaced by the 2026-09-16 high-scale viability audit:
//
//   1. `.in('col', ids)` — PostgREST encodes `.in()` as a URL query parameter,
//      not a request body. An id list sized by "however many rows a sync just
//      fetched" (thousands, at scale) produces a multi-hundred-KB URL that
//      exceeds reverse-proxy request-line limits and fails outright (414 /
//      connection reset) rather than degrading. `chunkArray()` splits the
//      list; the caller runs one `.in()` per chunk.
//
//   2. `step.sendEvent()` with an array sized by a live table scan (every
//      active connection for a provider, every affected property in a sync).
//      Inngest enforces a per-call payload/event-count ceiling; a call built
//      from an unbounded array is rejected or truncated atomically — the
//      whole dispatch fails for every tenant in that batch, not just the ones
//      past the limit. `sendEventsChunked()` splits the array and issues one
//      `step.sendEvent()` per chunk, each independently retryable by Inngest.
//
// Neither failure mode announces itself in a fresh-fixture test: both need a
// list past ~1,000-5,000 entries to reproduce, which is exactly the "worked
// in dev, broke at scale" shape this module exists to close off structurally
// rather than leave to be rediscovered per call site.
// ============================================================================

/** Split `items` into fixed-size chunks, preserving order. */
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunkArray: size must be >= 1, got ${size}`)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Default `.in()` chunk size. Chosen well under the point a URL query string
 * risks exceeding common reverse-proxy request-line limits (~8KB) even for
 * UUID-length ids: 300 UUIDs (~36 chars + encoding overhead) stays under 12KB
 * for the parameter alone, with headroom for the rest of the query string.
 */
export const IN_CLAUSE_CHUNK_SIZE = 300

/**
 * Default event-batch size for `step.sendEvent()`. Inngest's own guidance
 * caps a single send well under its hard per-call limits; 500 leaves
 * comfortable headroom while still cutting round trips for platform-wide
 * fan-out (a 20,000-connection dispatch is 40 calls, not 1 rejected one).
 */
export const SEND_EVENT_CHUNK_SIZE = 500

interface StepLike {
  sendEvent: (id: string, events: unknown | unknown[]) => Promise<unknown>
}

/**
 * Chunked `step.sendEvent()` for a platform-wide fan-out whose size is
 * bounded only by live table contents, not a fixed constant.
 *
 * Each chunk is its own named step (`${stepIdPrefix}-N`), so Inngest can
 * retry an individual chunk's dispatch without replaying the ones that
 * already landed — the same reasoning as per-page/per-property stepping
 * elsewhere in this codebase's Inngest functions.
 *
 * ```ts
 * await sendEventsChunked(step, 'dispatch-connections', connections.map((c) => ({
 *   name: 'hostaway/sync.requested',
 *   data: { connectionId: c.id, orgId: c.org_id },
 * })))
 * ```
 */
export async function sendEventsChunked(
  step: StepLike,
  stepIdPrefix: string,
  events: readonly unknown[],
  chunkSize: number = SEND_EVENT_CHUNK_SIZE,
): Promise<void> {
  const chunks = chunkArray(events, chunkSize)
  for (let i = 0; i < chunks.length; i++) {
    await step.sendEvent(`${stepIdPrefix}-${i}`, chunks[i] as never)
  }
}
