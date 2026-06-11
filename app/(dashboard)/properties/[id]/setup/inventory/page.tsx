import { requireProperty } from '@/lib/auth'
import { InventorySetup } from './inventory-setup'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Inventory Setup' }

interface Props { params: Promise<{ id: string }> }

export default async function InventoryPage({ params }: Props) {
  const { id } = await params
  const { property, supabase, membership } = await requireProperty(id)

  const [{ data: catalogItems }, { data: propertyItems }, { data: templateItems }] = await Promise.all([
    supabase
      .from('inventory_catalog')
      .select('*')
      .eq('is_active', true)
      .order('category')
      .order('name'),
    supabase
      .from('inventory_items')
      .select('*')
      .eq('property_id', property.id)
      .eq('is_active', true)
      .order('category')
      .order('name'),
    supabase
      .from('inventory_templates')
      .select('id, name, inventory_template_items(name, preferred_brand)')
      .eq('org_id', membership.org_id)
      .limit(1)
      .maybeSingle(),
  ])

  const templateBrands: Record<string, string | null> = {}
  const rawItems = (templateItems as { inventory_template_items?: { name: string; preferred_brand: string | null }[] } | null)
    ?.inventory_template_items ?? []
  for (const ti of rawItems) {
    templateBrands[ti.name.toLowerCase()] = ti.preferred_brand
  }

  const templateId   = templateItems?.id ?? undefined
  const templateName = (templateItems as { name?: string } | null)?.name ?? undefined

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Inventory</h2>
      <p className="text-sm text-accent-500 mb-6">
        Add items to track for this property. Set a par level — when crew counts
        fall below it, FieldStay generates a purchase order for you.
      </p>
      <InventorySetup
        propertyId={property.id}
        catalogItems={catalogItems ?? []}
        existingItems={propertyItems ?? []}
        templateBrands={templateBrands}
        templateId={templateId}
        templateName={templateName}
      />
    </div>
  )
}
