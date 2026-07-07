import { requireProperty } from '@/lib/auth'
import { InventorySetup } from './inventory-setup'
import { Card } from '@/components/ui/Card'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Inventory Setup' }

interface Props { params: Promise<{ id: string }> }

export default async function InventoryPage({ params }: Props) {
  const { id } = await params
  const { property, supabase, membership } = await requireProperty(id)

  const [{ data: catalogItems }, { data: propertyItems }, { data: templateItems }, { data: siblingItems }] = await Promise.all([
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
    supabase
      .from('inventory_items')
      .select('property_id, properties!inner(name)')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .neq('property_id', property.id),
  ])

  const templateBrands: Record<string, string | null> = {}
  const rawItems = (templateItems as { inventory_template_items?: { name: string; preferred_brand: string | null }[] } | null)
    ?.inventory_template_items ?? []
  for (const ti of rawItems) {
    templateBrands[ti.name.toLowerCase()] = ti.preferred_brand
  }

  const templateId   = templateItems?.id ?? undefined
  const templateName = (templateItems as { name?: string } | null)?.name ?? undefined

  const itemCountByProperty: Record<string, number> = {}
  const propertyNames: Record<string, string> = {}
  for (const row of siblingItems ?? []) {
    itemCountByProperty[row.property_id] = (itemCountByProperty[row.property_id] ?? 0) + 1
    const p = Array.isArray(row.properties) ? row.properties[0] : row.properties
    if (p?.name) propertyNames[row.property_id] = p.name
  }
  const sourceProperties = Object.entries(itemCountByProperty)
    .map(([sid, itemCount]) => ({ id: sid, name: propertyNames[sid] ?? sid, itemCount }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Card>
      <h2 className="text-lg font-semibold text-primary-themed mb-1">Inventory</h2>
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
        sourceProperties={sourceProperties}
      />
    </Card>
  )
}
