'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'

export interface PlatformTemplateItemInput {
  catalog_item_id: string
  par_level:       number
  preferred_brand: string
  sort_order:      number
}

export async function createPlatformInventoryTemplate(
  name: string,
  description: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const trimmed = name.trim()
    if (!trimmed) return { error: 'Template name is required.' }

    const { data, error } = await supabase
      .from('platform_inventory_templates')
      .insert({ name: trimmed, description: description.trim() || null })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[createPlatformInventoryTemplate]', error)
      return { error: error?.code === '23505' ? 'A template with this name already exists.' : 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_template.created',
      targetType: 'platform_inventory_template',
      targetId:   data.id,
      metadata:   { name: trimmed },
    })

    revalidatePath('/admin/inventory-templates')
    return { id: data.id }
  } catch (err) {
    console.error('[createPlatformInventoryTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function renamePlatformInventoryTemplate(
  templateId: string,
  name: string,
  description: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const trimmed = name.trim()
    if (!trimmed) return { error: 'Template name is required.' }

    const { data, error } = await supabase
      .from('platform_inventory_templates')
      .update({ name: trimmed, description: description.trim() || null, updated_at: new Date().toISOString() })
      .eq('id', templateId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[renamePlatformInventoryTemplate]', error)
      return { error: error.code === '23505' ? 'A template with this name already exists.' : 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Template not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_template.updated',
      targetType: 'platform_inventory_template',
      targetId:   templateId,
      metadata:   { name: trimmed },
    })

    revalidatePath('/admin/inventory-templates')
    return {}
  } catch (err) {
    console.error('[renamePlatformInventoryTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deletePlatformInventoryTemplate(
  templateId: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('platform_inventory_templates')
      .delete()
      .eq('id', templateId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deletePlatformInventoryTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Template not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_template.deleted',
      targetType: 'platform_inventory_template',
      targetId:   templateId,
    })

    revalidatePath('/admin/inventory-templates')
    return {}
  } catch (err) {
    console.error('[deletePlatformInventoryTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// Full replace of one template's items, atomic via RPC — same reasoning as
// saveSeedTemplateItems (a plain delete-then-insert can leave the template
// with zero items if the insert fails after the delete succeeds).
export async function savePlatformInventoryTemplateItems(
  templateId: string,
  items: PlatformTemplateItemInput[]
): Promise<{ error?: string; saved: number }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data: template } = await supabase
      .from('platform_inventory_templates')
      .select('id')
      .eq('id', templateId)
      .maybeSingle()
    if (!template) return { error: 'Template not found.', saved: 0 }

    const { error: replaceError } = await supabase.rpc('replace_platform_inventory_template_items', {
      p_template_id: templateId,
      p_items: items.map((item) => ({
        catalog_item_id: item.catalog_item_id,
        par_level:       Number.isFinite(item.par_level) && item.par_level > 0 ? item.par_level : 1,
        preferred_brand: item.preferred_brand,
        sort_order:      item.sort_order,
      })),
    })
    if (replaceError) {
      console.error('[savePlatformInventoryTemplateItems] replace failed', replaceError)
      return { error: 'Failed to save items. Please try again.', saved: 0 }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_template.items_saved',
      targetType: 'platform_inventory_template',
      targetId:   templateId,
      metadata:   { saved: items.length },
    })

    revalidatePath('/admin/inventory-templates')
    return { saved: items.length }
  } catch (err) {
    console.error('[savePlatformInventoryTemplateItems]', err)
    return { error: 'Operation failed. Please try again.', saved: 0 }
  }
}

export type BroadcastTarget =
  | { mode: 'all' }
  | { mode: 'selected'; orgIds: string[] }

export async function broadcastPlatformInventoryTemplate(
  templateId: string,
  target: BroadcastTarget
): Promise<{ error?: string; dispatched?: boolean }> {
  try {
    const { user } = await requirePlatformAdmin()

    if (target.mode === 'selected' && !target.orgIds.length) {
      return { error: 'Select at least one account to broadcast to.' }
    }

    await inngest.send({
      name: 'platform_inventory_template/broadcast_requested',
      data: {
        platform_template_id: templateId,
        target_org_ids:        target.mode === 'all' ? null : target.orgIds,
        requested_by:          user.id,
      },
    })

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.inventory_template.broadcast_requested',
      targetType: 'platform_inventory_template',
      targetId:   templateId,
      metadata:   target.mode === 'all' ? { mode: 'all' } : { mode: 'selected', org_count: target.orgIds.length },
    })

    return { dispatched: true }
  } catch (err) {
    console.error('[broadcastPlatformInventoryTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// Cross-org account list for the broadcast target picker — organizations'
// own RLS (orgs_select, scoped to get_user_org_ids()) does not let a
// platform admin read orgs they're not a member of, so this genuinely
// needs the service-role bypass (the platformAdmin ServiceRoleContext
// variant exists for exactly this narrow cross-org-read case). Only
// id/name are read — no financial or PII columns.
export async function listOrgsForBroadcast(): Promise<{ orgs?: { id: string; name: string }[]; error?: string }> {
  try {
    const { user } = await requirePlatformAdmin()

    const supabase = createServiceClient({ platformAdmin: { id: user.id } })
    const { data, error } = await supabase
      .from('organizations')
      .select('id, name')
      .order('name')

    if (error) {
      console.error('[listOrgsForBroadcast]', error)
      return { error: 'Failed to load accounts.' }
    }

    return { orgs: data ?? [] }
  } catch (err) {
    console.error('[listOrgsForBroadcast]', err)
    return { error: 'Failed to load accounts.' }
  }
}
