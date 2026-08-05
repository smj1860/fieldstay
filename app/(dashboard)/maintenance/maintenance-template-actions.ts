'use server'

/**
 * Templates Hub — org-level maintenance schedule templates.
 *
 * Split out of ./actions.ts verbatim (no logic change) because it is the one
 * cleanly separable half of that 2,500-line file: a maintenance TEMPLATE is an
 * org-level library entry that gets broadcast into per-property
 * `maintenance_schedules` rows, and it never touches `work_orders` at all.
 * Everything left in actions.ts does — a schedule is what a work order is
 * generated FROM (createWorkOrderFromSchedule) and what a completion advances
 * (complete-work-order-helpers' next_due_date write), so those two cannot be
 * separated without splitting a real dependency.
 */

import { revalidatePath } from 'next/cache'
import { requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { fetchAllRows, SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError } from '@/lib/supabase/unwrap'
import type { ScheduleFrequency, ScheduleType, VendorSpecialty } from '@/types/database'
import type { MaintenanceActionState } from './actions'

// ── Create Maintenance Schedule Template ─────────────────────────────────────

export async function createMaintenanceScheduleTemplate(data: {
  name:        string
  description: string | null
  items: Array<{
    name:                  string
    description:           string | null
    schedule_frequency:    ScheduleFrequency
    vendor_specialty_hint: VendorSpecialty | null
    estimated_cost:        number | null
    sort_order:            number
  }>
}): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    if (!data.name.trim()) return { error: 'Template name is required' }
    if (!data.items.length) return { error: 'Add at least one item to the template' }

    const { data: template, error: tErr } = await supabase
      .from('maintenance_schedule_templates')
      .insert({
        org_id:      membership.org_id,
        name:        data.name.trim(),
        description: data.description || null,
        is_system:   false,
      })
      .select('id')
      .single()

    if (tErr || !template) {
      console.error('[createMaintenanceScheduleTemplate]', tErr)
      return { error: 'Operation failed. Please try again.' }
    }

    const itemRows = data.items.map((item, i) => ({
      template_id:           template.id,
      name:                  item.name.trim(),
      description:           item.description || null,
      schedule_frequency:    item.schedule_frequency,
      vendor_specialty_hint: item.vendor_specialty_hint || null,
      estimated_cost:        item.estimated_cost || null,
      sort_order:            i,
    }))

    const { error: iErr } = await supabase
      .from('maintenance_schedule_template_items')
      .insert(itemRows)

    if (iErr) {
      console.error('[createMaintenanceScheduleTemplate:items]', iErr)
      return { error: 'Operation failed. Please try again.' }
    }

    revalidatePath('/maintenance')
    revalidatePath('/templates/maintenance/create')
    revalidatePath('/templates/maintenance/saved')
    return { success: true, templateId: template.id }
  } catch (err) {
    console.error('[createMaintenanceScheduleTemplate]', err)
    reportError(err, { site: 'serverAction.maintenance.createMaintenanceScheduleTemplate' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Maintenance Schedule Template Broadcasting ───────────────────────────────

export type BroadcastResult = {
  error?: string
  success?: boolean
  created?: number
  skipped?: number
}

// Idempotent: skip if a maintenance_schedule with the same name
// already exists on the property
type BroadcastItem = {
  id: string; name: string; description: string | null
  schedule_frequency: ScheduleFrequency; vendor_specialty_hint: VendorSpecialty | null
  estimated_cost: number | null; sort_order: number
  asset_category: string | null
  active_from_month: number | null; active_to_month: number | null
}

type BroadcastInputs =
  | { ok: false; error: string }
  | {
      ok: true
      items:      BroadcastItem[]
      properties: { id: string }[]
      /** is_system drives is_from_standard_template on every inserted row. */
      template:   { id: string; org_id: string | null; is_system: boolean }
    }

/**
 * The three reads broadcastMaintenanceTemplate needs before it can fan a
 * template out across properties. Extracted to keep the action under the
 * cognitive-complexity ceiling once each read grew its own error branch.
 *
 * All three fail closed, and the property read especially: it IS the org
 * filter for the client-supplied propertyIds, and its result is what every
 * inserted row's property_id comes from. An empty result and a failed read
 * used to be the same "No matching properties found" — which, for the items
 * read, also meant a 25-item template reported itself as empty and invited the
 * PM to re-create it as a duplicate.
 */
async function loadBroadcastInputs(
  supabase:    Awaited<ReturnType<typeof requireOrgRole>>['supabase'],
  orgId:       string,
  templateId:  string,
  propertyIds: string[],
): Promise<BroadcastInputs> {
  const templateRes = await supabase
    .from('maintenance_schedule_templates')
    .select('id, org_id, is_system')
    .eq('id', templateId)
    .maybeSingle()

  if (reportQueryError(templateRes.error, { site: 'serverAction.maintenance.broadcastMaintenanceTemplate.template', orgId })) {
    return { ok: false, error: 'Could not load the template. Please try again.' }
  }
  const template = templateRes.data
  if (!template || (!template.is_system && template.org_id !== orgId)) {
    return { ok: false, error: 'Template not found' }
  }

  const itemsRes = await supabase
    .from('maintenance_schedule_template_items')
    .select('id, name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, sort_order, asset_category, active_from_month, active_to_month')
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true })
    .limit(SUPABASE_MAX_ROWS)

  if (reportQueryError(itemsRes.error, { site: 'serverAction.maintenance.broadcastMaintenanceTemplate.items', orgId })) {
    return { ok: false, error: "Could not load the template's items. Please try again." }
  }
  const items = (itemsRes.data ?? []) as BroadcastItem[]
  if (items.length === 0) return { ok: false, error: 'Template has no items' }

  // Paginated: this is the org filter for the client-supplied propertyIds AND
  // the loop source every inserted row's property_id comes from, so a
  // truncated page silently drops properties from the broadcast.
  let properties: { id: string }[]
  try {
    properties = await fetchAllRows<{ id: string }>(
      (from, to) => supabase
        .from('properties')
        .select('id')
        .eq('org_id', orgId)
        .in('id', propertyIds)
        .order('id')
        .range(from, to),
      { label: 'serverAction.maintenance.broadcastMaintenanceTemplate.props' },
    )
  } catch (err) {
    console.error('[broadcastMaintenanceTemplate] property verification failed', err)
    reportError(err, { site: 'serverAction.maintenance.broadcastMaintenanceTemplate.props', orgId })
    return { ok: false, error: 'Could not verify the selected properties. Please try again.' }
  }
  if (properties.length === 0) return { ok: false, error: 'No matching properties found' }

  return { ok: true, items, properties, template }
}

export async function broadcastMaintenanceTemplate(
  templateId:         string,
  propertyIds:        string[],
  nextDueDates:       Record<string, string>          = {},
  recurrenceOverrides: Record<string, ScheduleFrequency> = {},
): Promise<BroadcastResult> {
  try {
    const { supabase, user, membership } = await requireOrgRole(['admin', 'manager'])

    if (propertyIds.length === 0) return { error: 'Select at least one property' }

    const inputs = await loadBroadcastInputs(supabase, membership.org_id, templateId, propertyIds)
    if (!inputs.ok) return { error: inputs.error }
    const { items, properties, template } = inputs

    // PostgREST truncates an unbounded select at max_rows = 1000 with a 200 and
    // no truncation signal. This set IS the duplicate guard, and there is no
    // unique constraint on maintenance_schedules behind it (there deliberately
    // can't be: duplicateMaintenanceScheduleItem copies a row's name onto the
    // same property on purpose), so a truncated read here silently re-created
    // schedules that already existed — 50 properties × a 25-item template is
    // already past the cap.
    const existingSchedules = await fetchAllRows<{ property_id: string; name: string }>(
      (from, to) => supabase
        .from('maintenance_schedules')
        .select('property_id, name')
        .eq('org_id', membership.org_id)
        .in('property_id', (properties as { id: string }[]).map((p) => p.id))
        .order('id', { ascending: true })
        .range(from, to),
      { label: 'broadcastMaintenanceTemplate.existing_schedules' },
    )

    const existingNames = new Set(existingSchedules.map((s) => `${s.property_id}::${s.name}`))

    const fallbackDueDate = new Date(Date.now() + 30 * 86_400_000).toISOString().split('T')[0]

    const rowsToInsert: Array<{
      property_id:               string
      org_id:                    string
      name:                      string
      description:               string | null
      schedule_type:             ScheduleType
      frequency:                 ScheduleFrequency
      vendor_specialty_hint:     VendorSpecialty | null
      estimated_cost:            number | null
      auto_create_wo:            boolean
      next_due_date:             string
      is_active:                 boolean
      active_from_month:         number | null
      active_to_month:           number | null
      asset_category:            string | null
      is_from_standard_template: boolean
      source_template_item_id:   string
    }> = []
    let skipped = 0

    for (const property of properties) {
      for (const item of items) {
        const key = `${property.id}::${item.name}`
        if (existingNames.has(key)) {
          skipped++
          continue
        }

        rowsToInsert.push({
          property_id:               property.id,
          org_id:                    membership.org_id,
          name:                      item.name,
          description:               item.description,
          schedule_type:             'routine',
          frequency:                 recurrenceOverrides[item.id] ?? item.schedule_frequency,
          vendor_specialty_hint:     item.vendor_specialty_hint,
          estimated_cost:            item.estimated_cost,
          auto_create_wo:            true,
          next_due_date:             nextDueDates[item.id] ?? fallbackDueDate,
          is_active:                 true,
          active_from_month:         item.active_from_month ?? null,
          active_to_month:           item.active_to_month ?? null,
          asset_category:            item.asset_category ?? null,
          is_from_standard_template: template.is_system,
          source_template_item_id:   item.id,
        })
      }
    }

    if (rowsToInsert.length > 0) {
      const { error } = await supabase.from('maintenance_schedules').insert(rowsToInsert)
      if (error) {
        console.error('[broadcastMaintenanceTemplate]', error)
        return { error: 'Failed to broadcast template' }
      }
    }

    await inngest.send({
      name: 'maintenance/template-broadcast' as const,
      data: {
        org_id:       membership.org_id,
        template_id:  templateId,
        property_ids: (properties as { id: string }[]).map((p) => p.id),
        triggered_by: user.id,
      },
    })

    revalidatePath('/maintenance')
    revalidatePath('/templates/maintenance/create')
    revalidatePath('/templates/maintenance/saved')
    revalidatePath('/templates/maintenance/schedules')
    return { success: true, created: rowsToInsert.length, skipped }
  } catch (err) {
    console.error('[broadcastMaintenanceTemplate]', err)
    reportError(err, { site: 'serverAction.maintenance.broadcastMaintenanceTemplate' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Update Maintenance Template ──────────────────────────────────────────────

export async function updateMaintenanceTemplate(
  templateId: string,
  updates: { name: string; description: string | null }
): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    if (!['owner', 'admin', 'manager'].includes(membership.role)) {
      return { error: 'Permission denied' }
    }

    const name        = updates.name.trim().slice(0, 100)
    const description = updates.description?.trim().slice(0, 500) ?? null

    if (!name) return { error: 'Name is required' }

    const templateRes = await supabase
      .from('maintenance_schedule_templates')
      .select('id, is_system')
      .eq('id', templateId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(templateRes.error, { site: 'serverAction.maintenance.updateMaintenanceTemplate', orgId: membership.org_id })) {
      return { error: 'Could not load the template. Please try again.' }
    }
    const template = templateRes.data

    if (!template)          return { error: 'Template not found' }
    if (template.is_system) return { error: 'System templates cannot be edited' }

    const { error } = await supabase
      .from('maintenance_schedule_templates')
      .update({ name, description })
      .eq('id', templateId)
      .eq('org_id', membership.org_id)
      .eq('is_system', false)

    if (error) {
      console.error('[updateMaintenanceTemplate]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance.template.updated',
      targetType: 'maintenance_schedule_template',
      targetId:   templateId,
      metadata:   { name, description },
    })

    revalidatePath('/maintenance')
    revalidatePath('/templates/maintenance/saved')
    return {}
  } catch (err) {
    console.error('[updateMaintenanceTemplate]', err)
    reportError(err, { site: 'serverAction.maintenance.updateMaintenanceTemplate' })
    return { error: 'Operation failed. Please try again.' }
  }
}
