'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import type { WoStatus } from '@/types/database'

export type MaintenanceActionState = { error?: string; success?: boolean }

// ── Create Work Order ────────────────────────────────────────────────────────

export async function createWorkOrder(
  _prev: MaintenanceActionState | null,
  formData: FormData
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const title          = (formData.get('title') as string)?.trim()
  const property_id    = formData.get('property_id') as string
  const description    = (formData.get('description') as string)?.trim() || null
  const priority       = (formData.get('priority') as string) || 'medium'
  const vendor_id      = (formData.get('vendor_id') as string) || null
  const scheduled_date = (formData.get('scheduled_date') as string) || null
  const estimated_cost = formData.get('estimated_cost')
    ? parseFloat(formData.get('estimated_cost') as string)
    : null
  const portal_enabled = formData.get('portal_enabled') === 'on' || formData.get('portal_enabled') === 'true'

  if (!title) return { error: 'Title is required' }
  if (!property_id) return { error: 'Property is required' }

  // Verify property belongs to this org
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  // Generate a completion token if portal enabled
  const completion_token = portal_enabled
    ? crypto.randomUUID().replace(/-/g, '')
    : null

  const completion_token_expires_at = portal_enabled
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    : null

  const { data: wo, error } = await supabase
    .from('work_orders')
    .insert({
      property_id,
      org_id:          membership.org_id,
      vendor_id:       vendor_id || null,
      title,
      description,
      priority:        priority as never,
      status:          vendor_id ? 'assigned' : 'pending',
      source:          'manual',
      scheduled_date:  scheduled_date || null,
      estimated_cost,
      portal_enabled,
      completion_token,
      completion_token_expires_at,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  if (portal_enabled) {
    await inngest.send({
      name: 'work-order/created',
      data: {
        work_order_id: wo.id,
        property_id,
        org_id:        membership.org_id,
        vendor_id:     vendor_id ?? null,
        portal_enabled: true,
      },
    })
  }

  revalidatePath('/maintenance')
  redirect('/maintenance')
}

// ── Update Work Order Status ─────────────────────────────────────────────────

export async function updateWorkOrderStatus(
  workOrderId: string,
  status: WoStatus,
  notes?: string
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  // Fetch current status to record in history
  const { data: current } = await supabase
    .from('work_orders')
    .select('status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!current) return { error: 'Work order not found' }

  const update: Record<string, unknown> = { status }
  if (status === 'completed') {
    update.completed_date   = new Date().toISOString().split('T')[0]
    update.completion_notes = notes ?? null
  }

  const { error } = await supabase
    .from('work_orders')
    .update(update)
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  // Record the status change in history
  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrderId,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               current.status as WoStatus,
    status_to:                 status,
    notes:                     notes ?? null,
  })

  revalidatePath('/maintenance')
  revalidatePath(`/maintenance/${workOrderId}`)
  return { success: true }
}

// ── Delete (cancel) Work Order ───────────────────────────────────────────────

export async function deleteWorkOrder(workOrderId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  const { data: current } = await supabase
    .from('work_orders')
    .select('status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (current) {
    await supabase
      .from('work_orders')
      .update({ status: 'cancelled' })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)

    await supabase.from('work_order_updates').insert({
      work_order_id:             workOrderId,
      org_id:                    membership.org_id,
      updated_via_vendor_portal: false,
      status_from:               current.status as WoStatus,
      status_to:                 'cancelled',
      notes:                     'Cancelled by property manager',
    })
  }

  revalidatePath('/maintenance')
}

// ── Create Work Order from Schedule ─────────────────────────────────────────

export async function createWorkOrderFromSchedule(
  scheduleId: string
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: schedule } = await supabase
    .from('maintenance_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('org_id', membership.org_id)
    .single()

  if (!schedule) return { error: 'Schedule not found' }

  const completion_token = crypto.randomUUID().replace(/-/g, '')
  const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: wo, error } = await supabase
    .from('work_orders')
    .insert({
      property_id:        schedule.property_id,
      org_id:             membership.org_id,
      vendor_id:          schedule.assigned_vendor_id,
      title:              schedule.name,
      description:        schedule.description,
      priority:           'medium' as never,
      status:             schedule.assigned_vendor_id ? 'assigned' : 'pending',
      source:             'maintenance_schedule',
      source_schedule_id: schedule.id,
      scheduled_date:     schedule.next_due_date,
      estimated_cost:     schedule.estimated_cost,
      portal_enabled:     !!schedule.assigned_vendor_id,
      completion_token:   schedule.assigned_vendor_id ? completion_token : null,
      completion_token_expires_at: schedule.assigned_vendor_id ? completion_token_expires_at : null,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  if (schedule.assigned_vendor_id) {
    await inngest.send({
      name: 'work-order/created',
      data: {
        work_order_id:  wo.id,
        property_id:    schedule.property_id,
        org_id:         membership.org_id,
        vendor_id:      schedule.assigned_vendor_id,
        portal_enabled: true,
      },
    })
  }

  revalidatePath('/maintenance')
  return { success: true }
}
