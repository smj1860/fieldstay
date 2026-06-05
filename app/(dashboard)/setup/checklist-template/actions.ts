'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'

export interface ChecklistItemInput {
  section:    string
  task:       string
  sort_order: number
  source:     'catalog' | 'custom' | 'upload'
}

export async function saveMasterChecklistItems(
  items: ChecklistItemInput[]
): Promise<{ error?: string; saved: number }> {
  const { supabase, membership } = await requireOrgMember()

  // Full replace — delete existing, re-insert
  await supabase
    .from('org_master_checklist_items')
    .delete()
    .eq('org_id', membership.org_id)

  if (items.length === 0) return { saved: 0 }

  const { error } = await supabase
    .from('org_master_checklist_items')
    .insert(
      items.map((item) => ({
        org_id:     membership.org_id,
        section:    item.section,
        task:       item.task,
        sort_order: item.sort_order,
        source:     item.source,
      }))
    )

  if (error) return { error: error.message, saved: 0 }

  revalidatePath('/setup')
  revalidatePath('/inventory')
  return { saved: items.length }
}

export async function applyMasterChecklistToProperties(
  propertyIds: string[]
): Promise<{ error?: string; applied: number }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: masterItems } = await supabase
    .from('org_master_checklist_items')
    .select('*')
    .eq('org_id', membership.org_id)
    .order('section')
    .order('sort_order')

  if (!masterItems?.length) return { error: 'No master checklist items', applied: 0 }

  let applied = 0

  for (const propertyId of propertyIds) {
    let { data: template } = await supabase
      .from('checklist_templates')
      .select('id')
      .eq('property_id', propertyId)
      .eq('is_default', true)
      .single()

    if (!template) {
      const { data: newTemplate } = await supabase
        .from('checklist_templates')
        .insert({
          org_id:      membership.org_id,
          property_id: propertyId,
          name:        'Standard Turnover',
          is_default:  true,
        })
        .select('id')
        .single()
      template = newTemplate
    }

    if (!template) continue

    const sections = [...new Set(masterItems.map((i) => i.section))]

    for (const sectionName of sections) {
      const sectionItems = masterItems.filter((i) => i.section === sectionName)

      const { data: sectionRow } = await supabase
        .from('checklist_template_sections')
        .insert({
          template_id: template.id,
          name:        sectionName,
          sort_order:  sections.indexOf(sectionName),
        })
        .select('id')
        .single()

      if (!sectionRow) continue

      await supabase.from('checklist_template_items').insert(
        sectionItems.map((item) => ({
          section_id:     sectionRow.id,
          template_id:    template!.id,
          task:           item.task,
          requires_photo: false,
          notes:          null,
          sort_order:     item.sort_order,
        }))
      )

      applied += sectionItems.length
    }
  }

  revalidatePath('/inventory')
  return { applied }
}
