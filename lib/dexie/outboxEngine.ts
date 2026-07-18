import type { Table, UpdateSpec } from 'dexie'

export interface BaseMutationRow {
  id?:        number
  createdAt:  string
  retryCount: number
  failed?:    boolean
}

export interface OutboxConfig<TMutation extends BaseMutationRow> {
  maxRetries?: number
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
 * SyncEngine's exact behavior — isProcessing guard, chronological order,
 * skip-and-continue at 3 failed attempts, dead-letter (keep row, mark
 * failed) at maxRetries rather than deleting it, so a write that never
 * reached the server leaves a durable, queryable trace instead of silently
 * disappearing.
 */
export class OutboxEngine<TMutation extends BaseMutationRow> {
  private isProcessing = false

  constructor(
    private table:  Table<TMutation, number>,
    private config: OutboxConfig<TMutation>,
  ) {}

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

  async processOutbox(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    try {
      const pending = (await this.table.orderBy('id').toArray()).filter((m) => !m.failed)
      const maxRetries = this.config.maxRetries ?? 5

      for (const mutation of pending) {
        const id = mutation.id as number
        try {
          await this.config.uploadOne(mutation)
          await this.table.delete(id)
        } catch (err) {
          if (this.config.isTerminal?.(err)) {
            console.error(`[OutboxEngine] mutation ${id} terminal failure:`, err)
            await this.patch(id, { failed: true })
            continue
          }

          const newRetryCount = mutation.retryCount + 1
          console.error(`[OutboxEngine] mutation ${id} failed (attempt ${newRetryCount}):`, err)
          if (newRetryCount >= maxRetries) {
            await this.patch(id, { retryCount: newRetryCount, failed: true })
          } else {
            await this.patch(id, { retryCount: newRetryCount })
            if (newRetryCount >= 3) continue
            break
          }
        }
      }
    } finally {
      this.isProcessing = false
    }
  }
}
