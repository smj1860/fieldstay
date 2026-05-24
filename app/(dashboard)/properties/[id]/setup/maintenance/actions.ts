'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export type MaintenanceState = { error?: string; success?: boolean }

export async function addMaintenanceSchedule(
  propertyId: string,
  _prev: MaintenanceState | null,
  formData: FormData
): Promise<MaintenanceState> {
  const { supabase, membership } = await requireOrgMember()

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

  const { error } = await supabase.from('maintenance_schedules').insert({
    property_id:       propertyId,
    org_id:            membership.org_id,
    assigned_vendor_id: vendor_id,
    name, schedule_type,
    frequency: schedule_type === 'routine' ? (frequency as never) : null,
    month_due: schedule_type === 'seasonal' ? month_due : null,
    estimated_cost, instructions, auto_create_wo, next_due_date,
  })

  if (error) return { error: error.message }

  revalidatePath(`/properties/${propertyId}/setup/maintenance`)
  return { success: true }
}

export async function deleteMaintenanceSchedule(id: string, propertyId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()
  await supabase.from('maintenance_schedules').delete().eq('id', id).eq('org_id', membership.org_id)
  revalidatePath(`/properties/${propertyId}/setup/maintenance`)
}

export async function completeMaintenanceStep(propertyId: string): Promise<void> {
  await markStepComplete(propertyId, 'maintenance')
  redirect(`/properties/${propertyId}/setup/crew`)
}
