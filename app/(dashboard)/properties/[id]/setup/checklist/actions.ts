'use server'

import type { SupabaseClient } from '@supabase/supabase-js'
import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
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

// A client-supplied templateId must be confirmed to belong to this org
// before we delete/replace its sections — the id alone is not proof of
// ownership. Creates the template if none was passed in.
async function resolveTemplateId(
  supabase: SupabaseClient,
  propertyId: string,
  orgId: string,
  templateId: string | null
): Promise<{ id?: string; error?: string }> {
  if (templateId) {
    const { data: template } = await supabase
      .from('checklist_templates')
      .select('id')
      .eq('id', templateId)
      .eq('org_id', orgId)
      .maybeSingle()
    if (!template) return { error: 'Checklist template not found' }
    return { id: templateId }
  }

  // A client-supplied propertyId must also be confirmed to belong to this
  // org before we create a new template tied to it — same reasoning as the
  // templateId check above.
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (!property) return { error: 'Property not found' }

  const { data, error } = await supabase
    .from('checklist_templates')
    .insert({
      org_id:      orgId,
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
  return { id: data.id }
}

// Any client-supplied room_template_id must be confirmed to belong to this
// org before we link a section to it — same reasoning as resolveTemplateId.
async function validateRoomTemplateIds(
  supabase: SupabaseClient,
  orgId: string,
  sections: ChecklistSectionInput[]
): Promise<string | null> {
  const roomTemplateIds = [...new Set(
    sections.map((s) => s.room_template_id).filter((id): id is string => !!id)
  )]
  if (roomTemplateIds.length === 0) return null

  const { data: ownedRooms } = await supabase
    .from('room_templates')
    .select('id')
    .eq('org_id', orgId)
    .in('id', roomTemplateIds)
  if ((ownedRooms?.length ?? 0) !== roomTemplateIds.length) {
    return 'One or more linked room templates were not found.'
  }
  return null
}

function buildItemRows(tmplId: string, sectionId: string, section: ChecklistSectionInput) {
  return section.items.map((item) => ({
    section_id:     sectionId,
    template_id:    tmplId,
    task:           item.task,
    requires_photo: item.requires_photo,
    notes:          item.notes || null,
    sort_order:     item.sort_order,
  }))
}

// Full replace of a template's sections + items — batched into two
// round-trips (all sections, then all items) instead of one insert pair
// per section.
async function replaceSections(
  supabase: SupabaseClient,
  tmplId: string,
  sections: ChecklistSectionInput[]
): Promise<string | null> {
  await supabase
    .from('checklist_template_sections')
    .delete()
    .eq('template_id', tmplId)

  if (sections.length === 0) return null

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
    return 'Failed to save checklist section. Please try again.'
  }

  const allItems = sections.flatMap((section, i) => buildItemRows(tmplId, sectionRows[i]!.id, section))
  if (allItems.length === 0) return null

  const { error: ie } = await supabase.from('checklist_template_items').insert(allItems)
  if (ie) {
    console.error('[saveChecklistTemplate] items insert failed', ie)
    return 'Failed to save checklist items. Please try again.'
  }
  return null
}

export async function saveChecklistTemplate(
  propertyId: string,
  templateId: string | null,
  sections: ChecklistSectionInput[]
): Promise<ChecklistState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const resolved = await resolveTemplateId(supabase, propertyId, membership.org_id, templateId)
    if (resolved.error || !resolved.id) return { error: resolved.error ?? 'Operation failed. Please try again.' }
    const tmplId = resolved.id

    const roomError = await validateRoomTemplateIds(supabase, membership.org_id, sections)
    if (roomError) return { error: roomError }

    const sectionsError = await replaceSections(supabase, tmplId, sections)
    if (sectionsError) return { error: sectionsError }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.checklist_template.updated',
      targetType: 'checklist_template',
      targetId:   tmplId,
      metadata:   { property_id: propertyId, sections: sections.length },
    })

    revalidatePath(`/properties/${propertyId}/setup/checklist`)
    return { success: true }
  } catch (err) {
    console.error('[saveChecklistTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function completeChecklistStep(propertyId: string): Promise<void> {
  try {
    await markStepComplete(propertyId, 'checklist')
    redirect(`/properties/${propertyId}/setup/maintenance`)
  } catch (err) {
    unstable_rethrow(err)
    console.error('[completeChecklistStep]', err)
    throw err
  }
}

export async function broadcastChecklistTemplate(
  sourcePropertyId: string,
  targetPropertyIds: string[]
): Promise<{ broadcast: number; error?: string }> {
  try {
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
  } catch (err) {
    console.error('[broadcastChecklistTemplate]', err)
    return { broadcast: 0, error: 'Operation failed. Please try again.' }
  }
}

export async function cloneChecklistFromProperty(
  sourcePropertyId: string,
  targetPropertyId: string,
): Promise<{ broadcast: number; error?: string }> {
  try {
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
  } catch (err) {
    console.error('[cloneChecklistFromProperty]', err)
    return { broadcast: 0, error: 'Operation failed. Please try again.' }
  }
}
