/**
 * Supabase nested-join fields come back as an array or a single object
 * depending on how the relationship was inferred (nullable/multi FK vs.
 * one-to-one) — this ambiguity was independently re-unwrapped at several
 * call sites across the dashboard. Two shapes recur:
 *
 * - "give me the first (or only) row" → unwrapJoin()
 * - "give me every row, always as an array" → unwrapJoinArray()
 */

export function unwrapJoin<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export function unwrapJoinArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}
