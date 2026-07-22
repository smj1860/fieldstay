import 'server-only'
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
  const supabase = createServiceClient()

  const { count, error: countError } = await supabase
    .from('org_inventory_catalog')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)

  if (countError) {
    console.error('[seedOrgInventoryCatalogIfNeeded] failed to check existing catalog:', countError)
    return
  }
  if ((count ?? 0) > 0) return

  const { data: platformItems, error } = await supabase
    .from('inventory_catalog')
    .select('id, name, category, default_unit, description')
    .eq('is_active', true)

  if (error) {
    console.error('[seedOrgInventoryCatalogIfNeeded] failed to fetch platform catalog:', error)
    return
  }
  if (!platformItems?.length) return

  const { error: insertError } = await supabase
    .from('org_inventory_catalog')
    .upsert(
      platformItems.map((item) => ({
        org_id:                   orgId,
        platform_catalog_item_id: item.id,
        name:                     item.name,
        category:                 item.category,
        default_unit:             item.default_unit,
        description:              item.description,
      })),
      { onConflict: 'org_id,name', ignoreDuplicates: true }
    )

  if (insertError) {
    console.error('[seedOrgInventoryCatalogIfNeeded] failed to insert org catalog items:', insertError)
  }
}
