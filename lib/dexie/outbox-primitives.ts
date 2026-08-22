// lib/dexie/outbox-primitives.ts
//
// The pieces every outbox needs, in a module that imports NOTHING.
//
// WHY THIS FILE EXISTS — the dependency direction was backwards.
//
// `outboxEngine.ts` is the surface-agnostic drain loop: the crew PWA and the
// vendor work-order portal both build on it, and per docs/INSPECTIONS_SPEC.md
// §8 the dashboard will be the third. But it imported `computeNextAttemptAt`
// from `syncService.ts` — the CREW engine, an 982-line module that constructs a
// Supabase client at class level and pulls in the whole crew Dexie schema
// behind it. So "use the shared engine" meant "import the crew sync layer",
// which is precisely the coupling that makes a fourth surface look easier to
// fork than to join. §8 is explicit that forking is the thing to avoid:
// the hard-won rules were each paid for with a production bug, and a second
// outbox means paying for them twice.
//
// The extracted function is six lines of arithmetic and two constants. Nothing
// about it was ever crew-specific; it lived there by accident of who needed it
// first — the same accident that put photo compression in `photo-queue.ts`
// until §8a moved it to `lib/images/compress.ts`. Same principle, same fix:
// share the rule, not the table.

/**
 * Dead-letter marker, stored as 0/1 rather than a boolean.
 *
 * IndexedDB HAS NO BOOLEAN KEY TYPE. A record whose indexed property holds
 * `true` is simply omitted from that index — so a boolean `failed` cannot be
 * indexed at all, and every dead-letter query silently degrades to a full scan
 * of the outbox on every write to it. The crew surface paid for this twice, in
 * two separate schema upgrades that had to normalise already-written rows.
 *
 * 0/1 preserves every truthiness check (`!m.failed`, `!!m.failed`) unchanged;
 * only the literal `true`/`false` WRITES differ. That is what makes it safe to
 * hold every surface to it rather than only the one that discovered it.
 */
export type DeadLetterFlag = 0 | 1

const BASE_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS  = 300_000

/**
 * Exponential backoff with jitter: 5s, 10s, 20s, 40s … capped at 5 minutes.
 *
 * The jitter is a spread, not a secret. Without it, every device that queued a
 * write during one outage retries in the same instant when connectivity
 * returns, which turns a recovered backend into a fresh thundering herd.
 */
export function computeNextAttemptAt(retryCount: number, now: number): number {
  const baseDelay = Math.min(2 ** (retryCount - 1) * BASE_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS)
  // eslint-disable-next-line no-restricted-properties -- retry backoff jitter to spread outbox retry storms after an outage, not id/token generation
  const jitter = Math.random() // NOSONAR -- timing jitter only, not security-sensitive (see eslint-disable justification above)
  return now + baseDelay * (0.5 + jitter)
}
