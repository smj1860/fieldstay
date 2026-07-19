import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RoomTemplateItem } from '@/types/database'
import { logAuditEvent } from '@/lib/audit'
import { seedDefaultRoomTemplatesIfNeeded } from './seed-default-room-templates'

/**
 * Applies the org's master checklist to a single property.
 *
 * Creates the default template if it doesn't exist, then replaces all
 * sections and items (delete-then-insert) to avoid duplicates on re-apply.
 *
 * Composed exclusively from the org's room template library:
 * `auto_include` templates (Whole Home, Kitchen, Living Room by default,
 * plus anything else the PM has flagged) + one section per bedroom/bathroom
 * from the org's mapped templates. No flat-catalog fallback — see
 * seedDefaultRoomTemplatesIfNeeded, which guarantees every org has a real
 * room template library before this function's composition step runs.
 *
 * Does NOT overwrite an existing default template unless `force` is true.
 * The explicit "Apply to All Properties" button passes force=true; the
 * auto-creation paths (new property, OwnerRez sync) leave it as false so
 * they never clobber a template the PM already customised.
 */
// The manual property setup wizard flags the checklist step complete itself
// (saveChecklistTemplate + markStepComplete), but this function is also
// called from three automatic paths (new-property creation, OwnerRez sync,
// Hospitable sync) and the org-wide "Apply to All Properties" button, none
// of which go through the wizard. Without this, a property that already has
// a real, fully-populated checklist still shows the wizard's checklist step
// as incomplete forever, because nothing ever wrote setup_steps_completed.
async function markChecklistStepComplete(propertyId: string, supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase
    .from('properties')
    .select('setup_steps_completed')
    .eq('id', propertyId)
    .single()

  const current = (data?.setup_steps_completed as Record<string, boolean>) ?? {}
  if (current.checklist === true) return

  await supabase
    .from('properties')
    .update({ setup_steps_completed: { ...current, checklist: true } })
    .eq('id', propertyId)
}

interface ComposedSection {
  name:           string
  roomTemplateId: string | null
  items:          Array<{ task: string; requires_photo: boolean; notes: string | null; sort_order: number }>
}

interface RoomTemplateRow {
  id:           string
  name:         string
  auto_include: boolean
}

function toComposedItems(
  templateId:      string,
  itemsByTemplate: Map<string, RoomTemplateItem[]>,
): ComposedSection['items'] {
  return (itemsByTemplate.get(templateId) ?? []).map((i) => ({
    task: i.task, requires_photo: i.requires_photo, notes: i.notes, sort_order: i.sort_order,
  }))
}

// Extracted to a named helper (rather than a closure inside
// composeFromRoomTemplates) to keep that function's cognitive complexity
// down — same reasoning already applied to room-library-builder.tsx's own
// closures in this codebase.
//
// NOTE: this deliberately does NOT guard against a template that's both
// auto_include and mapped as bedroom/bathroom — that combination adds one
// auto_include section plus N/M counted ones for the same room, which is a
// PM configuration choice, not a bug this function needs to prevent.
function addCountedSections(
  sections:        ComposedSection[],
  roomTemplates:   RoomTemplateRow[],
  itemsByTemplate: Map<string, RoomTemplateItem[]>,
  templateId:      string | null | undefined,
  count:           number,
): void {
  if (!templateId || count <= 0) return
  const room = roomTemplates.find((r) => r.id === templateId)
  if (!room) return

  for (let i = 1; i <= count; i++) {
    const label = count > 1 ? `${room.name} ${i}` : room.name
    sections.push({ name: label, roomTemplateId: room.id, items: toComposedItems(room.id, itemsByTemplate) })
  }
}

/**
 * Builds checklist sections from the org's room template library: one
 * section per auto_include room, plus N sections from the bedroom-mapped
 * template (N = properties.bedrooms) and M from the bathroom-mapped
 * template (M = properties.bathrooms, treating null as 0). Can only
 * return an empty array if the org has zero room templates at all — after
 * seedDefaultRoomTemplatesIfNeeded's seed, that should never happen for an
 * org that's had it run at least once successfully.
 */
