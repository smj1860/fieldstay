import { requireProperty, requireOrgMember } from '@/lib/auth'
import { ChecklistBuilder } from './checklist-builder'
import { Card } from '@/components/ui/Card'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { Metadata } from 'next'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'

export const metadata: Metadata = { title: 'Turnover Checklist' }
interface Props { params: Promise<{ id: string }> }

/** One sibling property's checklist template, with just enough to count its sections. */
interface SiblingTemplateRow {
  property_id:                 string | null
  properties:                  { name: string } | { name: string }[] | null
  checklist_template_sections: { id: string }[] | null
}


export default async function ChecklistPage({ params }: Props) {
  const { id } = await params
  const { property, supabase } = await requireProperty(id)
  const { membership } = await requireOrgMember()

  const [{ data: template, error: templateError }, { data: otherProperties, error: otherPropertiesError }, siblingTemplates, { data: roomTemplates, error: roomTemplatesError }] = await Promise.all([
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
    // Counted per TEMPLATE, not per section — this used to read
    // checklist_template_sections directly, one row per section across every
    // other property in the org, purely to compute a per-property COUNT in the
    // loop below. That is a GROUP BY done in JavaScript by fetching the raw
    // rows: at the audited ~7.3 sections per property a 100-property portfolio
    // pulled ~730 rows to produce ~99, and would have silently truncated at
    // PostgREST's max_rows = 1000 — dropping properties out of the "copy from
    // another property" picker with no indication they existed.
    //
    // Reading templates and embedding their sections inverts it: the top-level
    // row count is now one per TEMPLATE (~one per property, plan-capped), and
    // max_rows applies to top-level rows only, so the nested sections come
    // along whole. Paginated anyway, per the assets-page precedent — at this
    // size it is exactly one request, and it can never quietly truncate again.
    //
    // A PostgREST embedded aggregate — checklist_template_sections(count) —
    // would be smaller still, but nothing in this codebase uses one and
    // aggregate support could not be confirmed against the live instance from
    // here. Fetching the ids and taking .length needs no such guarantee.
    fetchAllRows<SiblingTemplateRow>(
      (rangeFrom, rangeTo) => supabase
        .from('checklist_templates')
        .select('property_id, properties!inner(name), checklist_template_sections(id)')
        .eq('org_id', membership.org_id)
        .neq('property_id', property.id)
        .order('property_id')
        .range(rangeFrom, rangeTo),
      { label: 'page.checklist-setup.siblingTemplates' },
    ),
    supabase
      .from('room_templates')
      .select(`id, name, auto_include, room_template_items ( id, task, requires_photo, notes, sort_order )`)
      .eq('org_id', membership.org_id)
      .order('name'),
  ])

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.properties.id.setup.checklist', orgId: membership.org_id }, templateError, otherPropertiesError, roomTemplatesError)

  const sectionCountByProperty: Record<string, number> = {}
  const propNameByProperty: Record<string, string> = {}
  for (const row of siblingTemplates) {
    if (!row.property_id) continue
    // SUMMED across a property's templates, not assigned — a property may hold
    // more than one template and the previous per-section count added them all
    // up. Templates with zero sections contribute nothing and so never enter
    // the map, which is also what the old shape did: a template with no
    // sections produced no rows at all. That matters — a property you cannot
    // actually copy anything from must not appear in the picker.
    const sectionCount = row.checklist_template_sections?.length ?? 0
    if (!sectionCount) continue
    sectionCountByProperty[row.property_id] = (sectionCountByProperty[row.property_id] ?? 0) + sectionCount
    const p = unwrapJoin(row.properties)
    if (p?.name) propNameByProperty[row.property_id] = p.name
  }
  const sourceProperties = Object.entries(sectionCountByProperty)
    .map(([sid, sectionCount]) => ({ id: sid, name: propNameByProperty[sid] ?? sid, sectionCount }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Card>
      <h2 className="text-lg font-semibold text-primary-themed mb-1">Turnover Checklist</h2>
      <p className="text-sm text-accent-500 mb-6">
        This property&apos;s checklist was already built automatically from its
        bedroom/bathroom count and the standard rooms (Whole Home, Kitchen,
        Living Room). Use this screen to add a room this property has that
        wasn&apos;t auto-included, or remove one it doesn&apos;t actually have —
        e.g. no Living Room.
      </p>
      <ChecklistBuilder
        propertyId={property.id}
        template={template ?? null}
        otherProperties={otherProperties ?? []}
        sourceProperties={sourceProperties}
        // Both nullable; 1 is each column's own DEFAULT.
        propertyBedrooms={property.bedrooms   ?? 1}
        propertyBathrooms={property.bathrooms ?? 1}
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
