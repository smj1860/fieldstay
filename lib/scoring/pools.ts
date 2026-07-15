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
