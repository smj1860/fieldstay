/**
 * Shared between the strscout sync actions and its button.
 *
 * Kept out of strscout-actions.ts because that file is 'use server' — every
 * export there has to be an async function, and an `export const` fails the
 * NEXT BUILD naming an unrelated export from the same file.
 */

/** Rows per insert statement, and per `.in()` lookup. */
export const STRSCOUT_CHUNK = 250

export interface StrscoutPlanSummary {
  /** Scraper rows that qualified and mapped cleanly. */
  considered:     number
  wouldAdd:       number
  wouldFill:      number
  untouched:      number
  droppedDomains: number
  fields:         { column: string; count: number }[]
}
