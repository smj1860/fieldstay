// lib/db-enums.ts
// ============================================================
// Narrowing free-text values onto the Postgres enums the columns accept.
//
// A form field, a provider payload, or a query param arrives as `string`.
// The column is an enum. Before the <Database> generic was wired into the
// Supabase clients nothing compared the two, so a widened `string` reached
// the insert unchecked and Postgres rejected the WHOLE statement (22P02)
// with a raw driver error rather than a validation message.
// ============================================================

import { Constants, type Enums } from '@/types/database'

type EnumName = keyof typeof Constants.public.Enums

/**
 * True when `value` is a label of the named Postgres enum.
 *
 * The labels come from `Constants` — generated from the live schema — never
 * a hand-written list, because a second copy of an enum is a copy that
 * drifts away from the database silently.
 */
export function isDbEnum<N extends EnumName>(
  name:  N,
  value: string | null | undefined,
): value is Enums<N> {
  if (value === null || value === undefined) return false
  const valid: readonly string[] = Constants.public.Enums[name]
  return valid.includes(value)
}

/**
 * Narrow `value` to the named enum, falling back to `fallback` when it is
 * absent or not a valid label.
 *
 * Pass the column's OWN default as `fallback` (check
 * information_schema.columns.column_default) so a dropped value lands where
 * the database would have put it anyway, rather than on an invented one.
 */
export function toDbEnum<N extends EnumName>(
  name:     N,
  value:    string | null | undefined,
  fallback: Enums<N>,
): Enums<N> {
  return isDbEnum(name, value) ? value : fallback
}

/**
 * The same narrowing for a TEXT column constrained by a CHECK rather than by
 * a Postgres enum type (e.g. property_assets.replacement_status,
 * organizations.repuguard_status). A CHECK is invisible to both the generated
 * types and `Constants`, so the allowed values have to be named here — keep
 * them in sync with the constraint, and pass the column's own DEFAULT as
 * `fallback`.
 */
export function toOneOf<T extends string>(
  allowed:  readonly T[],
  value:    string | null | undefined,
  fallback: T,
): T {
  for (const candidate of allowed) {
    if (candidate === value) return candidate
  }
  return fallback
}
