// lib/assets/age-basis.ts
// ============================================================================
// Which date an asset's age is measured from, and whether that date is a
// recorded fact or inferred from the nameplate.
//
// THE GAP THIS CLOSES. property_assets.manufacture_date was WRITE-ONLY: the
// data-plate scan (lib/inngest/functions/asset-scan.ts) extracts a
// manufacture year off the photo and stores it, and nothing ever read it back.
// Not health scoring, not capex, not depreciation — the only other references
// in the whole tree are RLS policies gating crew updates to null-valued
// columns.
//
// So a crew-scanned appliance landed in the worst available state. FieldStay
// had read a real year off the nameplate, and the asset still scored a flat 50
// forever (health-score.ts returns that for a null installation_date), was
// filtered out of the capex projection entirely, was excluded from the learned
// Weibull lifespan fit, and generated no depreciation.
//
// Manufacture year is not the same fact as an installation date — an appliance
// sits in a warehouse and on a shelf before it is installed — so this never
// overwrites a recorded date, and never silently passes itself off as one. It
// is the LAST resort in an explicit precedence, and every caller gets
// `estimated: true` alongside it so the inference can be labelled wherever it
// reaches a human: an age badge in the UI, a note on a depreciation entry, an
// asterisk in the CPA export.
//
// The bias is the safe direction. Manufacture precedes installation, so an
// asset dated this way reads as OLDER than it is, never younger — a health
// score and a replacement year that are conservative rather than optimistic.
// ============================================================================

import type { PropertyAsset } from '@/types/database'

/** Which column the date came from, in precedence order. */
export type AgeBasisSource = 'placed_in_service' | 'installation' | 'manufacture'

export interface AgeBasis {
  /** ISO date string. */
  date:   string
  source: AgeBasisSource
  /**
   * True only for `manufacture` — the one source that is an inference rather
   * than a recorded date. Callers that surface a date or an age to a human
   * are expected to mark it.
   */
  estimated: boolean
}

/** The shape any basis lookup needs; a subset of PropertyAsset. */
export type AgeBasisFields = Pick<PropertyAsset, 'installation_date' | 'manufacture_date'>
export type ServiceBasisFields = AgeBasisFields & Pick<PropertyAsset, 'placed_in_service_date'>

function basis(date: string | null | undefined, source: AgeBasisSource): AgeBasis | null {
  return date ? { date, source, estimated: source === 'manufacture' } : null
}

/**
 * The date an asset's AGE is measured from — health scoring, capex
 * projection, the Weibull lifespan fit, and the age shown on an asset card.
 *
 * Deliberately does NOT consider placed_in_service_date. That column is a tax
 * election, not a physical fact: a PM can legitimately place a unit in service
 * in a different year from the one it was installed, and depreciating from
 * that date says nothing about how worn the compressor is.
 */
export function assetAgeBasis(asset: AgeBasisFields): AgeBasis | null {
  return basis(asset.installation_date, 'installation')
      ?? basis(asset.manufacture_date, 'manufacture')
}

/**
 * The date DEPRECIATION runs from. placed_in_service_date first, because that
 * is the column the PM (or their CPA) sets deliberately for exactly this
 * purpose; the physical dates only stand in when it was never recorded.
 */
export function assetServiceBasis(asset: ServiceBasisFields): AgeBasis | null {
  return basis(asset.placed_in_service_date, 'placed_in_service')
      ?? basis(asset.installation_date, 'installation')
      ?? basis(asset.manufacture_date, 'manufacture')
}

/**
 * Whole years ELAPSED from the basis date to now, floored at 0. Null when
 * undated.
 *
 * `now.getFullYear() - basis.getFullYear()` — calendar-year subtraction — was
 * the original implementation, and it is not the same question. An asset
 * installed December 20 and checked January 5 sixteen days later scored a
 * full year old: `getFullYear()` had already ticked over, even though almost
 * no time had actually passed. This function feeds a continuous decay curve
 * (weibullSurvivalFraction) and an age-normalized repair rate
 * (repairs / max(ageYears, 1)) in lib/assets/health-score.ts, both of which
 * are most sensitive to exactly this error at exactly the ages it is
 * largest at: an asset that is truly 0.1 years old reporting as 1 is a 10x
 * distortion, not a rounding nicety.
 *
 * The fix is the ordinary "age from a birthdate" algorithm: subtract calendar
 * years, then subtract one more if this year's month/day hasn't yet reached
 * the basis date's month/day — i.e. the anniversary hasn't happened yet.
 */
export function assetAgeYears(asset: AgeBasisFields, now: Date = new Date()): number | null {
  const found = assetAgeBasis(asset)
  if (!found) return null

  const basisDate = new Date(found.date)
  let years = now.getFullYear() - basisDate.getFullYear()
  const monthDiff = now.getMonth() - basisDate.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < basisDate.getDate())) {
    years--
  }
  return Math.max(years, 0)
}

/**
 * The note written onto a depreciation entry whose service date was inferred.
 * A CPA reading the ledger must be able to see which rows rest on a nameplate
 * year rather than on a date someone recorded.
 */
export const ESTIMATED_BASIS_NOTE =
  'Service date estimated from the nameplate manufacture year — no installation or placed-in-service date recorded.'

/** Suffix marking an estimated date in a rendered artifact (CPA export, UI). */
export const ESTIMATED_DATE_MARKER = '*'

/**
 * A basis date formatted for display, marked when estimated. Returns the
 * caller's placeholder when the asset carries no date at all.
 */
export function formatBasisDate(found: AgeBasis | null, placeholder = '—'): string {
  if (!found) return placeholder
  const day = found.date.slice(0, 10)
  return found.estimated ? `${day}${ESTIMATED_DATE_MARKER}` : day
}
