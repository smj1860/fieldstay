// lib/inspections/start-time.ts
//
// Translating a device's start time into server time.
//
// Lives here rather than in the route because it is the whole substance of
// 20260823053931 — the reason an inspection can be started at a property with
// no signal at all — and because a Next route file should export HTTP methods,
// not helpers a test needs to reach.

/**
 * The device's start time, translated into server time.
 *
 * `offset = server_now − device_now`, both read at the same instant, so it
 * measures the device's skew rather than the elapsed time since the walk began.
 * Adding it to the device's start gives what the server's clock would have read
 * at that moment.
 *
 * CLAMPED to the present. A corrected start in the future means the device's
 * two readings disagree with each other — the clock changed mid-walk — and an
 * inspection that started after now is nonsense. The raw claim is still stored,
 * so the correction remains visible rather than being quietly rewritten.
 */
export function resolveStartTime(
  deviceStartedAt: string,
  deviceNow:       string,
  serverNowMs:     number = Date.now(),
): { startedAt: string; offsetSeconds: number } {
  const offsetMs      = serverNowMs - Date.parse(deviceNow)
  const offsetSeconds = Math.round(offsetMs / 1000)
  const corrected     = Date.parse(deviceStartedAt) + offsetMs

  return {
    startedAt:     new Date(Math.min(corrected, serverNowMs)).toISOString(),
    offsetSeconds,
  }
}
