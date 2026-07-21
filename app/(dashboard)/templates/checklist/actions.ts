'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

// Room templates now render on two call sites — the standalone hub page
// and the onboarding wizard step — so every mutation revalidates both.
function revalidateRoomTemplateSurfaces() {
  revalidatePath('/templates/checklist')
  revalidatePath('/setup/checklist-template')
}

const MANAGE_ROLES = ['admin', 'manager', 'owner'] as const

function assertCanManage(role: string): string | null {
  if (!(MANAGE_ROLES as readonly string[]).includes(role)) {
    return 'Only admins, managers, and owners can manage room templates.'
  }
  return null
}

export interface RoomTemplateItemInput {
  task: string
  requires_photo: boolean
  notes: string
  sort_order: number
}

export async function createRoomTemplate(
  name: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const roleError = assertCanManage(membership.role)
    if (roleError) return { error: roleError }

    const trimmed = name.trim()
    if (!trimmed) return { error: 'Room name is required.' }

    const { data, error } = await supabase
      .from('room_templates')
      .insert({ org_id: membership.org_id, name: trimmed })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[createRoomTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'room_template.created',
      targetType: 'room_template',
      targetId:   data.id,
      metadata:   { name: trimmed },
    })

    revalidateRoomTemplateSurfaces()
    return { id: data.id }
  } catch (err) {
    console.error('[createRoomTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function renameRoomTemplate(
  roomTemplateId: string,
  name: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const roleError = assertCanManage(membership.role)
    if (roleError) return { error: roleError }

    const trimmed = name.trim()
    if (!trimmed) return { error: 'Room name is required.' }

    // A client-supplied id must be confirmed to belong to this org before we
    // touch it — the id alone is not proof of ownership.
    const { data, error } = await supabase
      .from('room_templates')
      .update({ name: trimmed, updated_at: new Date().toISOString() })
      .eq('id', roomTemplateId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[renameRoomTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Room template not found.' }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'room_template.renamed',
      targetType: 'room_template',
      targetId:   roomTemplateId,
      metadata:   { name: trimmed },
    })

    revalidateRoomTemplateSurfaces()
    return {}
  } catch (err) {
    console.error('[renameRoomTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function setRoomTemplateAutoInclude(
  roomTemplateId: string,
  autoInclude: boolean
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const roleError = assertCanManage(membership.role)
    if (roleError) return { error: roleError }

    const { data, error } = await supabase
      .from('room_templates')
      .update({ auto_include: autoInclude, updated_at: new Date().toISOString() })
      .eq('id', roomTemplateId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[setRoomTemplateAutoInclude]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Room template not found.' }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'room_template.auto_include_changed',
      targetType: 'room_template',
      targetId:   roomTemplateId,
      metadata:   { auto_include: autoInclude },
    })

    revalidateRoomTemplateSurfaces()
    revalidatePath('/properties')
    return {}
  } catch (err) {
    console.error('[setRoomTemplateAutoInclude]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteRoomTemplate(
  roomTemplateId: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const roleError = assertCanManage(membership.role)
    if (roleError) return { error: roleError }

    // Deleting cascades room_template_items and SETs NULL any
    // checklist_template_sections.room_template_id currently linked to it —
    // those sections become normal independent sections, their items untouched.
    const { data, error } = await supabase
      .from('room_templates')
      .delete()
      .eq('id', roomTemplateId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deleteRoomTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Room template not found.' }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'room_template.deleted',
      targetType: 'room_template',
      targetId:   roomTemplateId,
    })

    revalidateRoomTemplateSurfaces()
    return {}
  } catch (err) {
    console.error('[deleteRoomTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// Full replace of one room's items — safe because nothing outside this
// table references a room_template_item's id (unlike room_templates.id,
// which checklist_template_sections.room_template_id points at).
export async function saveRoomTemplateItems(
  roomTemplateId: string,
  items: RoomTemplateItemInput[]
): Promise<{ error?: string; saved: number }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const roleError = assertCanManage(membership.role)
    if (roleError) return { error: roleError, saved: 0 }

    const { data: room } = await supabase
      .from('room_templates')
      .select('id')
      .eq('id', roomTemplateId)
      .eq('org_id', membership.org_id)
      .maybeSingle()
    if (!room) return { error: 'Room template not found.', saved: 0 }

    const { error: deleteError } = await supabase
      .from('room_template_items')
      .delete()
      .eq('room_template_id', roomTemplateId)

    if (deleteError) {
      console.error('[saveRoomTemplateItems] delete failed', deleteError)
      return { error: 'Operation failed. Please try again.', saved: 0 }
    }

    if (items.length > 0) {
      const { error: insertError } = await supabase.from('room_template_items').insert(
        items.map((item) => ({
          room_template_id: roomTemplateId,
          task:             item.task,
          requires_photo:   item.requires_photo,
          notes:            item.notes || null,
          sort_order:       item.sort_order,
        }))
      )
      if (insertError) {
        console.error('[saveRoomTemplateItems] insert failed', insertError)
        return { error: 'Failed to save tasks. Please try again.', saved: 0 }
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'room_template.items_updated',
      targetType: 'room_template',
      targetId:   roomTemplateId,
      metadata:   { saved: items.length },
    })

    revalidateRoomTemplateSurfaces()
    revalidatePath('/properties')
    return { saved: items.length }
  } catch (err) {
    console.error('[saveRoomTemplateItems]', err)
    return { error: 'Operation failed. Please try again.', saved: 0 }
  }
}
