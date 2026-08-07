'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

import { reportError } from '@/lib/observability/report-error'
import { throwIfAnyQueryFailed, unwrap } from '@/lib/supabase/unwrap'
function revalidateRoomTemplateSurfaces() {
  revalidatePath('/templates/checklist')
}

const MANAGE_ROLES = ['admin', 'manager', 'owner'] as const

function assertCanManage(role: string): string | null {
  if (!(MANAGE_ROLES as readonly string[]).includes(role)) {
    return 'Only admins, managers, and owners can manage room templates.'
  }
  return null
}

// A type alias, not an interface: these values are stored in a jsonb
// column, and only a type alias gets the implicit index signature that makes
// it assignable to Json. An interface never satisfies Json, however plain
// its fields.
export type RoomTemplateItemInput = {
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
    reportError(err, { site: 'serverAction.templates.checklist.createRoomTemplate' })
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
    reportError(err, { site: 'serverAction.templates.checklist.renameRoomTemplate' })
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
    reportError(err, { site: 'serverAction.templates.checklist.setRoomTemplateAutoInclude' })
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
    reportError(err, { site: 'serverAction.templates.checklist.deleteRoomTemplate' })
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

    const roomRes = await supabase
      .from('room_templates')
      .select('id')
      .eq('id', roomTemplateId)
      .eq('org_id', membership.org_id)
      .maybeSingle()
    const room = unwrap(roomRes, {
      site:  'serverAction.templates.checklist.saveRoomTemplateItems',
      orgId: membership.org_id,
    })
    if (!room) return { error: 'Room template not found.', saved: 0 }

    // Atomic delete+insert via RPC — a plain client-side delete() then
    // insert() left the template with zero items if the insert failed
    // after the delete had already succeeded. See
    // 20260722000000_atomic_template_item_replace.sql.
    const { error: replaceError } = await supabase.rpc('replace_room_template_items', {
      p_room_template_id: roomTemplateId,
      p_items:             items,
    })
    if (replaceError) {
      console.error('[saveRoomTemplateItems] replace failed', replaceError)
      return { error: 'Failed to save tasks. Please try again.', saved: 0 }
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
    reportError(err, { site: 'serverAction.templates.checklist.saveRoomTemplateItems' })
    return { error: 'Operation failed. Please try again.', saved: 0 }
  }
}

// MEDIUM-7: this used to run ~20 sequential Supabase calls per property
// in-request (delete-then-insert of sections/items + audit log), which for
// 20+ properties risks hitting the Server Action's execution time limit.
// Now it just validates and fires an Inngest event — the actual work happens
// in lib/inngest/functions/apply-master-checklist.ts, fanned out in batches.
export async function applyMasterChecklistToProperties(
  propertyIds: string[]
): Promise<{ error?: string; queued: number }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const [{ data: org, error: orgError }, { data: anyRoomTemplate, error: roomTemplateError }] = await Promise.all([
      supabase
        .from('organizations')
        .select('bedroom_room_template_id, bathroom_room_template_id')
        .eq('id', membership.org_id)
        .single(),
      supabase
        .from('room_templates')
        .select('id')
        .eq('org_id', membership.org_id)
        .limit(1),
    ])
    throwIfAnyQueryFailed(
      { site: 'serverAction.templates.checklist.applyMasterChecklistToProperties', orgId: membership.org_id },
      orgError,
      roomTemplateError,
    )

    const hasRoomTemplateConfig =
      !!org?.bedroom_room_template_id || !!org?.bathroom_room_template_id || !!anyRoomTemplate?.length

    if (!hasRoomTemplateConfig) {
      return { error: 'No room templates found. Build your room library first.', queued: 0 }
    }

    await inngest.send({
      name: 'checklist/master-template.apply.requested',
      data: {
        org_id:       membership.org_id,
        property_ids: propertyIds,
        triggered_by: user.id,
      },
    })

    revalidatePath('/inventory')
    return { queued: propertyIds.length }
  } catch (err) {
    console.error('[applyMasterChecklistToProperties]', err)
    reportError(err, { site: 'serverAction.templates.checklist.applyMasterChecklistToProperties' })
    return { error: 'Operation failed. Please try again.', queued: 0 }
  }
}
