import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'

/**
 * Generates a URL-safe slug from a property name.
 * "Bear Hollow Cabin #2" → "bear-hollow-cabin-2"
 */
export function generateBaseSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) // cap length
}

/**
 * Generates a unique slug for a property by checking for collisions
 * and appending a numeric suffix when needed.
 *
 * Returns the first available slug in the sequence:
 *   bear-hollow-cabin
 *   bear-hollow-cabin-2
 *   bear-hollow-cabin-3
 *   ...
 */
export async function generateUniqueSlug(propertyName: string): Promise<string> {
  const supabase  = createServiceClient({ system: 'lib/guidebook/slug' })
  const baseSlug  = generateBaseSlug(propertyName)

  // Paginated: `slug` is GLOBALLY unique (guidebook_property_configs_slug_key),
  // so this prefix scan spans every tenant. Truncating it at PostgREST's
  // max_rows = 1000 yields an INCOMPLETE `taken` set, which hands back a slug
  // that is already in use — the insert then fails on the unique constraint
  // (23505) rather than doing anything silently wrong, but the caller sees an
  // unexplained error instead of a working guidebook.
  const existing = await fetchAllRows<{ slug: string }>(
    (from, to) => supabase
      .from('guidebook_property_configs')
      .select('slug')
      .like('slug', `${baseSlug}%`)
      .order('slug')
      .range(from, to),
    { label: 'guidebook.slug.generateUniqueSlug' },
  )

  const taken = new Set(existing.map((r) => r.slug))

  if (!taken.has(baseSlug)) return baseSlug

  let suffix = 2
  while (taken.has(`${baseSlug}-${suffix}`)) {
    suffix++
  }
  return `${baseSlug}-${suffix}`
}

/**
 * Batch version: generates unique slugs for multiple properties in one
 * DB round-trip. Used by the OwnerRez sync and backfill script.
 *
 * Returns a map of propertyId → slug.
 */
export async function generateUniqueSlugsForProperties(
  properties: { id: string; name: string }[]
): Promise<Map<string, string>> {
  const supabase = createServiceClient({ system: 'lib/guidebook/slug' })

  // Generate all base slugs first
  const baseSlugs = properties.map((p) => ({
    id:       p.id,
    baseSlug: generateBaseSlug(p.name),
  }))

  const allBases = baseSlugs.map((b) => b.baseSlug)

  // Paginated for the same reason as the single-property form above, and more
  // acutely: this ORs one prefix per property in the batch, so a full-portfolio
  // sync scans a correspondingly larger slice of a globally-unique column.
  const existing = await fetchAllRows<{ slug: string }>(
    (from, to) => supabase
      .from('guidebook_property_configs')
      .select('slug')
      .or(allBases.map((s) => `slug.like.${s}%`).join(','))
      .order('slug')
      .range(from, to),
    { label: 'guidebook.slug.generateUniqueSlugsForProperties' },
  )

  const taken = new Set(existing.map((r) => r.slug))
  const result = new Map<string, string>()

  // Assign unique slugs, tracking within-batch assignments too
  for (const { id, baseSlug } of baseSlugs) {
    if (!taken.has(baseSlug)) {
      taken.add(baseSlug)
      result.set(id, baseSlug)
      continue
    }
    let suffix = 2
    while (taken.has(`${baseSlug}-${suffix}`)) suffix++
    const unique = `${baseSlug}-${suffix}`
    taken.add(unique)
    result.set(id, unique)
  }

  return result
}
