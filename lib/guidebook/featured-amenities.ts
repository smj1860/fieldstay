/**
 * Featured-amenity guest messaging — the "hot tub timing, fire pit" half of
 * the guest SMS nudges, separate from the sponsor-recommendation half these
 * crons already handle. A PM picks up to MAX_FEATURED_AMENITIES amenities on
 * a property (or leaves it blank, in which case the first ones the PMS
 * actually synced are used) and can write a short guest-facing line for each,
 * semicolon-separated, positionally matched to the selected amenities.
 */

export const MAX_FEATURED_AMENITIES = 3

/**
 * OwnerRez already syncs amenity keys as Title Case ("Hot Tub"); Hospitable
 * syncs raw slugs ("hot_tub"). This makes both read the same to a PM or
 * guest — idempotent on input that's already nicely cased.
 */
export function prettifyAmenityKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * The PM's explicit selection if they made one (clamped to the max even if
 * something upstream let more through), else the first amenities the PMS
 * actually synced for this property — so the feature still does something
 * for a PM who never touches this setting, per product decision.
 */
export function resolveFeaturedAmenities(
  configured:        string[] | null,
  propertyAmenities: Record<string, boolean> | null,
): string[] {
  if (configured && configured.length > 0) return configured.slice(0, MAX_FEATURED_AMENITIES)

  const synced = Object.entries(propertyAmenities ?? {})
    .filter(([, present]) => present)
    .map(([key]) => key)

  return synced.slice(0, MAX_FEATURED_AMENITIES)
}

/**
 * Whole days elapsed since check-in, clamped to >= 0. Used to rotate which
 * featured amenity shows up so a multi-night guest doesn't see the same one
 * every message — clamping keeps a same-day check-in or a malformed date
 * from producing a negative index.
 */
export function daysSinceCheckin(checkinDate: string, todayDate: string): number {
  const checkin = new Date(`${checkinDate}T00:00:00Z`)
  const today   = new Date(`${todayDate}T00:00:00Z`)
  const days    = Math.floor((today.getTime() - checkin.getTime()) / 86_400_000)
  return Math.max(0, days)
}

/**
 * Picks one featured amenity by rotation and returns the guest-facing line
 * for it — the PM's own semicolon-separated note at that position if they
 * wrote one, otherwise a generic mention. Returns null when there's nothing
 * to feature at all (no PM selection and nothing synced), so callers can
 * treat this exactly like "no content" from the sponsor side.
 */
export function buildFeaturedAmenityLine(
  amenityKeys:   string[],
  notesRaw:      string | null,
  rotationIndex: number,
): string | null {
  if (amenityKeys.length === 0) return null

  // Positional split on semicolons, matching the PM-facing UI's "separate
  // your three notes with semicolons" instruction. Semicolons were chosen
  // over commas specifically because a short guest-facing note is far more
  // likely to contain a comma ("takes 45 min to heat, so start it early")
  // than a semicolon — a note with an internal comma would otherwise shift
  // every note after it out of position.
  const notes = (notesRaw ?? '').split(';').map((n) => n.trim()).filter(Boolean)
  const idx   = ((rotationIndex % amenityKeys.length) + amenityKeys.length) % amenityKeys.length
  const note  = notes[idx]

  return note || `This property has a ${prettifyAmenityKey(amenityKeys[idx]!)}.`
}
