import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { unstable_cache, revalidateTag } from 'next/cache'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { asSponsorAssignmentMode } from '@/lib/properties/defaults'
import { asSlotType } from '@/lib/guidebook/offer'
// Only MAX_SPONSORS_PER_PROPERTY is read inside this module; the re-export
// below is what gives ASSIGNMENT_MIN_PROPERTIES its server-side home.
import { MAX_SPONSORS_PER_PROPERTY } from '@/lib/guidebook/assignment-constants'
import { pickNearestSponsor, SPONSOR_POOL_COLUMNS, type SponsorPoolRow } from '@/lib/sms/pick-nearest-sponsor'
import type { GuidebookSlotType, SponsorAssignmentMode } from '@/types/database'

// Re-exported so server-side callers have one import, while the 'use client'
// assignment UI reads them from the leaf module directly — importing THIS
// module from a client component would fail the build on `server-only`.
export {
  MAX_SPONSORS_PER_PROPERTY,
  ASSIGNMENT_MIN_PROPERTIES,
} from '@/lib/guidebook/assignment-constants'

/**
 * ONE resolver, used by every read of "which sponsors belong on this
 * property" — the guest guidebook pages and both SMS nudge crons.
 *
 * Do not reimplement this per call site. The whole design rests on one
 * distinction (a property is either automatic or manually chosen) and a second
 * implementation of that rule is how the SMS a guest receives comes to disagree
 * with what the dashboard shows them.
 */


/**
 * The four named exclusive slots, in the order the media kit sells them.
 * `general` and `other` are the unnamed remainder and fill whatever is left.
 */
const NAMED_SLOT_TYPES: GuidebookSlotType[] = [
  'morning_brew',
  'dinner_pints',
  'rainy_day',
  'outdoor_adventure',
]

const FILLER_SLOT_TYPES: GuidebookSlotType[] = ['general', 'other']

export interface ResolvedSponsor extends ResolverSponsorRow {
  /**
   * Why this sponsor is on this property. `manual` means a person chose it;
   * `nearest` means proximity did, and distanceMiles says how near.
   *
   * The UI shows this so a manager can see the automatic pick working and
   * knows they only need to intervene where it is wrong.
   */
  assignedBy:    'manual' | 'nearest'
  distanceMiles: number | null
}

export interface PropertySponsorResolution {
  mode:     'auto' | 'manual'
  sponsors: ResolvedSponsor[]
}

/**
 * The UNION of what every consumer needs: the SMS pool columns plus the ones
 * only the guest guidebook renders.
 *
 * One column list rather than one per caller, because the point of this module
 * is that every surface resolves the same set of sponsors — and a caller that
 * needs a column the resolver does not select is exactly the pressure that
 * produces a second, divergent read. The extra columns cost nothing: the
 * schema caps this at six rows per org.
 */
const RESOLVER_SPONSOR_COLUMNS =
  `${SPONSOR_POOL_COLUMNS}, status, business_description, address, featured_item, ` +
  'business_phone, business_website, photo_storage_path'

/**
 * A sponsor row as the resolver selects it.
 *
 * `slot_type` is narrowed from the bare `string` PostgREST returns, because
 * this module and both nudge crons branch on it — an unchecked comparison
 * against a literal is how a slot silently stops being selected.
 */
export interface ResolverSponsorRow extends Omit<SponsorPoolRow, 'slot_type'> {
  slot_type:            GuidebookSlotType
  status:               string
  business_description: string | null
  address:              string | null
  featured_item:        string | null
  business_phone:       string | null
  business_website:     string | null
  photo_storage_path:   string | null
}

/**
 * The property fields the resolver needs. Callers that have already read the
 * property (both crons, both guest pages) pass it straight in rather than
 * making this module re-read it.
 */
