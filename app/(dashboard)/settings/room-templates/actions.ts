'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'

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

  revalidatePath('/settings/room-templates')
  return { id: data.id }
}

export async function renameRoomTemplate(
  roomTemplateId: string,
  name: string
): Promise<{ error?: string }> {
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

  revalidatePath('/settings/room-templates')
  return {}
}

export async function setRoomTemplateAutoInclude(
  roomTemplateId: string,
  autoInclude: boolean
): Promise<{ error?: string }> {
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

  revalidatePath('/settings/room-templates')
  revalidatePath('/properties')
  return {}
}

export async function deleteRoomTemplate(
  roomTemplateId: string
): Promise<{ error?: string }> {
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

  revalidatePath('/settings/room-templates')
  return {}
}

/**
 * Sets which room templates drive the per-property bedroom/bathroom count.
 *
 * Uses the service-role client for the actual organizations write, not the
 * requireOrgMember()-scoped one used everywhere else in this file — the
 * organizations table's own "orgs_update" RLS policy is admin/owner only
 * (is_org_member(id, ['admin']), and 'owner' always passes regardless of
 * the array), narrower than assertCanManage's admin/manager/owner. A
 * manager passes the app-level role check here but would have the RLS
 * USING clause silently filter their UPDATE to 0 affected rows — no
 * Postgres error, just a no-op — leaving the mapping unset with nothing
 * telling them it didn't save. Every other action in this file writes to
 * room_templates, whose own RLS policy does allow manager, so this is the
 * only mutation in the file that needs this. The write stays safely scoped
 * because assertCanManage has already gated the caller and
 * membership.org_id (not a client-supplied value) is the only org this can
 * ever touch — the same reasoning CLAUDE.md allows for a Service Component
 * that validates first and scopes every query to the caller's own org.
 */
export async function setBedroomBathroomMapping(
  bedroomRoomTemplateId:  string | null,
  bathroomRoomTemplateId: string | null
): Promise<{ error?: string }> {
  const { user, supabase, membership } = await requireOrgMember()

  const roleError = assertCanManage(membership.role)
  if (roleError) return { error: roleError }

  const idsToVerify = [bedroomRoomTemplateId, bathroomRoomTemplateId].filter(
    (id): id is string => id !== null
  )
  if (idsToVerify.length > 0) {
    const { data: owned } = await supabase
      .from('room_templates')
      .select('id')
      .eq('org_id', membership.org_id)
      .in('id', idsToVerify)
    if ((owned?.length ?? 0) !== idsToVerify.length) {
      return { error: 'One or more room templates not found.' }
    }
  }

  const serviceSupabase = createServiceClient()
  const { error } = await serviceSupabase
    .from('organizations')
    .update({
      bedroom_room_template_id:  bedroomRoomTemplateId,
      bathroom_room_template_id: bathroomRoomTemplateId,
    })
    .eq('id', membership.org_id)

  if (error) {
    console.error('[setBedroomBathroomMapping]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'org.bedroom_bathroom_mapping_changed',
    targetType: 'organization',
    targetId:   membership.org_id,
    metadata:   { bedroom_room_template_id: bedroomRoomTemplateId, bathroom_room_template_id: bathroomRoomTemplateId },
  })

  revalidatePath('/settings/room-templates')
  revalidatePath('/setup/checklist-template')
  revalidatePath('/properties')
  return {}
}

// Full replace of one room's items — safe because nothing outside this
// table references a room_template_item's id (unlike room_templates.id,
// which checklist_template_sections.room_template_id points at).
export async function saveRoomTemplateItems(
  roomTemplateId: string,
  items: RoomTemplateItemInput[]
): Promise<{ error?: string; saved: number }> {
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

  revalidatePath('/settings/room-templates')
  revalidatePath('/properties')
  return { saved: items.length }
}
