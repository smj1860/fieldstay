// lib/dexie/net.ts
//
// Transport-level concerns shared by every crew-side outbox drain
// (lib/dexie/syncService.ts, lib/dexie/photo-sync.ts,
// lib/dexie/outboxEngine.ts):
//
//  1. Connectivity gating — an attempt made with no connection is not a
//     failed attempt, it's an attempt that never happened. It must never
//     consume a mutation's retry budget.
//  2. Failure classification — a transport failure (offline, DNS, captive
//     portal, dropped socket) is retryable forever; a server REJECTION
//     (4xx validation, a constraint the write will always violate) will
//     never succeed no matter how many times it's replayed and must
//     dead-letter immediately instead of burning five retries.
//  3. Cross-tab mutual exclusion — the outbox lives in a SHARED IndexedDB,
//     so a per-tab `isProcessing` flag does not stop two tabs draining the
//     same rows concurrently and applying order-sensitive writes out of
//     order.

/**
 * `true` when the device reports a connection (or when connectivity is
 * unknowable — SSR/node, where `navigator` doesn't exist). Deliberately
 * fails OPEN: an unknown environment must still attempt the push rather
 * than silently stall the queue forever.
 */
export function isOnline(): boolean {
  if (typeof navigator === 'undefined') return true
  if (typeof navigator.onLine !== 'boolean') return true
  return navigator.onLine
}

/** A non-2xx response from one of the crew Route Handlers. */
export class UploadHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'UploadHttpError'
  }
}

/** A PostgREST/Supabase error surfaced by one of the table upload handlers. */
export class UploadDataError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
    this.name = 'UploadDataError'
  }
}

export type UploadFailureKind =
  /** Never reached the server. Retry forever on capped backoff; never dead-letter. */
  | 'network'
  /** Reached the server and was rejected in a way replay cannot fix. Dead-letter now. */
  | 'terminal'
  /** Reached the server and failed in a way that may succeed later. Retry, bounded. */
  | 'transient'

// `fetch()` rejects with a TypeError whose message is engine-specific:
// Chrome "Failed to fetch", Firefox "NetworkError when attempting to fetch
// resource.", Safari "Load failed"/"The network connection was lost.",
// undici "fetch failed". supabase-js surfaces the same text through
// PostgrestError.message when the underlying fetch rejects.
//
// Every alternative is \b-anchored deliberately: an unanchored `load failed`
// also matches "…upLOAD FAILED: …", which is the prefix of half the
// PostgREST error messages this file's own callers construct — that would
// have classified ordinary server rejections as transport failures and
// retried them forever.
const NETWORK_MESSAGE_PATTERN =
  /\bfailed to fetch\b|\bfetch failed\b|\bnetworkerror\b|\bnetwork request failed\b|\bnetwork connection was lost\b|\bload failed\b|\berr_internet_disconnected\b|\bconnection (?:refused|reset|closed)\b|\btimed out\b|\btimeout\b|\bsocket hang up\b|\boffline\b/i

// PostgREST/Postgres error codes that a replay can never fix: integrity
// constraint violations (23xxx), data exceptions (22xxx), syntax/access-rule
// errors incl. RLS denials (42xxx), and PostgREST's own request-shape codes.
const TERMINAL_CODE_PATTERN = /^(22|23|42)\d{3}$/

// Client-side codes this codebase raises for a mutation that is structurally
// unsendable — replaying it byte-for-byte can only fail the same way.
const TERMINAL_CODES = new Set(['NO_FIELDS'])

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return ''
}

// 408 Request Timeout / 425 Too Early / 429 Too Many Requests are explicitly
// retryable; so is every 5xx. Any other 4xx is the server saying "this
// request is wrong", which replaying byte-for-byte cannot change.
const RETRYABLE_STATUSES = new Set([408, 425, 429])

function classifyHttpStatus(status: number): UploadFailureKind {
  if (RETRYABLE_STATUSES.has(status)) return 'transient'
  if (status >= 500) return 'transient'
  if (status >= 400) return 'terminal'
  return 'transient'
}

function isTerminalDataCode(code: string): boolean {
  return TERMINAL_CODES.has(code) || TERMINAL_CODE_PATTERN.test(code) || code.startsWith('PGRST')
}

/**
 * Classifies an upload failure. Called by every drain loop to decide
 * whether the failure costs a retry (`transient`), costs nothing at all
 * (`network`), or ends the mutation's life immediately (`terminal`).
 *
 * Order matters: the offline check comes first, because ANY error raised
 * while the device has no connection is a transport failure regardless of
 * what it looks like.
 */
export function classifyUploadFailure(err: unknown): UploadFailureKind {
  if (!isOnline()) return 'network'
  if (err instanceof UploadHttpError) return classifyHttpStatus(err.status)
  if (err instanceof UploadDataError && err.code && isTerminalDataCode(err.code)) return 'terminal'
  if (err instanceof TypeError) return 'network'
  if (NETWORK_MESSAGE_PATTERN.test(messageOf(err))) return 'network'
  return 'transient'
}

// navigator.locks is unavailable in non-secure contexts, in workers on some
// engines, and in the jsdom/node test environment. Declared narrowly here
// rather than relying on the ambient DOM lib so the fallback path is
// explicit and testable.
interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks
  return typeof locks?.request === 'function' ? locks : null
}

/**
 * Runs `fn` while holding a named cross-tab lock, so two tabs of the crew
 * PWA never drain the same shared IndexedDB outbox at once (which would
 * apply order-sensitive writes — e.g. successive
 * `inventory_items.current_quantity` updates — concurrently and therefore
 * possibly out of order).
 *
 * `ifAvailable: true` means a tab that loses the race SKIPS its run rather
 * than queueing behind the winner: the winner is draining the very same
 * rows, so a queued second pass would only re-scan an empty outbox.
 *
 * Fallback when the Web Locks API is unavailable: run `fn` anyway. That
 * restores exactly the previous single-tab-correct behavior rather than
 * silently disabling sync — losing cross-tab protection is strictly better
 * than losing the drain entirely.
 */
export async function withTabLock(name: string, fn: () => Promise<void>): Promise<void> {
  const locks = lockManager()
  if (!locks) {
    await fn()
    return
  }
  await locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return          // another tab holds it — it is draining these same rows
    await fn()
  })
}
