'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'
import { logAuditEvent } from '@/lib/audit'

export type MaintenanceState = { error?: string; success?: boolean }

export async function addMaintenanceSchedule(
  propertyId: string,
  _prev: MaintenanceState | null,
  formData: FormData
): Promise<MaintenanceState> {
  try {
    const { user, supabase, membership } = await requireOrgMember()

    const name          = (formData.get('name') as string)?.trim()
    const schedule_type = formData.get('schedule_type') as 'routine' | 'seasonal'
    const frequency     = formData.get('frequency') as string || null
    const month_due     = formData.get('month_due') ? parseInt(formData.get('month_due') as string) : null
    const estimated_cost = formData.get('estimated_cost') ? parseFloat(formData.get('estimated_cost') as string) : null
    const instructions  = (formData.get('instructions') as string)?.trim() || null
    const auto_create_wo = formData.get('auto_create_wo') === 'true'
    const vendor_id     = formData.get('vendor_id') as string || null

    if (!name) return { error: 'Schedule name is required' }

    // Calculate first next_due_date
    let next_due_date: string | null = null
    const today = new Date()
    if (schedule_type === 'seasonal' && month_due) {
      const year   = today.getMonth() + 1 >= month_due ? today.getFullYear() + 1 : today.getFullYear()
      next_due_date = `${year}-${String(month_due).padStart(2, '0')}-01`
    }

    const { data: newSchedule, error } = await supabase.from('maintenance_schedules').insert({
      property_id:       propertyId,
      org_id:            membership.org_id,
      assigned_vendor_id: vendor_id,
      name, schedule_type,
      frequency: schedule_type === 'routine' ? (frequency as never) : null,
      month_due: schedule_type === 'seasonal' ? month_due : null,
      estimated_cost, instructions, auto_create_wo, next_due_date,
    }).select('id').single()

    if (error) {
      console.error('[addMaintenanceSchedule]', error)
      return { error: 'Failed to save schedule. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance_schedule.created',
      targetType: 'maintenance_schedule',
      targetId:   newSchedule?.id,
      metadata:   { property_id: propertyId, name, schedule_type },
    })

    revalidatePath(`/properties/${propertyId}/setup/maintenance`)
    return { success: true }
  } catch (err) {
    console.error('[addMaintenanceSchedule]', err)
    return { error: 'Failed to save schedule. Please try again.' }
  }
}

export async function deleteMaintenanceSchedule(id: string, propertyId: string): Promise<void> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    await supabase.from('maintenance_schedules').delete().eq('id', id).eq('org_id', membership.org_id)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance_schedule.deleted',
      targetType: 'maintenance_schedule',
      targetId:   id,
      metadata:   { property_id: propertyId },
    })

    revalidatePath(`/properties/${propertyId}/setup/maintenance`)
  } catch (err) {
    console.error('[deleteMaintenanceSchedule]', err)
    throw err
  }
}

export async function completeMaintenanceStep(propertyId: string): Promise<void> {
  try {
    await markStepComplete(propertyId, 'maintenance')
    redirect(`/properties/${propertyId}/setup/crew`)
  } catch (err) {
    unstable_rethrow(err)
    console.error('[completeMaintenanceStep]', err)
    throw err
  }
}

export async function cloneMaintenanceFromProperty(
  sourcePropertyId: string,
  targetPropertyId: string,
): Promise<{ added: number; skipped: number; error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const { data: sourceSchedules } = await supabase
      .from('maintenance_schedules')
      .select('name, description, schedule_type, frequency, month_due, day_of_month_due, estimated_cost, instructions, auto_create_wo, assigned_vendor_id')
      .eq('property_id', sourcePropertyId)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)

    if (!sourceSchedules?.length) return { added: 0, skipped: 0, error: 'Source has no schedules' }

    const { data: existing } = await supabase
      .from('maintenance_schedules')
      .select('name')
      .eq('property_id', targetPropertyId)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)

    const existingNames = new Set((existing ?? []).map(s => s.name.toLowerCase()))

    const toInsert = sourceSchedules
      .filter(s => !existingNames.has(s.name.toLowerCase()))
      .map(s => ({
        property_id:        targetPropertyId,
        org_id:             membership.org_id,
        name:               s.name,
        description:        s.description ?? null,
        schedule_type:      s.schedule_type,
        frequency:          s.frequency ?? null,
        month_due:          s.month_due ?? null,
        day_of_month_due:   s.day_of_month_due ?? null,
        estimated_cost:     s.estimated_cost ?? null,
        instructions:       s.instructions ?? null,
        auto_create_wo:     s.auto_create_wo,
        assigned_vendor_id: s.assigned_vendor_id ?? null,
        // CRITICAL: reset date fields — new property starts fresh
        next_due_date:       null,
        last_completed_date: null,
        is_active:           true,
      }))

    const skipped = sourceSchedules.length - toInsert.length
    if (toInsert.length === 0) return { added: 0, skipped }

    const { error } = await supabase.from('maintenance_schedules').insert(toInsert)
    if (error) {
      console.error('[cloneMaintenanceFromProperty]', error)
      return { added: 0, skipped, error: 'Operation failed. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'property.maintenance.cloned',
      targetType: 'property',
      targetId:   targetPropertyId,
      metadata:   { sourcePropertyId, added: toInsert.length, skipped },
    })

    revalidatePath(`/properties/${targetPropertyId}/setup/maintenance`)
    return { added: toInsert.length, skipped }
  } catch (err) {
    console.error('[cloneMaintenanceFromProperty]', err)
    return { added: 0, skipped: 0, error: 'Operation failed. Please try again.' }
  }
}
