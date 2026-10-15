// ============================================================================
// The FieldStay half of every "<competitor> alternative" comparison row.
//
// These claims are already written, sourced and kept honest by
// unit/pages/breezeway-alternative.test.ts, so the per-competitor data files
// look them up here instead of retyping them. Retyping is how two pages end up
// disagreeing about the same product.
//
// The competitor half of every row is NOT shared. It is written per page from
// that competitor's own public pages, with a URL and a "checked YYYY-MM-DD"
// date, and a cell may say "not independently confirmed" but may never guess.
// ============================================================================

import { COMPARISON_ROWS, type ComparisonRow } from '@/app/breezeway-alternative/comparison-data'

export interface FieldstayClaim {
  fieldstay:       string
  fieldstaySource: string
}

/** A FieldStay claim the Breezeway rows already carry, looked up by category. */
export function fieldstayClaim(category: string): FieldstayClaim {
  const row = COMPARISON_ROWS.find((r) => r.category === category)
  if (!row) throw new Error(`No FieldStay claim for category "${category}" in the Breezeway rows`)
  return { fieldstay: row.fieldstay, fieldstaySource: row.fieldstaySource }
}

export const FIELDSTAY_OFFLINE: FieldstayClaim = {
  fieldstay:
    'The crew app reads from local device storage as its normal mode, not a special "offline mode". Every ' +
    'checklist step, photo, and inventory count queues locally and syncs automatically once signal returns. ' +
    'A photo that fails to upload stays visible with a retry button.',
  fieldstaySource: 'lib/dexie/schema.ts, lib/dexie/syncService.ts, app/crew/_components/failed-sync-banner.tsx',
}

export const FIELDSTAY_PMS: FieldstayClaim = {
  fieldstay:
    'Connects to OwnerRez, Hospitable, Hostex, Hostaway and Lodgify and builds the turnover schedule from ' +
    'existing bookings, with iCal calendar feeds for everything else.',
  fieldstaySource:
    'lib/integrations/providers/ownerrez.ts, lib/integrations/providers/hospitable.ts, ' +
    'lib/integrations/providers/hostex.ts, lib/integrations/providers/hostaway.ts, lib/integrations/providers/lodgify.ts',
}

/** Builds one row from a FieldStay claim plus the competitor-side text and source. */
export function comparisonRow(
  category:   string,
  claim:      FieldstayClaim,
  competitor: string,
  source:     string,
): ComparisonRow {
  return {
    category,
    fieldstay:       claim.fieldstay,
    breezeway:       competitor, // the field is named for the page it was written for; here it is the competitor column
    fieldstaySource: claim.fieldstaySource,
    breezewaySource: source,
  }
}
