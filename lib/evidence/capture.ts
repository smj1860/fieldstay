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
  gps_accuracy_m: number | null
}

const GPS_TIMEOUT_MS = 3_000

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

async function readPositionIfPermitted(): Promise<Pick<CaptureMetadata, 'lat' | 'lng' | 'gps_accuracy_m'>> {
  const none = { lat: null, lng: null, gps_accuracy_m: null }
  if (!(await geolocationAlreadyGranted())) return none
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(none), GPS_TIMEOUT_MS)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer)
        resolve({
          lat:            Number(pos.coords.latitude.toFixed(6)),
          lng:            Number(pos.coords.longitude.toFixed(6)),
          gps_accuracy_m: Number(pos.coords.accuracy.toFixed(1)),
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
