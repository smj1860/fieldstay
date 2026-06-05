'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export type ChecklistState = { error?: string; success?: boolean }

export interface ChecklistItemInput {
  id?: string
  task: string
  requires_photo: boolean
  notes: string
  sort_order: number
}

export interface ChecklistSectionInput {
  id?: string
  name: string
  sort_order: number
  items: ChecklistItemInput[]
}

export async function saveChecklistTemplate(
  propertyId: string,
  templateId: string | null,
  sections: ChecklistSectionInput[]
): Promise<ChecklistState> {
  const { supabase, membership } = await requireOrgMember()

  let tmplId = templateId

  // Create template if none exists
  if (!tmplId) {
    const { data, error } = await supabase
      .from('checklist_templates')
      .insert({
        org_id:      membership.org_id,
        property_id: propertyId,
        name:        'Standard Turnover',
        is_default:  true,
      })
      .select('id')
      .single()
    if (error) return { error: error.message }
    tmplId = data.id
  }

  // Delete all existing sections + items (full replace)
  await supabase
    .from('checklist_template_sections')
    .delete()
    .eq('template_id', tmplId)

  // Re-insert sections and items
  for (const section of sections) {
    const { data: sectionRow, error: se } = await supabase
      .from('checklist_template_sections')
      .insert({ template_id: tmplId, name: section.name, sort_order: section.sort_order })
      .select('id')
      .single()

    if (se || !sectionRow) continue

    if (section.items.length > 0) {
      await supabase.from('checklist_template_items').insert(
        section.items.map((item) => ({
          section_id:     sectionRow.id,
          template_id:    tmplId!,
          task:           item.task,
          requires_photo: item.requires_photo,
          notes:          item.notes || null,
          sort_order:     item.sort_order,
        }))
      )
    }
  }

  revalidatePath(`/properties/${propertyId}/setup/checklist`)
  return { success: true }
}

export async function completeChecklistStep(propertyId: string): Promise<void> {
  await markStepComplete(propertyId, 'checklist')
  redirect(`/properties/${propertyId}/setup/maintenance`)
}

export async function broadcastChecklistTemplate(
  sourcePropertyId: string,
  targetPropertyIds: string[]
): Promise<{ broadcast: number; error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: sourceTemplate } = await supabase
    .from('checklist_templates')
    .select(`
      id, name,
      checklist_template_sections(
        name, sort_order, requires_section_photo,
        checklist_template_items(task, requires_photo, notes, sort_order)
      )
    `)
    .eq('property_id', sourcePropertyId)
    .eq('org_id', membership.org_id)
    .eq('is_default', true)
    .single()

  if (!sourceTemplate) return { broadcast: 0, error: 'Source template not found' }

  let broadcast = 0

  for (const targetId of targetPropertyIds) {
    // Upsert template for target property
    const { data: newTemplate } = await supabase
      .from('checklist_templates')
      .upsert({
        property_id: targetId,
        org_id:      membership.org_id,
        name:        sourceTemplate.name,
        is_default:  true,
      }, { onConflict: 'property_id,org_id' })
      .select('id')
      .single()

    if (!newTemplate) continue

    // Delete existing sections (full replace)
    await supabase
      .from('checklist_template_sections')
      .delete()
      .eq('template_id', newTemplate.id)

    // Re-insert sections and items
    for (const section of (sourceTemplate.checklist_template_sections ?? [])) {
      const { data: newSection } = await supabase
        .from('checklist_template_sections')
        .insert({
          template_id:            newTemplate.id,
          name:                   section.name,
          sort_order:             section.sort_order,
          requires_section_photo: section.requires_section_photo ?? false,
        })
        .select('id')
        .single()

      if (!newSection) continue

      for (const item of (section.checklist_template_items ?? [])) {
        await supabase.from('checklist_template_items').insert({
          section_id:     newSection.id,
          template_id:    newTemplate.id,
          task:           item.task,
          requires_photo: item.requires_photo,
          notes:          item.notes,
          sort_order:     item.sort_order,
        })
      }
    }
    broadcast++
  }

  revalidatePath('/properties')
  return { broadcast }
}