async function composeFromRoomTemplates(
  orgId:      string,
  bedrooms:   number,
  bathrooms:  number | null,
  supabase:   SupabaseClient,
): Promise<ComposedSection[]> {
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('bedroom_room_template_id, bathroom_room_template_id')
    .eq('id', orgId)
    .single()
  if (orgErr) console.error('[composeFromRoomTemplates] organizations fetch failed:', orgErr)

  const { data: roomTemplates, error: roomsErr } = await supabase
    .from('room_templates')
    .select('id, name, auto_include')
    .eq('org_id', orgId)
  if (roomsErr) console.error('[composeFromRoomTemplates] room_templates fetch failed:', roomsErr)

  const templateIds = new Set(
    [
      ...(roomTemplates ?? []).filter((r) => r.auto_include).map((r) => r.id as string),
      org?.bedroom_room_template_id,
      org?.bathroom_room_template_id,
    ].filter((id): id is string => !!id)
  )
  if (templateIds.size === 0) return []

  const { data: items, error: itemsErr } = await supabase
    .from('room_template_items')
    .select('room_template_id, task, requires_photo, notes, sort_order')
    .in('room_template_id', [...templateIds])
    .order('sort_order')
  if (itemsErr) console.error('[composeFromRoomTemplates] room_template_items fetch failed:', itemsErr)

  const itemsByTemplate = new Map<string, RoomTemplateItem[]>()
  for (const item of (items ?? []) as RoomTemplateItem[]) {
    const list = itemsByTemplate.get(item.room_template_id) ?? []
    list.push(item)
    itemsByTemplate.set(item.room_template_id, list)
  }

  const rooms: RoomTemplateRow[] = (roomTemplates ?? []) as RoomTemplateRow[]
  const sections: ComposedSection[] = []

  for (const room of rooms.filter((r) => r.auto_include)) {
    sections.push({ name: room.name, roomTemplateId: room.id, items: toComposedItems(room.id, itemsByTemplate) })
  }

  // Same numbering convention as the manual "Insert Rooms from Library"
  // picker in checklist-builder.tsx's applyRoomQuantities.
  addCountedSections(sections, rooms, itemsByTemplate, org?.bedroom_room_template_id, bedrooms)
  addCountedSections(sections, rooms, itemsByTemplate, org?.bathroom_room_template_id, bathrooms ?? 0)

  return sections
}

export async function applyMasterChecklistToProperty(
  propertyId: string,
  orgId:      string,
  supabase:   SupabaseClient,
  { force = false, actorId }: { force?: boolean; actorId?: string } = {},
): Promise<void> {
  await seedDefaultRoomTemplatesIfNeeded(orgId)

  const { data: property } = await supabase
    .from('properties')
    .select('bedrooms, bathrooms')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .single()

  const composed = property
    ? await composeFromRoomTemplates(orgId, property.bedrooms, property.bathrooms, supabase)
    : []

  if (composed.length === 0) {
    // Defensive backstop only — see the doc comment above
    // composeFromRoomTemplates. No flat-catalog fallback anymore; a later
    // apply call retries the seed and succeeds once whatever failed clears.
    console.error(
      `[applyMasterChecklistToProperty] no composed sections for property ${propertyId}, org ${orgId} — seed may have failed`
    )
    return
  }

  // Check whether this property already has a default template
  const { data: existingTemplate } = await supabase
    .from('checklist_templates')
    .select('id')
    .eq('property_id', propertyId)
    .eq('is_default', true)
    .maybeSingle()

  if (existingTemplate && !force) {
    // Respect the existing (possibly PM-customised) template, but the
    // property still has a real checklist in place either way.
    await markChecklistStepComplete(propertyId, supabase)
    return
  }

  let templateId: string

  if (existingTemplate) {
    templateId = existingTemplate.id as string

    // Delete-then-insert: remove existing sections (cascades to items via FK)
    const { data: existingSections } = await supabase
      .from('checklist_template_sections')
      .select('id')
      .eq('template_id', templateId)

    if (existingSections?.length) {
      const sectionIds = existingSections.map((s) => s.id as string)
      await supabase.from('checklist_template_items').delete().in('section_id', sectionIds)
      await supabase.from('checklist_template_sections').delete().eq('template_id', templateId)
    }
  } else {
    const { data: newTemplate } = await supabase
      .from('checklist_templates')
      .insert({ org_id: orgId, property_id: propertyId, name: 'Standard Turnover', is_default: true })
      .select('id')
      .single()

    if (!newTemplate) return
    templateId = newTemplate.id as string
  }

  // Insert sections and items directly from `composed` — one section per
  // entry, in order. No name-based grouping/deduplication here — two
  // "Bedroom 1" sections from two different templates must stay distinct,
  // never merged just because they share a label.
  for (let i = 0; i < composed.length; i++) {
    const section = composed[i]

    const { data: sectionRow, error: sectionErr } = await supabase
      .from('checklist_template_sections')
      .insert({
        template_id:       templateId,
        name:              section.name,
        room_template_id:  section.roomTemplateId,
        sort_order:        i,
      })
      .select('id')
      .single()

    if (sectionErr || !sectionRow) {
      throw new Error(
        `Failed to insert checklist section "${section.name}" for property ${propertyId}: ` +
        (sectionErr?.message ?? 'no row returned')
      )
    }

    await supabase.from('checklist_template_items').insert(
      section.items.map((item) => ({
        section_id:     sectionRow.id,
        template_id:    templateId,
        task:           item.task,
        requires_photo: item.requires_photo,
        notes:          item.notes,
        sort_order:     item.sort_order,
      }))
    )
  }

  await markChecklistStepComplete(propertyId, supabase)

  if (actorId) {
    await logAuditEvent({
      orgId, actorId,
      action:     'checklist.master_applied',
      targetType: 'property',
      targetId:   propertyId,
      metadata:   { template_id: templateId, section_count: composed.length },
    }).catch((err: unknown) => {
      console.error('[applyMasterChecklistToProperty] audit log failed:', err)
    })
  }
}
