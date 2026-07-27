import { requirePlatformAdmin } from '@/lib/auth'
import { Card } from '@/components/ui/Card'
import { PlatformInventoryTemplateBuilder } from './platform-inventory-template-builder'

export default async function InventoryTemplatesPage() {
  const { supabase } = await requirePlatformAdmin()

  const [{ data: templates }, { data: catalogItems }] = await Promise.all([
    supabase
      .from('platform_inventory_templates')
      .select(`
        id, name, description,
        platform_inventory_template_items ( id, catalog_item_id, par_level, preferred_brand, sort_order )
      `)
      .order('name'),
    supabase
      .from('inventory_catalog')
      .select('id, name, category, default_unit')
      .eq('is_active', true)
      .order('category')
      .order('name'),
  ])

  return (
    <Card>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
        Inventory Templates
      </h2>
      <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
        Build a reusable template from the global catalog (e.g. a &quot;Standard
        FieldStay Inventory Template&quot;) and broadcast it to every account or a
        selected set. Broadcasting only adds items an account doesn&apos;t
        already have — it never overwrites an account&apos;s own par level or
        preferred brand on an item they&apos;ve already customized, and never
        removes an item just because it was later removed from this template.
      </p>
      <PlatformInventoryTemplateBuilder
        initialTemplates={(templates ?? []).map((t) => ({
          id:          t.id,
          name:        t.name,
          description: t.description ?? '',
          items: [...(t.platform_inventory_template_items ?? [])]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => ({
              id:              item.id,
              catalog_item_id: item.catalog_item_id,
              par_level:       item.par_level,
              preferred_brand: item.preferred_brand ?? '',
            })),
        }))}
        catalogItems={(catalogItems ?? []).map((c) => ({
          id:           c.id,
          name:         c.name,
          category:     c.category,
          default_unit: c.default_unit,
        }))}
      />
    </Card>
  )
}
