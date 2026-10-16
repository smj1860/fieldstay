// Boundary validation shared by every route/action that accepts a
// client-supplied seal claim. Pure, so it is safe in any runtime.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SHA256_RE = /^[0-9a-f]{64}$/i

export const MAX_STORAGE_PATH_LENGTH = 512

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export function isSha256(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v)
}

export function isIsoInstant(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v))
}

export function isStoragePath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_STORAGE_PATH_LENGTH && !v.includes('..')
}

/** A finite number, or null for anything else (absent GPS is not an error). */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Latitude/longitude in range, else null. */
export function latOrNull(v: unknown): number | null {
  const n = finiteOrNull(v)
  return n !== null && n >= -90 && n <= 90 ? n : null
}
export function lngOrNull(v: unknown): number | null {
  const n = finiteOrNull(v)
  return n !== null && n >= -180 && n <= 180 ? n : null
}
