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

/**
 * One row of a crew member's day, as the prior-stop lookup needs it.
 *
 * `lat`/`lng` are the PROPERTY's, not the crew member's: this answers "where
 * will they be coming from", and the answer is the last place they were
 * working.
 */
export interface PriorStopRow {
  crewMemberId: string
  /**
   * The turnover's checkout timestamp. Both the day key and the ordering key.
   *
   * OPTIONAL rather than `string | null | undefined` on a required key: these
   * rows cross an Inngest step boundary, where JSON drops an undefined value
   * and the property itself goes missing. A required key would make the
   * serialized shape fail to type-check against the one that produced it.
   */
  when?:        string | null
  lat:          number | null
  lng:          number | null
}

export type CrewOrigin = { lat: number | null; lng: number | null } | null

/**
 * Each crew member's LAST stop before `before` on the same calendar day.
 *
 * This is what makes the scorer's proximity term measure from the right
 * place. Measuring from home is correct for the first job of a day and wrong
 * for every job after it — a crew member whose 10am is next door to the 2pm
 * being scored was being treated as though they would drive from their
 * kitchen, with 15% of the standard weight riding on it.
 *
 * The day is the ISO string's leading `YYYY-MM-DD`, the same slice
 * computeDayWorkloadMap() and the crew_availability lookup use, for the same
 * reason: parsing to a Date and reading local parts buckets a late-evening
 * checkout differently depending on where the function happens to run.
 *
 * A crew member with no earlier stop that day is deliberately ABSENT from the
 * result rather than present with a null — the scorer's fallback to home is
 * then the ordinary missing-key path, not a special case.
 */
export function computePriorStopOrigins(
  rows:   readonly PriorStopRow[],
  before: string,
): Record<string, CrewOrigin> {
  const day = before.slice(0, 10)
  const latestByCrew: Record<string, { when: string; lat: number | null; lng: number | null }> = {}

  for (const row of rows) {
    const when = row.when
    if (!when || when.slice(0, 10) !== day) continue

    // Strictly earlier. An equal timestamp is the turnover being scored
    // itself, or a genuine tie we cannot order — neither is a prior stop.
    if (when >= before) continue

    const current = latestByCrew[row.crewMemberId]
    if (!current || when > current.when) {
      latestByCrew[row.crewMemberId] = { when, lat: row.lat, lng: row.lng }
    }
  }

  const origins: Record<string, CrewOrigin> = {}
  for (const [crewId, stop] of Object.entries(latestByCrew)) {
    origins[crewId] = { lat: stop.lat, lng: stop.lng }
  }
  return origins
}
