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
const NETWORK_MESSAGE_PATTERN =
  /failed to fetch|fetch failed|networkerror|network request failed|network connection was lost|load failed|err_internet_disconnected|connection (refused|reset|closed)|timed? ?out|socket hang up|offline/i

// PostgREST/Postgres error codes that a replay can never fix: integrity
// constraint violations (23xxx), data exceptions (22xxx), syntax/access-rule
// errors incl. RLS denials (42xxx), and PostgREST's own request-shape codes.
const TERMINAL_CODE_PATTERN = /^(22|23|42)\d{3}$/

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return ''
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

  if (err instanceof UploadHttpError) {
    // 408 Request Timeout / 425 Too Early / 429 Too Many Requests are
    // explicitly retryable; so is every 5xx. Any other 4xx is the server
    // saying "this request is wrong", which replaying cannot change.
    if (err.status === 408 || err.status === 425 || err.status === 429) return 'transient'
    if (err.status >= 500) return 'transient'
    if (err.status >= 400) return 'terminal'
    return 'transient'
  }

  if (err instanceof UploadDataError && err.code) {
    if (TERMINAL_CODE_PATTERN.test(err.code)) return 'terminal'
    if (err.code.startsWith('PGRST')) return 'terminal'
  }

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
