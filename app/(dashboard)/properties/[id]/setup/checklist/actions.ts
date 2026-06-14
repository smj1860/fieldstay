'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'

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
    if (error) {
      console.error('[saveChecklistTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }
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
  const { user, membership } = await requireOrgMember()

  if (!targetPropertyIds.length) return { broadcast: 0 }

  await inngest.send({
    name: 'checklist/template-broadcast',
    data: {
      org_id:              membership.org_id,
      source_property_id:  sourcePropertyId,
      target_property_ids: targetPropertyIds,
      triggered_by:        user.id,
    },
  })

  revalidatePath('/properties')
  return { broadcast: targetPropertyIds.length }
}

export async function cloneChecklistFromProperty(
  sourcePropertyId: string,
  targetPropertyId: string,
): Promise<{ broadcast: number; error?: string }> {
  const { user, membership } = await requireOrgMember()

  const result = await broadcastChecklistTemplate(sourcePropertyId, [targetPropertyId])
  if (result.error) return result

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.checklist.cloned',
    targetType: 'property',
    targetId:   targetPropertyId,
    metadata:   { sourcePropertyId },
  })

  return result
}
