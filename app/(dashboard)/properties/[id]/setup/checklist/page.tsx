import { requireProperty, requireOrgMember } from '@/lib/auth'
import { ChecklistBuilder } from './checklist-builder'
import { Card } from '@/components/ui/Card'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Turnover Checklist' }
interface Props { params: Promise<{ id: string }> }

export default async function ChecklistPage({ params }: Props) {
  const { id } = await params
  const { property, supabase } = await requireProperty(id)
  const { membership } = await requireOrgMember()

  const [{ data: template }, { data: otherProperties }, { data: siblingChecklistSections }, { data: roomTemplates }] = await Promise.all([
    supabase
      .from('checklist_templates')
      .select(`id, name, checklist_template_sections ( id, name, sort_order, room_template_id, checklist_template_items ( id, task, requires_photo, notes, sort_order ) )`)
      .eq('property_id', property.id)
      .eq('is_default', true)
      .single(),
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .neq('id', property.id)
      .order('name'),
    supabase
      .from('checklist_template_sections')
      .select('template_id, checklist_templates!inner(property_id, properties!inner(name))')
      .eq('checklist_templates.org_id', membership.org_id)
      .neq('checklist_templates.property_id', property.id),
    supabase
      .from('room_templates')
      .select(`id, name, auto_include, room_template_items ( id, task, requires_photo, notes, sort_order )`)
      .eq('org_id', membership.org_id)
      .order('name'),
  ])

  const sectionCountByProperty: Record<string, number> = {}
  const propNameByProperty: Record<string, string> = {}
  for (const row of siblingChecklistSections ?? []) {
    const tmpl = unwrapJoin(row.checklist_templates)
    if (!tmpl?.property_id) continue
    sectionCountByProperty[tmpl.property_id] = (sectionCountByProperty[tmpl.property_id] ?? 0) + 1
    const p = unwrapJoin(tmpl.properties)
    if (p?.name) propNameByProperty[tmpl.property_id] = p.name
  }
  const sourceProperties = Object.entries(sectionCountByProperty)
    .map(([sid, sectionCount]) => ({ id: sid, name: propNameByProperty[sid] ?? sid, sectionCount }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Card>
      <h2 className="text-lg font-semibold text-primary-themed mb-1">Turnover Checklist</h2>
      <p className="text-sm text-accent-500 mb-6">
        Build the checklist your crew follows for every turnover. Organize by room or area.
        Flag items that require a photo for accountability.
      </p>
      <ChecklistBuilder
        propertyId={property.id}
        template={template ?? null}
        otherProperties={otherProperties ?? []}
        sourceProperties={sourceProperties}
        propertyBedrooms={property.bedrooms}
        propertyBathrooms={property.bathrooms}
        roomTemplates={(roomTemplates ?? []).map((room) => ({
          id:          room.id,
          name:        room.name,
          autoInclude: room.auto_include,
          items: [...(room.room_template_items ?? [])]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((item) => ({
              task:           item.task,
              requires_photo: item.requires_photo,
              notes:          item.notes,
            })),
        }))}
      />
    </Card>
  )
}
