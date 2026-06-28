/**
 * One-time backfill: creates guidebook_property_configs rows for all
 * existing active properties that don't already have one.
 *
 * Run after deploying this patch:
 *   DRY_RUN=true npx tsx scripts/backfill-guidebook-property-configs.ts
 *   npx tsx scripts/backfill-guidebook-property-configs.ts
 */

import { createClient } from '@supabase/supabase-js'
import { generateBaseSlug } from '../lib/guidebook/slug'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DRY_RUN = process.env.DRY_RUN === 'true'

async function main() {
  console.log(`\n── Guidebook Property Config Backfill ──`)
  console.log(`   Dry run: ${DRY_RUN}\n`)

  const { data: allProperties, error: propError } = await supabase
    .from('properties')
    .select('id, org_id, name')
    .eq('is_active', true)
    .order('name')

  if (propError) {
    console.error('Failed to fetch properties:', propError.message)
    process.exit(1)
  }

  console.log(`Found ${allProperties?.length ?? 0} active properties`)

  const { data: existingConfigs } = await supabase
    .from('guidebook_property_configs')
    .select('property_id')

  const alreadyConfigured = new Set(
    (existingConfigs ?? []).map((c) => c.property_id)
  )

  const newProperties = (allProperties ?? []).filter(
    (p) => !alreadyConfigured.has(p.id)
  )

  console.log(`${newProperties.length} properties need a guidebook config\n`)

  if (newProperties.length === 0) {
    console.log('Nothing to do.')
    process.exit(0)
  }

  const { data: existingSlugs } = await supabase
    .from('guidebook_property_configs')
    .select('slug')

  const taken = new Set((existingSlugs ?? []).map((r) => r.slug))

  const rows: { org_id: string; property_id: string; slug: string; is_published: boolean }[] = []

  for (const property of newProperties) {
    const baseSlug = generateBaseSlug(property.name)
    let slug       = baseSlug
    let suffix     = 2

    while (taken.has(slug)) {
      slug = `${baseSlug}-${suffix}`
      suffix++
    }

    taken.add(slug)
    rows.push({
      org_id:       property.org_id,
      property_id:  property.id,
      slug,
      is_published: false,
    })

    console.log(`  ${property.name} → /g/${slug}`)
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete. Set DRY_RUN=false to write ${rows.length} rows.`)
    process.exit(0)
  }

  const { error: insertError } = await supabase
    .from('guidebook_property_configs')
    .upsert(rows, {
      onConflict:       'org_id,property_id',
      ignoreDuplicates: true,
    })

  if (insertError) {
    console.error('Insert failed:', insertError.message)
    process.exit(1)
  }

  console.log(`\nCreated ${rows.length} guidebook property config row(s)`)
  process.exit(0)
}

main()
