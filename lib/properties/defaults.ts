// lib/properties/defaults.ts
// ============================================================
// Filling in properties columns that are NULLABLE with a DEFAULT.
//
// Ten `properties` columns are nullable in the schema but carry a DEFAULT, so
// a row written through the app always has a value while a row written any
// other way (a migration backfill, the Supabase dashboard, an integration
// sync that omits the column) may not. The hand-written `Property` interface
// and the client components built on it treat them as always-present.
//
// Rather than assert that at each call site, resolve them here — to the
// column's OWN default, so a filled value is exactly what Postgres would have
// stored. Verified against information_schema.columns.column_default.
// ============================================================

import type { Enums, Json, SponsorAssignmentMode } from '@/types/database'
import { asBooleanMap } from '@/lib/json'

/** The subset of `properties` columns this module resolves. */
type PropertyDefaultable = {
  property_type:           Enums<'property_type'> | null
  bedrooms:                number | null
  bathrooms:               number | null
  max_guests:              number | null
  avg_stay_length:         number | null
  avg_turnovers_per_month: number | null
  checkin_time:            string | null
  checkout_time:           string | null
  same_day_premium_pct:    number | null
  // jsonb flag maps — `Json` at the column, a boolean map to every consumer.
  setup_steps_completed:   Json
  amenities:               Json
  // `text` at the column (a CHECK constraint, not an enum), a two-value union
  // to every consumer.
  sponsor_assignment_mode: string
}

type Defaulted<T extends PropertyDefaultable> = Omit<T, keyof PropertyDefaultable> & {
  property_type:           Enums<'property_type'>
  bedrooms:                number
  bathrooms:               number
  max_guests:              number
  avg_stay_length:         number
  avg_turnovers_per_month: number
  checkin_time:            string
  checkout_time:           string
  same_day_premium_pct:    number
  setup_steps_completed:   Record<string, boolean>
  amenities:               Record<string, boolean>
  sponsor_assignment_mode: SponsorAssignmentMode
}

/**
 * A property row with its defaultable columns resolved.
 *
 * Also narrows the two jsonb flag maps (setup_steps_completed, amenities)
 * from `Json` to the boolean maps every consumer reads them as.
 *
 * `avg_nightly_rate` is deliberately absent: its DEFAULT is literally NULL,
 * so "unset" is a real state there and inventing a rate would be wrong.
 */
export function withPropertyDefaults<T extends PropertyDefaultable>(row: T): Defaulted<T> {
  return {
    ...row,
    property_type:           row.property_type           ?? 'house',
    bedrooms:                row.bedrooms                ?? 1,
    bathrooms:               row.bathrooms               ?? 1.0,
    max_guests:              row.max_guests              ?? 2,
    avg_stay_length:         row.avg_stay_length         ?? 3.0,
    avg_turnovers_per_month: row.avg_turnovers_per_month ?? 4.0,
    checkin_time:            row.checkin_time            ?? '15:00:00',
    checkout_time:           row.checkout_time           ?? '11:00:00',
    same_day_premium_pct:    row.same_day_premium_pct    ?? 25.0,
    setup_steps_completed:   asBooleanMap(row.setup_steps_completed),
    amenities:               asBooleanMap(row.amenities),
    sponsor_assignment_mode: asSponsorAssignmentMode(row.sponsor_assignment_mode),
  }
}

/**
 * Narrows the `text` column to its two real values.
 *
 * Only the exact string 'manual' counts as manual; anything else is 'auto'.
 * The DB CHECK makes a third value unrepresentable, so this is a narrowing
 * rather than a validation — but it decides which way an impossible value
 * falls, and 'auto' is the right side to land on: an unrecognised mode meaning
 * "automatic" shows the property its nearest sponsors, while defaulting the
 * other way would show a property nothing at all and look like data loss.
 */
export function asSponsorAssignmentMode(value: string | null): SponsorAssignmentMode {
  return value === 'manual' ? 'manual' : 'auto'
}
