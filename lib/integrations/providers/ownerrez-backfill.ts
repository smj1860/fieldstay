// lib/integrations/providers/ownerrez-backfill.ts
// ============================================================================
// Window planning for OwnerRez's progressive historical booking backfill.
//
// WHY THIS EXISTS
//
// initial-sync's fetch-bookings step calls getBookings() with property ids and
// nothing else — no date bounds at all — so it asks OwnerRez for a portfolio's
// ENTIRE booking history in one step. That was invisible while the pager was
// broken (it stopped after 20 records regardless), and fixing pagination turned
// it into a real cost: a 50-property manager with several years of history is
// thousands of bookings, fetched 100 at a time, against a 300-request/5-minute
// budget shared by every tenant on the deployment IP — all before the PM sees
// their first screen.
//
// So the initial sync now takes a bounded recent window, and older history is
// walked backwards one window per incremental sync until it reaches a horizon.
//
// WHY from/to AND NOT since_utc
//
// since_utc is a MODIFICATION-time cursor — "created or changed since" — which
// is right for incremental sync and useless for reaching back through history:
// an old booking that never changed has no recent modification time. `from`/`to`
// are stay-date bounds, verified 2026-08-13 against OwnerRez's OpenAPI contract
// and recorded in docs/Integrations/ownerrez/api-markdown.md:
//
//     from — bookings that DEPART on or after this date
//     to   — bookings that ARRIVE on or before this date
//
// Together they are an interval OVERLAP filter, not containment. A stay
// straddling a window edge is returned by both adjacent windows, which is why
// the windows below share their boundary date rather than trying to abut
// exactly: bookings upsert on the OwnerRez id, so a duplicate is free and a gap
// is not.
//
// This module is pure — dates in, dates out, no clock of its own — so the
// walk is testable without driving an Inngest function.
// ============================================================================

/** How much history the INITIAL sync pulls inline, before any backfill. */
export const INITIAL_HISTORY_DAYS = 90

/** How much older history each incremental sync claims, one window per run. */
export const BACKFILL_WINDOW_DAYS = 90

/**
 * How far back the walk goes in total. Two years covers prior-year comparison
 * in owner reporting, which is the furthest back any FieldStay screen looks.
 * At one 90-day window per hourly incremental sync a connection reaches it in
 * about 8 hours.
 */
export const BACKFILL_HORIZON_DAYS = 730

export interface OwnerRezBackfillState {
  /**
   * The oldest stay date already covered — the `from` of the last window
   * fetched. Null means no backfill has run yet, in which case the initial
   * sync's own window is the starting edge.
   */
  oldestCovered: string | null
  /** True once the horizon is reached; the walk never restarts on its own. */
  complete: boolean
}

export interface BackfillWindow {
  /** Inclusive stay-date lower bound (YYYY-MM-DD). */
  from: string
  /** Inclusive stay-date upper bound (YYYY-MM-DD). */
  to:   string
}

/**
 * First day of the current month — the floor for posting booking revenue to
 * owner_transactions.
 *
 * A stay that ended before FieldStay was managing the property has no
 * recoverable expense side: cleaning_fee posts on turnover completion,
 * wo_completion on a work order, inventory_purchase on a received PO, and none
 * of those exist for work done in another system. Posting its revenue anyway
 * produces a month showing full rent against zero costs — an owner-facing P&L
 * that is not merely incomplete but overstated.
 *
 * The current month is the boundary rather than the connection date because it
 * is the one an operator can state plainly: "your FieldStay ledger starts this
 * month." Anything earlier is visibly absent rather than quietly wrong.
 */
export function revenuePostingFloor(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`
}

/** Calendar date in UTC, as OwnerRez's date-only bounds expect. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function shiftDays(from: Date, days: number): Date {
  return new Date(from.getTime() - days * 86_400_000)
}

/**
 * The lower stay-date bound for the INITIAL sync's booking fetch.
 *
 * Deliberately no upper bound at the call site: `from` alone means "departs on
 * or after", which keeps every future booking. Bounding the future would be a
 * bug — upcoming stays are the entire point of the first sync.
 */
export function initialHistoryFrom(now: Date): string {
  return isoDate(shiftDays(now, INITIAL_HISTORY_DAYS))
}

/**
 * The next window to fetch, or null when the walk is finished.
 *
 * The returned window's `to` is the previous window's `from` — they share that
 * boundary date on purpose, see the overlap note in the header.
 */
export function planBackfillWindow(
  state: OwnerRezBackfillState,
  now:   Date,
): BackfillWindow | null {
  if (state.complete) return null

  const horizon = isoDate(shiftDays(now, BACKFILL_HORIZON_DAYS))

  // No backfill yet ⇒ start from wherever the initial sync's window ended.
  const to = state.oldestCovered ?? initialHistoryFrom(now)

  // Already at or past the horizon: nothing left to claim. (`<=` on ISO
  // date strings is a valid chronological comparison — fixed width, zero
  // padded, most-significant first.)
  if (to <= horizon) return null

  const candidate = isoDate(shiftDays(new Date(`${to}T00:00:00.000Z`), BACKFILL_WINDOW_DAYS))
  const from = candidate < horizon ? horizon : candidate

  return { from, to }
}

/**
 * State after a window has been fetched successfully.
 *
 * `complete` is set when the window reached the horizon, so the walk stops
 * rather than re-fetching the same terminal window on every run forever.
 */
export function advanceBackfill(
  window: BackfillWindow,
  now:    Date,
): OwnerRezBackfillState {
  const horizon = isoDate(shiftDays(now, BACKFILL_HORIZON_DAYS))
  return {
    oldestCovered: window.from,
    complete:      window.from <= horizon,
  }
}

/**
 * Reads the state back out of integration_connections.metadata, which is
 * untyped jsonb — anything in there could be any shape, including from an
 * older build that never wrote these keys.
 */
export function readBackfillState(metadata: unknown): OwnerRezBackfillState {
  const meta = (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata))
    ? metadata as Record<string, unknown>
    : {}

  const oldest = meta['backfill_oldest_covered']
  const done   = meta['backfill_complete']

  return {
    oldestCovered: typeof oldest === 'string' && oldest.length > 0 ? oldest : null,
    complete:      done === true,
  }
}
