/**
 * Featured-amenity guest messaging — the "hot tub timing, fire pit" half of
 * the guest SMS nudges, separate from the sponsor-recommendation half these
 * crons already handle. A PM picks up to MAX_FEATURED_AMENITIES amenities on
 * a property (or leaves it blank, in which case the first ones the PMS
 * actually synced are used) and can write a short guest-facing line for each,
 * semicolon-separated, positionally matched to the selected amenities.
 */

import { tryUnwrap } from '@/lib/supabase/unwrap'
import type { DBClient } from '@/lib/supabase/server'

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
  //
  // Deliberately NOT .filter(Boolean)-ing empty segments out: a PM who
  // leaves a middle amenity's note blank (or fat-fingers a double
  // semicolon) would otherwise have every note after that position
  // silently compacted leftward — the same class of positional-shift bug
  // the comma-vs-semicolon choice above exists to avoid, just triggered a
  // different way. An empty segment at a given index just falls through to
  // the generic-mention fallback for that position instead, same as if
  // nothing had been typed there at all.
  const notes = (notesRaw ?? '').split(';').map((n) => n.trim())
  const idx   = ((rotationIndex % amenityKeys.length) + amenityKeys.length) % amenityKeys.length
  const note  = notes[idx]

  return note || `This property has a ${prettifyAmenityKey(amenityKeys[idx]!)}.`
}

/**
 * Composed lookup used identically by both guidebook-sms-morning-cron.ts and
 * guidebook-sms-evening-cron.ts — fetches the property's guidebook config,
 * resolves which amenities to feature, and picks the rotation-appropriate
 * line. Pulled out here (rather than duplicated in each cron) after
 * SonarCloud flagged the two nearly-identical inline blocks as duplicated
 * new code. `rotationOffset` lets the evening cron shift by 1 relative to
 * the morning cron so a guest getting both messages in the same day doesn't
 * see the same amenity mentioned twice.
 */
export async function getFeaturedAmenityLine(
  supabase: DBClient,
  params: {
    orgId:             string
    propertyId:        string
    propertyAmenities: Record<string, boolean> | null
    checkinDate:       string
    todayDate:         string
    rotationOffset?:   number
  },
): Promise<string | null> {
  // Degrade, don't throw: resolveFeaturedAmenities() already falls back to
  // the PMS-synced amenities when no config row is present, and an SMS
  // should still go out. tryUnwrap logs and reports.
  const guidebookConfigRes = await supabase
    .from('guidebook_property_configs')
    .select('featured_amenities, featured_amenity_notes')
    .eq('org_id', params.orgId)
    .eq('property_id', params.propertyId)
    .maybeSingle()

  const configOut = tryUnwrap(guidebookConfigRes, {
    site: 'lib.guidebook.featured-amenities', orgId: params.orgId,
  })
  const guidebookConfig = configOut.ok ? configOut.data : null

  const featuredAmenities = resolveFeaturedAmenities(
    guidebookConfig?.featured_amenities ?? null,
    params.propertyAmenities
  )

  return buildFeaturedAmenityLine(
    featuredAmenities,
    guidebookConfig?.featured_amenity_notes ?? null,
    daysSinceCheckin(params.checkinDate, params.todayDate) + (params.rotationOffset ?? 0)
  )
}
