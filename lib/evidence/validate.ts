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

export interface CheckinBody {
  lat:             number
  lng:             number
  gps_accuracy_ft: number
  captured_at:     string
  device_now:      string
  attempt:         number
}

const MAX_CHECKIN_ATTEMPT = 50
const MAX_CHECKIN_ACCURACY_FT = 100_000

/**
 * The check-in a crew device sends with Start Turnover (or a later re-check-in).
 * Closed ranges, whole-foot accuracy, positive attempt counter. Null when
 * anything is off: a check-in with a bad fix is not a check-in, and the route
 * answers it with a 400 the outbox treats as terminal.
 */
export function parseCheckinBody(raw: unknown): CheckinBody | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const lat = latOrNull(b.lat)
  const lng = lngOrNull(b.lng)
  const acc = b.gps_accuracy_ft
  const attempt = b.attempt
  if (lat === null || lng === null) return null
  if (typeof acc !== 'number' || !Number.isInteger(acc) || acc < 0 || acc > MAX_CHECKIN_ACCURACY_FT) return null
  if (!isIsoInstant(b.captured_at) || !isIsoInstant(b.device_now)) return null
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1 || attempt > MAX_CHECKIN_ATTEMPT) return null
  return { lat, lng, gps_accuracy_ft: acc, captured_at: b.captured_at, device_now: b.device_now, attempt }
}
