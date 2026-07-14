'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'

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
  const { user, supabase, membership } = await requireOrgMember()

  // Full replace
  await supabase
    .from('org_master_maintenance_schedules')
    .update({ is_active: false })
    .eq('org_id', membership.org_id)

  if (items.length === 0) {
    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'maintenance.template.updated',
      targetType: 'organization',
      targetId:   membership.org_id,
      metadata:   { saved: 0 },
    })
    return { saved: 0 }
  }

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

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'maintenance.template.updated',
    targetType: 'organization',
    targetId:   membership.org_id,
    metadata:   { saved: items.length },
  })

  revalidatePath('/setup')
  revalidatePath('/maintenance')
  return { saved: items.length }
}
