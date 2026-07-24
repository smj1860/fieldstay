import { createServiceClient } from '@/lib/supabase/server'

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

  // Fetch all existing slugs that start with the base slug in one query
  const { data: existing } = await supabase
    .from('guidebook_property_configs')
    .select('slug')
    .like('slug', `${baseSlug}%`)

  const taken = new Set((existing ?? []).map((r) => r.slug))

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

  // Fetch all existing slugs that could conflict in one query
  const { data: existing } = await supabase
    .from('guidebook_property_configs')
    .select('slug')
    .or(allBases.map((s) => `slug.like.${s}%`).join(','))

  const taken = new Set((existing ?? []).map((r) => r.slug))
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
