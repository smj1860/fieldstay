// Shared geo-proximity scoring — used by both auto-assign-turnover.ts (crew)
// and auto-assign-vendor.ts (vendors). Extracted so a second suggestion
// engine didn't just re-paste the same haversine/bucket math inline again.

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function proximityScore(km: number): number {
  if (km <  5) return 1.0
  if (km < 15) return 0.8
  if (km < 30) return 0.6
  if (km < 50) return 0.4
  if (km < 80) return 0.2
  return 0.0
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}
