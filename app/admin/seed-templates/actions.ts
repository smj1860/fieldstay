'use server'

import { revalidatePath } from 'next/cache'
import { requirePlatformAdmin } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

export interface SeedTemplateItemInput {
  task:           string
  requires_photo: boolean
  notes:          string
  sort_order:     number
}

export async function createSeedTemplate(
  name: string
): Promise<{ id?: string; error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const trimmed = name.trim()
    if (!trimmed) return { error: 'Template name is required.' }

    const { data: maxRow } = await supabase
      .from('platform_seed_room_templates')
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data, error } = await supabase
      .from('platform_seed_room_templates')
      .insert({ name: trimmed, sort_order: (maxRow?.sort_order ?? -1) + 1 })
      .select('id')
      .single()

    if (error || !data) {
      console.error('[createSeedTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.seed_template.created',
      targetType: 'platform_seed_room_template',
      targetId:   data.id,
      metadata:   { name: trimmed },
    })

    revalidatePath('/admin/seed-templates')
    return { id: data.id }
  } catch (err) {
    console.error('[createSeedTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function renameSeedTemplate(
  templateId: string,
  name:       string
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const trimmed = name.trim()
    if (!trimmed) return { error: 'Template name is required.' }

    const { data, error } = await supabase
      .from('platform_seed_room_templates')
      .update({ name: trimmed, updated_at: new Date().toISOString() })
      .eq('id', templateId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[renameSeedTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Template not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.seed_template.updated',
      targetType: 'platform_seed_room_template',
      targetId:   templateId,
      metadata:   { name: trimmed },
    })

    revalidatePath('/admin/seed-templates')
    return {}
  } catch (err) {
    console.error('[renameSeedTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function setSeedTemplateAutoInclude(
  templateId:  string,
  autoInclude: boolean
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('platform_seed_room_templates')
      .update({ auto_include: autoInclude, updated_at: new Date().toISOString() })
      .eq('id', templateId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[setSeedTemplateAutoInclude]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Template not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.seed_template.updated',
      targetType: 'platform_seed_room_template',
      targetId:   templateId,
      metadata:   { auto_include: autoInclude },
    })

    revalidatePath('/admin/seed-templates')
    return {}
  } catch (err) {
    console.error('[setSeedTemplateAutoInclude]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteSeedTemplate(
  templateId: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data, error } = await supabase
      .from('platform_seed_room_templates')
      .delete()
      .eq('id', templateId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deleteSeedTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }
    if (!data) return { error: 'Template not found.' }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.seed_template.deleted',
      targetType: 'platform_seed_room_template',
      targetId:   templateId,
    })

    revalidatePath('/admin/seed-templates')
    return {}
  } catch (err) {
    console.error('[deleteSeedTemplate]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// Full replace of one template's items — mirrors saveRoomTemplateItems in
// templates/checklist/actions.ts. Safe because nothing outside this
// table references a platform_seed_room_template_item's id.
export async function saveSeedTemplateItems(
  templateId: string,
  items:      SeedTemplateItemInput[]
): Promise<{ error?: string; saved: number }> {
  try {
    const { user, supabase } = await requirePlatformAdmin()

    const { data: template } = await supabase
      .from('platform_seed_room_templates')
      .select('id')
      .eq('id', templateId)
      .maybeSingle()
    if (!template) return { error: 'Template not found.', saved: 0 }

    const { error: deleteError } = await supabase
      .from('platform_seed_room_template_items')
      .delete()
      .eq('platform_seed_room_template_id', templateId)

    if (deleteError) {
      console.error('[saveSeedTemplateItems] delete failed', deleteError)
      return { error: 'Operation failed. Please try again.', saved: 0 }
    }

    if (items.length > 0) {
      const { error: insertError } = await supabase.from('platform_seed_room_template_items').insert(
        items.map((item) => ({
          platform_seed_room_template_id: templateId,
          task:                            item.task,
          requires_photo:                  item.requires_photo,
          notes:                           item.notes || null,
          sort_order:                      item.sort_order,
        }))
      )
      if (insertError) {
        console.error('[saveSeedTemplateItems] insert failed', insertError)
        return { error: 'Failed to save tasks. Please try again.', saved: 0 }
      }
    }

    await logAuditEvent({
      actorId:    user.id,
      action:     'platform_admin.seed_template.updated',
      targetType: 'platform_seed_room_template',
      targetId:   templateId,
      metadata:   { saved: items.length },
    })

    revalidatePath('/admin/seed-templates')
    return { saved: items.length }
  } catch (err) {
    console.error('[saveSeedTemplateItems]', err)
    return { error: 'Operation failed. Please try again.', saved: 0 }
  }
}
