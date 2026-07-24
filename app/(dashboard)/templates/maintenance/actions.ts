'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type { ScheduleFrequency, VendorSpecialty } from '@/types/database'

// Item-level CRUD for maintenance_schedule_template_items — didn't exist
// before this pass (createMaintenanceScheduleTemplate only inserts items at
// creation time, broadcastMaintenanceTemplate only reads them). RLS already
// supports this (org-owned, non-system templates only, admin/manager) per
// 20260618000002_baseline_schema_snapshot.sql — these functions are the app
// layer on top of policies that were already there.

interface TemplateItemInput {
  name:                  string
  description:           string | null
  schedule_frequency:    ScheduleFrequency
  vendor_specialty_hint: VendorSpecialty | null
  estimated_cost:        number | null
}

interface TemplateItemRow extends TemplateItemInput {
  id:                string
  is_optional_flag:  string | null
  sort_order:        number
}

export async function addMaintenanceTemplateItem(
  templateId: string,
  item: TemplateItemInput
): Promise<{ item?: TemplateItemRow; error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const trimmedName = item.name.trim()
    if (!trimmedName) return { error: 'Item name is required.' }

    const { data: template } = await supabase
      .from('maintenance_schedule_templates')
      .select('id, is_system')
      .eq('id', templateId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (!template)          return { error: 'Template not found.' }
    if (template.is_system) return { error: 'System templates cannot be edited.' }

    const { data, error } = await supabase
      .from('maintenance_schedule_template_items')
      .insert({
        template_id:           templateId,
        name:                  trimmedName,
        description:           item.description,
        schedule_frequency:    item.schedule_frequency,
        vendor_specialty_hint: item.vendor_specialty_hint,
        estimated_cost:        item.estimated_cost,
      })
      .select('id, name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, is_optional_flag, sort_order')
      .single()

    if (error || !data) {
      console.error('[addMaintenanceTemplateItem]', error)
      reportError(error, { site: 'serverAction.templatesMaintenance.addMaintenanceTemplateItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance_template.item_created',
      targetType: 'maintenance_schedule_template',
      targetId:   templateId,
      metadata:   { item_id: data.id, name: trimmedName },
    })

    revalidatePath('/templates/maintenance/saved')
    return { item: data }
  } catch (err) {
    console.error('[addMaintenanceTemplateItem]', err)
    reportError(err, { site: 'serverAction.templatesMaintenance.addMaintenanceTemplateItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function updateMaintenanceTemplateItem(
  itemId: string,
  updates: Partial<TemplateItemInput>
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: item } = await supabase
      .from('maintenance_schedule_template_items')
      .select('id, template_id, maintenance_schedule_templates!inner(org_id, is_system)')
      .eq('id', itemId)
      .eq('maintenance_schedule_templates.org_id', membership.org_id)
      .maybeSingle()

    if (!item) return { error: 'Item not found.' }
    const template = unwrapJoin(item.maintenance_schedule_templates)
    if (template?.is_system) return { error: 'System templates cannot be edited.' }

    const patch: Record<string, unknown> = {}
    if (updates.name !== undefined) {
      const trimmed = updates.name.trim()
      if (!trimmed) return { error: 'Item name is required.' }
      patch.name = trimmed
    }
    if (updates.description !== undefined)           patch.description = updates.description
    if (updates.schedule_frequency !== undefined)     patch.schedule_frequency = updates.schedule_frequency
    if (updates.vendor_specialty_hint !== undefined)  patch.vendor_specialty_hint = updates.vendor_specialty_hint
    if (updates.estimated_cost !== undefined)         patch.estimated_cost = updates.estimated_cost
    if (Object.keys(patch).length === 0) return {}

    const { error } = await supabase
      .from('maintenance_schedule_template_items')
      .update(patch)
      .eq('id', itemId)

    if (error) {
      console.error('[updateMaintenanceTemplateItem]', error)
      reportError(error, { site: 'serverAction.templatesMaintenance.updateMaintenanceTemplateItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance_template.item_updated',
      targetType: 'maintenance_schedule_template',
      targetId:   item.template_id,
      metadata:   { item_id: itemId, ...patch },
    })

    revalidatePath('/templates/maintenance/saved')
    return {}
  } catch (err) {
    console.error('[updateMaintenanceTemplateItem]', err)
    reportError(err, { site: 'serverAction.templatesMaintenance.updateMaintenanceTemplateItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function removeMaintenanceTemplateItem(itemId: string): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: item } = await supabase
      .from('maintenance_schedule_template_items')
      .select('id, template_id, maintenance_schedule_templates!inner(org_id, is_system)')
      .eq('id', itemId)
      .eq('maintenance_schedule_templates.org_id', membership.org_id)
      .maybeSingle()

    if (!item) return { error: 'Item not found.' }
    const template = unwrapJoin(item.maintenance_schedule_templates)
    if (template?.is_system) return { error: 'System templates cannot be edited.' }

    const { error } = await supabase
      .from('maintenance_schedule_template_items')
      .delete()
      .eq('id', itemId)

    if (error) {
      console.error('[removeMaintenanceTemplateItem]', error)
      reportError(error, { site: 'serverAction.templatesMaintenance.removeMaintenanceTemplateItem', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance_template.item_deleted',
      targetType: 'maintenance_schedule_template',
      targetId:   item.template_id,
      metadata:   { item_id: itemId },
    })

    revalidatePath('/templates/maintenance/saved')
    return {}
  } catch (err) {
    console.error('[removeMaintenanceTemplateItem]', err)
    reportError(err, { site: 'serverAction.templatesMaintenance.removeMaintenanceTemplateItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}
