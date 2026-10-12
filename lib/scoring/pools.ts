// Shared candidate-pool aggregation — used by both auto-assign-turnover.ts
// (crew) and auto-assign-vendor.ts (vendors). Both engines derive a
// workload count and a familiarity set from a list of historical rows in
// an identical shape; extracted so a future scoring-input tweak (e.g. the
// workload window, or what counts as "familiar") isn't a two-place edit
// that can silently drift.

/** Counts rows per entity id — e.g. open work orders or upcoming assignments per crew/vendor. */
export function computeWorkloadMap<T>(
  rows:  T[],
  getId: (row: T) => string | null | undefined,
): Record<string, number> {
  const map: Record<string, number> = {}
  for (const row of rows) {
    const id = getId(row)
    if (!id) continue
    map[id] = (map[id] ?? 0) + 1
  }
  return map
}

/** Dedups entity ids out of historical rows — e.g. "which crew/vendor has touched this property before." */
export function computeFamiliarIds<T>(
  rows:  T[],
  getId: (row: T) => string | null | undefined,
): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    const id = getId(row)
    if (id) ids.add(id)
  }
  return [...ids]
}

/**
 * Buckets rows into `date -> entity id -> count`, where the date is the local
 * calendar day of an ISO timestamp.
 *
 * The companion to computeWorkloadMap, and it exists because that one flattens
 * a 14-day window into a single number: three turnovers stacked on one Tuesday
 * score exactly the same as three spread across a fortnight, which is the one
 * distinction a scheduler actually cares about. Both are kept — the day count
 * is what matters, the fortnight count is what smooths it.
 *
 * The date is taken from the ISO string's leading `YYYY-MM-DD` rather than
 * through `new Date()`, deliberately. `checkout_datetime` is stored UTC, and
 * parsing it into a Date and reading local parts would bucket a late-evening
 * checkout into the next day for a server running east of the stored zone and
 * the previous one for a server west of it — so the same turnover would land
 * in different buckets depending on where the function happened to execute.
 * Slicing the string keeps every caller agreeing with the `.split('T')[0]`
 * that auto-assign-turnover already uses to look up crew_availability, which
 * is the comparison that has to line up.
 */
export function computeDayWorkloadMap<T>(
  rows:    T[],
  getId:   (row: T) => string | null | undefined,
  getWhen: (row: T) => string | null | undefined,
): Record<string, Record<string, number>> {
  const byDate: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    const id   = getId(row)
    const when = getWhen(row)
    if (!id || !when) continue
    const date = when.slice(0, 10)
    const day  = byDate[date] ?? (byDate[date] = {})
    day[id] = (day[id] ?? 0) + 1
  }
  return byDate
}
