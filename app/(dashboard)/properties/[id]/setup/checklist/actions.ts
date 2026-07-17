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
  room_template_id?: string | null
  items: ChecklistItemInput[]
}

export async function saveChecklistTemplate(
  propertyId: string,
  templateId: string | null,
  sections: ChecklistSectionInput[]
): Promise<ChecklistState> {
  const { user, supabase, membership } = await requireOrgMember()

  let tmplId = templateId

  // A client-supplied templateId must be confirmed to belong to this org
  // before we delete/replace its sections — the id alone is not proof of
  // ownership.
  if (tmplId) {
    const { data: template } = await supabase
      .from('checklist_templates')
      .select('id')
      .eq('id', tmplId)
      .eq('org_id', membership.org_id)
      .maybeSingle()
    if (!template) return { error: 'Checklist template not found' }
  }

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

  // Any client-supplied room_template_id must be confirmed to belong to
  // this org before we link a section to it — same reasoning as the
  // templateId check above.
  const roomTemplateIds = [...new Set(
    sections.map((s) => s.room_template_id).filter((id): id is string => !!id)
  )]
  if (roomTemplateIds.length > 0) {
    const { data: ownedRooms } = await supabase
      .from('room_templates')
      .select('id')
      .eq('org_id', membership.org_id)
      .in('id', roomTemplateIds)
    if ((ownedRooms?.length ?? 0) !== roomTemplateIds.length) {
      return { error: 'One or more linked room templates were not found.' }
    }
  }

  // Delete all existing sections + items (full replace)
  await supabase
    .from('checklist_template_sections')
    .delete()
    .eq('template_id', tmplId)

  // Re-insert sections and items — batched into two round-trips (all
  // sections, then all items) instead of one insert pair per section.
  if (sections.length > 0) {
    const { data: sectionRows, error: se } = await supabase
      .from('checklist_template_sections')
      .insert(
        sections.map((section) => ({
          template_id:      tmplId,
          name:             section.name,
          sort_order:       section.sort_order,
          room_template_id: section.room_template_id ?? null,
          room_synced_at:   section.room_template_id ? new Date().toISOString() : null,
        }))
      )
      .select('id')

    if (se || !sectionRows || sectionRows.length !== sections.length) {
      console.error('[saveChecklistTemplate] section insert failed', se)
      return { error: 'Failed to save checklist section. Please try again.' }
    }

    const allItems = sections.flatMap((section, i) =>
      section.items.map((item) => ({
        section_id:     sectionRows[i]!.id,
        template_id:    tmplId!,
        task:           item.task,
        requires_photo: item.requires_photo,
        notes:          item.notes || null,
        sort_order:     item.sort_order,
      }))
    )

    if (allItems.length > 0) {
      const { error: ie } = await supabase.from('checklist_template_items').insert(allItems)
      if (ie) {
        console.error('[saveChecklistTemplate] items insert failed', ie)
        return { error: 'Failed to save checklist items. Please try again.' }
      }
    }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.checklist_template.updated',
    targetType: 'checklist_template',
    targetId:   tmplId ?? undefined,
    metadata:   { property_id: propertyId, sections: sections.length },
  })

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

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'property.checklist_template.updated',
    targetType: 'property',
    targetId:   sourcePropertyId,
    metadata:   { broadcast_to: targetPropertyIds },
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
