// lib/evidence/capture.ts
//
// Everything the device can honestly say about a photo at the moment it is
// taken: the hash of the bytes that will be uploaded, their size, the device
// clock, and (only if the browser already granted it) where the device was.
//
// Hash FIRST, on the compressed blob, because that is the object Storage will
// hold. The server recomputes the same hash from the stored object and sets
// hash_verified only when they match. Hashing the original File instead would
// make every seal fail verification.
//
// GPS is read at TAP time, never at sync time (CLAUDE.md): the outbox can drain
// from a different location. It is advisory. No permission prompt is ever
// raised from here: a cleaner mid-turnover should not be asked a browser
// question by a photo button. NULL is the honest absence.

export interface CaptureMetadata {
  sha256:         string
  byte_size:      number
  captured_at:    string        // device clock, ISO
  lat:            number | null
  lng:            number | null
  gps_accuracy_ft: number | null
}

const GPS_TIMEOUT_MS = 3_000
const FEET_PER_METER = 3.28084

/** The browser reports accuracy in meters. This is the ONE conversion; every stored and printed distance is feet. */
export function metersToFeet(meters: number): number {
  return Math.round(meters * FEET_PER_METER)
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const buf    = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function geolocationAlreadyGranted(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('permissions' in navigator) || !('geolocation' in navigator)) return false
    const status = await navigator.permissions.query({ name: 'geolocation' })
    return status.state === 'granted'
  } catch {
    return false
  }
}

async function readPositionIfPermitted(): Promise<Pick<CaptureMetadata, 'lat' | 'lng' | 'gps_accuracy_ft'>> {
  const none = { lat: null, lng: null, gps_accuracy_ft: null }
  if (!(await geolocationAlreadyGranted())) return none
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(none), GPS_TIMEOUT_MS)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        resolve({
          lat:            Number(pos.coords.latitude.toFixed(6)),
          lng:            Number(pos.coords.longitude.toFixed(6)),
          gps_accuracy_ft: metersToFeet(pos.coords.accuracy),
        })
      },
      () => { clearTimeout(timer); resolve(none) },
      { enableHighAccuracy: false, timeout: GPS_TIMEOUT_MS, maximumAge: 60_000 },
    )
  })
}

/**
 * Call AFTER compressPhoto() and BEFORE the blob is queued. The hash and the
 * clock are read in that order so captured_at is never later than the bytes
 * it describes.
 */
export async function describeCapture(compressed: Blob): Promise<CaptureMetadata> {
  const sha256      = await sha256Hex(compressed)
  const captured_at = new Date().toISOString()
  const position    = await readPositionIfPermitted()
  return { sha256, byte_size: compressed.size, captured_at, ...position }
}

// ---------------------------------------------------------------------------
// Visit check-in. Unlike a photo's advisory GPS read above, this one is ASKED
// for: the crew member just tapped Start Turnover, so a browser permission
// prompt is expected and the fix is required (a turnover does not start
// without one). The caller shows the failure reason; nothing is queued then.
// ---------------------------------------------------------------------------

export interface CheckinFix {
  lat:             number
  lng:             number
  gps_accuracy_ft: number
  captured_at:     string
  device_now:      string
  attempt:         number
}

export type CheckinFixResult =
  | { ok: true; fix: CheckinFix }
  | { ok: false; reason: 'unsupported' | 'denied' | 'unavailable' | 'timeout' }

const CHECKIN_TIMEOUT_MS = 15_000
const MAX_CHECKIN_ATTEMPT = 50

/**
 * The attempt number is what keeps a deliberate re-check-in from colliding with
 * the first one in the ledger (the storage path carries it), while a RETRY of the
 * same queued request keeps its number. Per-device and best effort: storage can be
 * unavailable, in which case a re-check-in can only repeat attempt 1 and the server
 * reports it as a duplicate rather than writing twice.
 */
function nextAttempt(turnoverId: string, reuse: boolean): number {
  const key = `fs-checkin-attempt:${turnoverId}`
  try {
    const prev = Number(globalThis.localStorage?.getItem(key) ?? '0')
    const base = Number.isInteger(prev) && prev > 0 ? prev : 0
    const next = Math.min(reuse ? Math.max(base, 1) : base + 1, MAX_CHECKIN_ATTEMPT)
    globalThis.localStorage?.setItem(key, String(next))
    return next
  } catch {
    return 1
  }
}

function failureReason(err: GeolocationPositionError): 'denied' | 'unavailable' | 'timeout' {
  if (err.code === err.PERMISSION_DENIED) return 'denied'
  if (err.code === err.TIMEOUT) return 'timeout'
  return 'unavailable'
}

/** Pass `again: true` for a later "check in again"; the first check-in of a visit is attempt 1. */
export function requestCheckinFix(turnoverId: string, opts: { again?: boolean } = {}): Promise<CheckinFixResult> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
    return Promise.resolve({ ok: false, reason: 'unsupported' })
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const now = new Date().toISOString()
        resolve({
          ok: true,
          fix: {
            lat:             Number(pos.coords.latitude.toFixed(6)),
            lng:             Number(pos.coords.longitude.toFixed(6)),
            gps_accuracy_ft: metersToFeet(pos.coords.accuracy),
            captured_at:     now,
            device_now:      now,
            attempt:         nextAttempt(turnoverId, !opts.again),
          },
        })
      },
      (err) => resolve({ ok: false, reason: failureReason(err) }),
      { enableHighAccuracy: true, timeout: CHECKIN_TIMEOUT_MS, maximumAge: 0 },
    )
  })
}
