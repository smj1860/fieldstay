'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'

export interface MaintenanceScheduleInput {
  title:          string
  description:    string | null
  frequency:      string
  specialty:      string | null
  estimated_cost: number | null
}

export async function saveMasterMaintenanceSchedules(
  items: MaintenanceScheduleInput[]
): Promise<{ error?: string; saved: number }> {
  const { supabase, membership } = await requireOrgMember()

  // Full replace
  await supabase
    .from('org_master_maintenance_schedules')
    .update({ is_active: false })
    .eq('org_id', membership.org_id)

  if (items.length === 0) return { saved: 0 }

  const { error } = await supabase
    .from('org_master_maintenance_schedules')
    .insert(
      items.map((item) => ({
        org_id:         membership.org_id,
        title:          item.title,
        description:    item.description,
        frequency:      item.frequency,
        specialty:      item.specialty,
        estimated_cost: item.estimated_cost,
        is_active:      true,
      }))
    )

  if (error) {
    console.error('[saveMasterMaintenanceSchedules]', error)
    return { error: 'Operation failed. Please try again.', saved: 0 }
  }

  revalidatePath('/setup')
  revalidatePath('/maintenance')
  return { saved: items.length }
}
