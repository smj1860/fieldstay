import type { Tables } from '@/types/database'
import 'server-only'
import { reportError } from '@/lib/observability/report-error'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * Copies every active row from the platform-curated inventory_catalog into
 * an org's own editable org_inventory_catalog the first time it needs one
 * — mirrors seedDefaultRoomTemplatesIfNeeded's shape (cheap idempotent
 * check on read, no Inngest job or trigger needed).
 *
 * The count-then-skip check is a fast path only, not the actual duplicate
 * guard — the insert below goes through upsert(..., { onConflict:
 * 'org_id,name', ignoreDuplicates: true }) against the org_inventory_catalog_
 * org_name_unique constraint (20260721160000_inventory_source_template_id.sql),
 * so two concurrent calls for the same brand-new org can't double-seed the
 * catalog even though this check-then-write sequence isn't itself atomic.
 */
export async function seedOrgInventoryCatalogIfNeeded(orgId: string): Promise<void> {
  const supabase = createServiceClient({ system: 'lib/inventory/seed-org-catalog' })

  const { count, error: countError } = await supabase
    .from('org_inventory_catalog')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)

  if (countError) {
    console.error('[seedOrgInventoryCatalogIfNeeded] failed to check existing catalog:', countError)
    return
  }
  if ((count ?? 0) > 0) return

  // Paginated: this read defines a NEW org's ENTIRE starting inventory catalog,
  // and it runs exactly once per org. A truncated result would seed that tenant
  // with a permanently incomplete catalog — there is no second pass to correct
  // it, because the count check above short-circuits every later call.
  let platformItems
  try {
    platformItems = await fetchAllRows<
      Pick<Tables<'inventory_catalog'>,
        'id' | 'name' | 'category' | 'default_unit' | 'default_par_level' | 'description'>
    >(
      (from, to) => supabase
        .from('inventory_catalog')
        .select('id, name, category, default_unit, default_par_level, description')
        .eq('is_active', true)
        .order('id')
        .range(from, to),
      { label: 'seedOrgInventoryCatalog.platformItems' },
    )
  } catch (error) {
    // Reported, not merely logged: returning here leaves the org with NO
    // inventory catalog, and the count check above means this function will
    // never retry for that org — the gap is permanent and invisible.
    console.error('[seedOrgInventoryCatalogIfNeeded] failed to fetch platform catalog:', error)
    reportError(error, { site: 'lib.inventory.seedOrgInventoryCatalog.platformItems' })
    return
  }
  if (!platformItems.length) return

  const { error: insertError } = await supabase
    .from('org_inventory_catalog')
    .upsert(
      platformItems.map((item) => ({
        org_id:                   orgId,
        platform_catalog_item_id: item.id,
        name:                     item.name,
        category:                 item.category,
        default_unit:             item.default_unit,
        default_par_level:        item.default_par_level,
        description:              item.description,
      })),
      { onConflict: 'org_id,name', ignoreDuplicates: true }
    )

  if (insertError) {
    console.error('[seedOrgInventoryCatalogIfNeeded] failed to insert org catalog items:', insertError)
  }
}
