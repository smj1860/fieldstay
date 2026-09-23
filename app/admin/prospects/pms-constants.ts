/**
 * Shared between the PMS backfill actions and its button.
 *
 * Kept out of pms-actions.ts because that file is 'use server' — every export
 * there has to be an async function, and an `export const` fails the NEXT
 * BUILD naming an unrelated export from the same file.
 */
import type { PmsMapping } from '@/lib/prospecting/pms-backfill'

/** Rows per statement, matching the RPC's own limit headroom. */
export const PMS_CHUNK = 250

/** How many old → new pairs the preview lists before collapsing to a count. */
export const PMS_MAPPINGS_SHOWN = 30

export interface PmsPlanSummary {
  /** Accounts that currently carry a pms value. */
  considered:     number
  wouldChange:    number
  brandsBefore:   number
  brandsAfter:    number
  /** Rows whose pms is prose, not a product — it moves to the note. */
  wouldClear:     number
  mappings:       PmsMapping[]
  brands:         string[]
}
