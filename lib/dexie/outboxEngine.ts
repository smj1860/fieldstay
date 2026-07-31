import type { Table, UpdateSpec } from 'dexie'

import { reportError } from '@/lib/observability/report-error'
import { isOnline, withTabLock, classifyUploadFailure } from './net'
import { computeNextAttemptAt } from './syncService'

export interface BaseMutationRow {
  id?:        number
  createdAt:  string
  retryCount: number
  failed?:    boolean
  // Same backoff/transport-failure accounting as MutationRow in
  // lib/dexie/schema.ts — see SyncEngine.handleFailure for the rationale.
  nextAttemptAt?:     number
  networkRetryCount?: number
}

export interface OutboxConfig<TMutation extends BaseMutationRow> {
  maxRetries?: number
  /** Name of the cross-tab lock serializing this outbox's drain. */
  lockName?:   string
  uploadOne:   (mutation: TMutation) => Promise<void>
  /**
   * Distinguishes "will never succeed no matter how many times we retry"
   * (dead-letter immediately, skip the retry budget) from a transient
   * failure (retry normally, subject to maxRetries). Optional — omit for
   * engines with no terminal-failure case.
   */
  isTerminal?: (err: unknown) => boolean
}

// NOTE: processOutbox() below logs the failing mutation's id and retry
// count on every failure — deliberately never the mutation itself or its
// payload, since callers' payloads can carry PII/free-text notes/pricing.
// Keep it that way in any caller-supplied uploadOne() too.

/**
 * Generic outbox drain loop, extracted from lib/dexie/syncService.ts's
 * SyncEngine. Table-agnostic: the caller supplies its own uploadOne. Mirrors
 * SyncEngine's exact behavior — offline gate, cross-tab lock, chronological
 * order with a strict stop (never skip-and-continue, so later mutations
 * against the same record can't jump ahead of a failing one), exponential
 * backoff, transport failures that cost no retry budget, and dead-letter
 * (keep row, mark failed) at maxRetries rather than deleting it, so a write
 * that never reached the server leaves a durable, queryable trace instead of
 * silently disappearing.
 */
export class OutboxEngine<TMutation extends BaseMutationRow> {
  private isProcessing = false
  private disposed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private table:  Table<TMutation, number>,
    private config: OutboxConfig<TMutation>,
  ) {}

  private scheduleRetry(nextAttemptAt: number): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.disposed) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed) return
      void this.processOutbox()
    }, Math.max(0, nextAttemptAt - Date.now()))
  }

  /**
   * Permanently stops this engine — call BEFORE deleting the database it
   * drains. Disposal is a latch, not just a timer cancel: a drain already
   * mid-await, or a retry scheduled by one, would otherwise re-open the
   * storage that was just deleted.
   */
  dispose(): void {
    this.disposed = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  // Only ever patches BaseMutationRow's own fields (retryCount/failed) —
  // never anything specific to a caller's TMutation extension. Dexie's
  // UpdateSpec<T> mapped type (dot-path keys for nested updates) doesn't
  // resolve cleanly against an unconstrained generic TMutation, so TS
  // can't verify the object literal against it structurally even though
  // it's a genuine partial update; isolating the one necessary cast here
  // keeps it to a single, documented spot instead of at every call site.
  private patch(id: number, changes: Partial<BaseMutationRow>): Promise<number> {
    return this.table.update(id, changes as unknown as UpdateSpec<TMutation>)
  }

  /**
   * `ignoreBackoff` is for a drain triggered by a signal that INVALIDATES the
   * reason the backoff exists: connectivity returning, or the user explicitly
   * asking to retry now. The backoff spaces out attempts made into a network
   * that just failed; once the device is demonstrably back on the network,
   * continuing to wait it out is not caution, it's latency.
   *
   * It is also load-bearing for correctness of the UI, not just speed: the
   * caller of a reconnect drain reads the mutation's state as soon as the
   * returned promise resolves, to show "queued" vs. "dead-lettered". A drain
   * that stops at the backoff gate resolves having done nothing, so a
   * submission the server would have terminally rejected reports as still
   * queued, and the eventual timer-driven dead-letter — happening in the
   * background with no one listening — never reaches the screen at all.
   */
  async processOutbox(options: { ignoreBackoff?: boolean } = {}): Promise<void> {
    if (this.isProcessing || this.disposed) return
    this.isProcessing = true
    try {
      await withTabLock(
        this.config.lockName ?? 'fieldstay-outbox',
        () => this.drain(options.ignoreBackoff ?? false),
      )
    } finally {
      this.isProcessing = false
    }
  }

  private async drain(ignoreBackoff: boolean): Promise<void> {
    // Offline: an attempt that can't physically be made is not a failed
    // attempt and must never consume the retry budget.
    if (!isOnline() || this.disposed) return

    const pending = (await this.table.orderBy('id').toArray()).filter((m) => !m.failed)

    for (const mutation of pending) {
      const id = mutation.id as number

      const notDueYet = mutation.nextAttemptAt !== undefined && mutation.nextAttemptAt > Date.now()
      if (notDueYet && !ignoreBackoff) {
        this.scheduleRetry(mutation.nextAttemptAt as number)
        return
      }
      if (!isOnline() || this.disposed) return

      try {
        await this.config.uploadOne(mutation)
        await this.table.delete(id)
      } catch (err) {
        const stop = await this.handleFailure(mutation, id, err)
        if (stop) return
      }
    }
  }

  /** Returns true when the drain must stop to preserve ordering. */
  private async handleFailure(mutation: TMutation, id: number, err: unknown): Promise<boolean> {
    const maxRetries = this.config.maxRetries ?? 5

    if (this.config.isTerminal?.(err)) {
      console.error(`[OutboxEngine] mutation ${id} terminal failure:`, err)
      reportError(err, { site: 'lib.dexie.outboxEngine.OutboxEngine' })
      await this.patch(id, { failed: true })
      return false  // dead-lettered — it can never succeed, so don't block the rest
    }

    const kind = classifyUploadFailure(err)
    if (kind === 'network') {
      // Never reached the server: no retry consumed, no dead-lettering.
      const level = (mutation.networkRetryCount ?? 0) + 1
      const nextAttemptAt = computeNextAttemptAt(level, Date.now())
      console.warn(`[OutboxEngine] mutation ${id} could not reach the server (transport attempt ${level})`)
      await this.patch(id, { networkRetryCount: level, nextAttemptAt })
      this.scheduleRetry(nextAttemptAt)
      return true
    }

    const newRetryCount = mutation.retryCount + 1
    console.error(`[OutboxEngine] mutation ${id} failed (attempt ${newRetryCount}, ${kind}):`, err)

    if (kind === 'terminal' || newRetryCount >= maxRetries) {
      await this.patch(id, { retryCount: newRetryCount, failed: true })
      return false
    }

    const nextAttemptAt = computeNextAttemptAt(newRetryCount, Date.now())
    await this.patch(id, { retryCount: newRetryCount, nextAttemptAt })
    // Never skip-and-continue: a later mutation against the same record must
    // not be applied before this one.
    this.scheduleRetry(nextAttemptAt)
    return true
  }
}
