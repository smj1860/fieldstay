// lib/json.ts
// ============================================================
// Narrowing jsonb columns at the boundary where they are read.
//
// A jsonb column is typed `Json` — it holds whatever was last written to it,
// including a bare string or number. Code that treats one as an object (an
// integration's `metadata`, a property's `amenities`) is making an assumption
// the column itself does not enforce, so narrow once at the read rather than
// optional-chaining through the Json union at every use.
// ============================================================

import type { Json } from '@/types/database'

/** The object member of the Json union. */
export type JsonObject = { [key: string]: Json | undefined }

/** `value` as an object, or null when it is a scalar, an array, or absent. */
export function asJsonObject(value: Json | null | undefined): JsonObject | null {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null
}

/**
 * A jsonb object read as a flag map (e.g. properties.amenities), keeping only
 * the entries whose value really is a boolean.
 */
export function asBooleanMap(value: Json | null | undefined): Record<string, boolean> {
  const obj = asJsonObject(value)
  if (obj === null) return {}

  const out: Record<string, boolean> = {}
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === 'boolean') out[key] = v
  }
  return out
}