export interface ResolvablePropertyRow {
  id:                      string
  lat:                     number | null
  lng:                     number | null
  sponsor_assignment_mode: SponsorAssignmentMode
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = SupabaseClient<any, 'public', any>

/**
 * Sponsors for one property, honouring a manual choice and computing a nearest
 * pick otherwise.
 *
 * **Computed at read time. Automatic assignments are never materialised into
 * rows**, and that is load-bearing rather than a performance opinion: a
 * materialised auto-assignment goes stale the moment a property or sponsor is
 * added, and — worse — becomes indistinguishable from a manual choice, which
 * is the one distinction the whole design rests on.
 *
 * **Determinism is a correctness requirement here, not a nicety.** This runs on
 * a PUBLIC guest page; two loads a second apart must not show different
 * sponsors. `pickNearestSponsor` falls back to `sponsors[0]` when no sponsor in
 * a pool has coordinates, so input order decides the output — every query below
 * is therefore `.order('id')`, matching what the crons already do, and the
 * grouping preserves that order.
 *
 * Takes the property ROW, not an id: every production caller (both crons, both
 * guest pages) has already read it, and re-reading it here would add a query
 * per guest to the SMS path for data the caller is holding.
 */
export async function resolveSponsorsForProperty(
  supabase: AnySupabase,
  orgId:    string,
  property: ResolvablePropertyRow,
  site = 'lib.guidebook.resolve-property-sponsors',
): Promise<PropertySponsorResolution> {
  if (property.sponsor_assignment_mode === 'manual') {
    return { mode: 'manual', sponsors: await resolveManual(supabase, orgId, property, site) }
  }
  return { mode: 'auto', sponsors: await resolveAuto(supabase, orgId, property, site) }
}

/**
 * The Next.js cache tag every sponsor/assignment write must revalidate.
 * One tag per org — a sponsor change in one org never needs to invalidate
 * another org's guest pages, and per-org is the natural invalidation
 * boundary here since every read in this module is already org-scoped.
 */
export function sponsorsCacheTag(orgId: string): string {
  return `sponsors-${orgId}`
}

/** How long a guest-facing sponsor resolution may be served stale. */
const SPONSOR_CACHE_REVALIDATE_SECONDS = 60

/**
 * Cached wrapper around `resolveSponsorsForProperty`, for the guest-facing
 * guidebook pages (`app/g/[slug]/page.tsx`, `app/g/b/[token]/page.tsx`).
 *
 * Every guest page load used to run resolveAuto's org-wide sponsor read (now
 * paginated, so potentially several round trips) plus resolveManual's
 * assignment join fresh, on a PUBLIC route with no per-request cost control —
 * a page that gets hit by every guest, every reload, with no session to key a
 * per-user cache off. 60s is generous enough that a sponsor swap is visible
 * within a minute even with nobody explicitly invalidating, and
 * `revalidateTag(sponsorsCacheTag(orgId))` on every sponsor/assignment write
 * (see `app/actions/sponsor-assignments.ts` and `app/actions/guidebook.ts`)
 * clears it immediately when a PM actually changes something, so a guest
 * never has to wait out the TTL for a real edit to show up.
 *
 * `unstable_cache` is called fresh on every invocation rather than once at
 * module scope, specifically so the TAG can be computed per `orgId` — the key
 * PARTS (not the closure arguments) are what Next.js uses for cache identity,
 * so a deterministic keyParts array here is what makes this a real cache
 * rather than a one-shot memoization.
 *
 * Deliberately NOT used by the SMS nudge crons or the PM dashboard: a cron
 * deciding who gets texted, and a PM checking a change they just saved, both
 * need the live picture, not a minute-old one.
 */
export async function resolveSponsorsForPropertyCached(
  supabase: AnySupabase,
  orgId:    string,
  property: ResolvablePropertyRow,
  site = 'lib.guidebook.resolve-property-sponsors.cached',
): Promise<PropertySponsorResolution> {
  const cached = unstable_cache(
    () => resolveSponsorsForProperty(supabase, orgId, property, site),
    ['resolve-sponsors-for-property', orgId, property.id, property.sponsor_assignment_mode],
    { revalidate: SPONSOR_CACHE_REVALIDATE_SECONDS, tags: [sponsorsCacheTag(orgId)] },
  )
  return cached()
}

/**
 * Call after any write that changes what a property's guests should see:
 * a sponsor's own fields, which properties it's assigned to, or a property's
 * auto/manual mode. Safe to call even when nothing was cached yet.
 *
 * `revalidateTag(tag, 'max')`, not the single-argument call (Next.js 16 made
 * the second `profile` argument required and deprecated the one-arg form —
 * see the `revalidateTag` header comment) and not `updateTag(tag)` (Next's
 * suggested replacement, but it throws unless called from within a Server
 * Action). This helper is called both from Server Actions
 * (`app/actions/sponsor-assignments.ts`, `app/actions/guidebook.ts`) AND from
 * Inngest `step.run()` callbacks reached through the `/api/inngest` Route
 * Handler, so it needs the form that works in both. `'max'` has no bearing
 * here regardless — this cache is tagged the classic `unstable_cache({
 * revalidate, tags })` way, not through the newer per-segment "cacheLife"
 * profile system the argument configures — it only satisfies the type and
 * matches Next's own migration guidance for a plain "purge this tag now".
 */
export function invalidateSponsorsCache(orgId: string): void {
  revalidateTag(sponsorsCacheTag(orgId), 'max')
}

/**
 * The same, for a caller that has only an id. Reads the property, then
 * delegates — so there is still exactly one implementation of the rule.
 */
export async function resolvePropertySponsors(
  supabase:   AnySupabase,
  orgId:      string,
  propertyId: string,
  site = 'lib.guidebook.resolve-property-sponsors',
): Promise<PropertySponsorResolution> {
  const propertyRes = await supabase
    .from('properties')
    .select('id, lat, lng, sponsor_assignment_mode')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .maybeSingle()

  const row = unwrap(propertyRes, { site, orgId }) as
    (Omit<ResolvablePropertyRow, 'sponsor_assignment_mode'> & { sponsor_assignment_mode: string }) | null
  if (!row) return { mode: 'auto', sponsors: [] }

  return resolveSponsorsForProperty(
    supabase, orgId,
    { ...row, sponsor_assignment_mode: asSponsorAssignmentMode(row.sponsor_assignment_mode) },
    site,
  )
}

/**
 * A manual property gets exactly what was chosen and nothing added.
 *
 * Joined to the sponsor rather than trusting the assignment row on its own: a
 * sponsor whose subscription lapsed is no longer `active` and must stop
 * appearing, even though the assignment row survives — deliberately, so the
 * manager's choice comes back when they pay again rather than having to be
 * re-made.
 */
async function resolveManual(
  supabase: AnySupabase,
  orgId:    string,
  property: ResolvablePropertyRow,
  site:     string,
): Promise<ResolvedSponsor[]> {
  const res = await supabase
    .from('guidebook_sponsor_assignments')
    .select(`sponsor_id, guidebook_sponsors!inner ( ${RESOLVER_SPONSOR_COLUMNS} )`)
    .eq('org_id', orgId)
    .eq('property_id', property.id)
    .eq('guidebook_sponsors.status', 'active')
    .order('sponsor_id')
    .limit(MAX_SPONSORS_PER_PROPERTY)

  const rows = unwrapList(res, { site, orgId }) as AssignmentJoinRow[]

  return rows
    .map((r) => (Array.isArray(r.guidebook_sponsors) ? r.guidebook_sponsors[0] : r.guidebook_sponsors))
    .filter((s): s is Omit<ResolverSponsorRow, 'slot_type'> & { slot_type: string } => Boolean(s))
    .map(toResolverRow)
    .map((s) => ({ ...s, assignedBy: 'manual' as const, distanceMiles: distanceFor(s, property) }))
}

/** Narrows the one column this module branches on. */
function toResolverRow(row: Omit<ResolverSponsorRow, 'slot_type'> & { slot_type: string }): ResolverSponsorRow {
  return { ...row, slot_type: asSlotType(row.slot_type) }
}

interface AssignmentJoinRow {
  sponsor_id:         string
  guidebook_sponsors:
    | (Omit<ResolverSponsorRow, 'slot_type'> & { slot_type: string })
    | (Omit<ResolverSponsorRow, 'slot_type'> & { slot_type: string })[]
    | null
}

/**
 * An automatic property gets the nearest sponsor in each named category, then
 * fills any remaining slots from general/other, nearest first, capped at four.
 */
async function resolveAuto(
  supabase: AnySupabase,
  orgId:    string,
  property: ResolvablePropertyRow,
  site:     string,
): Promise<ResolvedSponsor[]> {
  const sponsors = await fetchActiveSponsors(supabase, orgId, site)
  return selectAutoSponsors(sponsors, property)
}

/**
 * The org's active sponsors, ordered by id.
 *
 * `.order('id')` is not cosmetic: it is what makes the coordinate-less
 * fallback in `pickNearestSponsor` deterministic, and this runs on a public
 * page — a UUID's own ordering has no business meaning, so it doubles as the
 * tie-break "random" order the auto-selection logic wants while staying
 * perfectly stable across pages and across requests.
 *
 * Used to be a hard `.limit(64)` — generous headroom above the schema's
 * actual per-org ceiling (`guidebook_sponsors.slot_number` CHECK 1..6), but
 * still a hardcoded bound that would silently truncate the moment that
 * constraint was ever widened past it, on a page that decides which sponsors
 * a guest actually sees. `fetchAllRows()` paginates via `.range()` instead —
 * the same stable `.order('id')` this already had is exactly what
 * `fetchAllRows` requires for its page boundaries to be consistent, so
 * removing the cap needed no other change to the query.
 */
async function fetchActiveSponsors(
  supabase: AnySupabase,
  orgId:    string,
  site:     string,
): Promise<ResolverSponsorRow[]> {
  const rows = await fetchAllRows<Omit<ResolverSponsorRow, 'slot_type'> & { slot_type: string }>(
    (from, to) => (
      supabase
        .from('guidebook_sponsors')
        .select(RESOLVER_SPONSOR_COLUMNS)
        .eq('org_id', orgId)
        .eq('status', 'active')
        .order('id')
        .range(from, to)
      // `as unknown as` because the select string is built from a constant
      // rather than a literal, so postgrest-js infers GenericStringError[].
    ) as unknown as PromiseLike<{ data: (Omit<ResolverSponsorRow, 'slot_type'> & { slot_type: string })[] | null; error: { message: string } | null }>,
    // fetchAllRows() throws a generic Error rather than routing through
    // unwrapList()/reportError() — the `site` this function was always
    // called with (from resolveAuto -> resolveSponsorsForProperty's callers)
    // still goes into the label so a thrown error is attributable.
    { label: `${site}.guidebook_sponsors(${orgId})` },
  )

  return rows.map(toResolverRow)
}

/**
 * The automatic selection rule, as a pure function so it can be tested without
 * a database — including the determinism property, which is the one that
 * actually matters on a public page.
 *
 * Exported for that reason; production callers go through
 * `resolveSponsorsForProperty`.
 */
export function selectAutoSponsors(
  sponsors: ResolverSponsorRow[],
  property: { lat: number | null; lng: number | null },
): ResolvedSponsor[] {
  const picked: ResolvedSponsor[] = []

  /**
   * Takes the nearest sponsor from `pool` and returns the pool without it, so
   * the filler loop below cannot pick the same business twice.
   *
   * A property with no coordinates of its own has no "nearest": every distance
   * would be measured from nothing. Rather than let that degrade into an
   * arbitrary-but-confident answer, the pool's id order decides and
   * distanceMiles stays null, so nothing claims a mileage it did not compute.
   */
  const takeNearest = (pool: ResolverSponsorRow[]): ResolverSponsorRow[] => {
    if (pool.length === 0 || picked.length >= MAX_SPONSORS_PER_PROPERTY) return pool

    if (property.lat === null || property.lng === null) {
      const [first, ...rest] = pool
      picked.push({ ...first, assignedBy: 'nearest', distanceMiles: null })
      return rest
    }

    const hit = pickNearestSponsor(pool, property.lat, property.lng)
    if (!hit) return pool
    picked.push({ ...hit.sponsor, assignedBy: 'nearest', distanceMiles: hit.distanceMiles })
    return pool.filter((s) => s.id !== hit.sponsor.id)
  }

  // One per named category, in the media kit's own order.
  for (const slot of NAMED_SLOT_TYPES) {
    if (picked.length >= MAX_SPONSORS_PER_PROPERTY) break
    takeNearest(sponsors.filter((s) => s.slot_type === slot))
  }

  // Then fill any remaining slots from general, then other, nearest first. A
  // property may legitimately carry several of these, so this drains the pool
  // rather than taking one.
  for (const slot of FILLER_SLOT_TYPES) {
    let pool = sponsors.filter((s) => s.slot_type === slot)
    while (picked.length < MAX_SPONSORS_PER_PROPERTY && pool.length > 0) {
      const before = pool.length
      pool = takeNearest(pool)
      if (pool.length === before) break   // nothing taken — stop rather than spin
    }
  }

  return picked
}

/**
 * Distance from a property to a sponsor, or null when either lacks
 * coordinates. Reuses pickNearestSponsor on a one-element pool rather than
 * duplicating the haversine it already owns.
 */
function distanceFor(
  sponsor:  ResolverSponsorRow,
  property: { lat: number | null; lng: number | null },
): number | null {
  if (property.lat === null || property.lng === null) return null
  return pickNearestSponsor([sponsor], property.lat, property.lng)?.distanceMiles ?? null
}

/**
 * The same resolution for MANY properties at once.
 *
 * The dashboard needs this per property, and calling the single-property
 * resolver in a loop is precisely the N+1 that
 * `unit/guardrails/n-plus-one-loops.test.ts` exists to catch. This reads the
 * org's sponsors ONCE and every assignment row ONCE, then resolves in memory.
 */
export async function resolveSponsorsForProperties(
  supabase:   AnySupabase,
  orgId:      string,
  properties: ResolvablePropertyRow[],
  site = 'lib.guidebook.resolve-sponsors-for-properties',
): Promise<Map<string, PropertySponsorResolution>> {
  const out = new Map<string, PropertySponsorResolution>()
  if (properties.length === 0) return out

  const propertyIds = properties.map((p) => p.id)

  const [sponsors, assignmentsRes] = await Promise.all([
    fetchActiveSponsors(supabase, orgId, site),
    supabase
      .from('guidebook_sponsor_assignments')
      .select('property_id, sponsor_id')
      .eq('org_id', orgId)
      .in('property_id', propertyIds)
      .order('property_id')
      .order('sponsor_id')
      // Every property could legitimately hold the cap.
      .limit(propertyIds.length * MAX_SPONSORS_PER_PROPERTY),
  ])

  const assignments = unwrapList(assignmentsRes, { site, orgId }) as
    { property_id: string; sponsor_id: string }[]

  const activeById = new Map(sponsors.map((s) => [s.id, s]))

  const assignedByProperty = new Map<string, string[]>()
  for (const a of assignments) {
    const list = assignedByProperty.get(a.property_id) ?? []
    list.push(a.sponsor_id)
    assignedByProperty.set(a.property_id, list)
  }

  for (const property of properties) {
    if (property.sponsor_assignment_mode === 'manual') {
      const chosen = (assignedByProperty.get(property.id) ?? [])
        .map((id) => activeById.get(id))
        .filter((s): s is ResolverSponsorRow => Boolean(s))
        .slice(0, MAX_SPONSORS_PER_PROPERTY)
        .map((s) => ({ ...s, assignedBy: 'manual' as const, distanceMiles: distanceFor(s, property) }))
      out.set(property.id, { mode: 'manual', sponsors: chosen })
      continue
    }

    out.set(property.id, { mode: 'auto', sponsors: selectAutoSponsors(sponsors, property) })
  }

  return out
}
