'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import type { WoStatus, ScheduleFrequency, ScheduleType } from '@/types/database'

export type MaintenanceActionState = { error?: string; success?: boolean }

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() { return new Date().toISOString().split('T')[0] }

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

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  const completion_token = portal_enabled ? crypto.randomUUID().replace(/-/g, '') : null
  const completion_token_expires_at = portal_enabled
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
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

// ── Update Work Order ────────────────────────────────────────────────────────

export async function updateWorkOrder(
  workOrderId: string,
  data: {
    title:           string
    description:     string | null
    priority:        string
    vendor_id:       string | null
    scheduled_date:  string | null
    estimated_cost:  number | null
    portal_enabled:  boolean
  }
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({
      title:          data.title,
      description:    data.description || null,
      priority:       data.priority as never,
      vendor_id:      data.vendor_id || null,
      scheduled_date: data.scheduled_date || null,
      estimated_cost: data.estimated_cost || null,
      portal_enabled: data.portal_enabled,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return {}
}

// ── Add Work Order Note ──────────────────────────────────────────────────────

export async function addWorkOrderNote(
  workOrderId: string,
  note: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, org_id')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Work order not found' }

  const { data: { user } } = await supabase.auth.getUser()

  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrderId,
    org_id:                    membership.org_id,
    updated_by_user_id:        user?.id ?? null,
    updated_via_vendor_portal: false,
    status_from:               null,
    status_to:                 null,
    notes:                     note.trim(),
  })

  revalidatePath(`/maintenance/${workOrderId}`)
  return {}
}

// ── Update Work Order Status ─────────────────────────────────────────────────

export async function updateWorkOrderStatus(
  workOrderId: string,
  status: WoStatus,
  notes?: string
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: current } = await supabase
    .from('work_orders')
    .select('status, source_schedule_id, actual_cost, estimated_cost, title, property_id')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!current) return { error: 'Work order not found' }

  const update: Record<string, unknown> = { status }
  if (status === 'completed') {
    update.completed_date   = isoDate()
    update.completion_notes = notes ?? null
  }

  const { error } = await supabase
    .from('work_orders')
    .update(update)
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  // Auto-create expense when completed with a cost
  if (status === 'completed') {
    const cost = current.actual_cost ?? current.estimated_cost
    if (cost && cost > 0) {
      const { count } = await supabase
        .from('owner_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('work_order_id', workOrderId)

      if ((count ?? 0) === 0) {
        await supabase.from('owner_transactions').insert({
          property_id:      current.property_id,
          org_id:           membership.org_id,
          work_order_id:    workOrderId,
          transaction_type: 'expense',
          category:         'maintenance',
          amount:           cost,
          description:      current.title,
          transaction_date: isoDate(),
        })
      }
    }

    // Feature 4: Advance recurring schedule when linked WO is completed
    if (current.source_schedule_id) {
      await advanceScheduleAfterCompletion(supabase, current.source_schedule_id, membership.org_id)
    }
  }

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

// ── Feature 4: Advance schedule after WO completion ──────────────────────────

async function advanceScheduleAfterCompletion(
  supabase: Awaited<ReturnType<typeof import('@/lib/supabase/server').createClient>>,
  scheduleId: string,
  orgId: string
) {
  const { data: schedule } = await supabase
    .from('maintenance_schedules')
    .select('id, schedule_type, frequency, next_due_date, auto_create_wo')
    .eq('id', scheduleId)
    .eq('org_id', orgId)
    .single()

  if (!schedule || !schedule.next_due_date) return

  const lastCompleted = isoDate()

  if (schedule.schedule_type === 'routine' && schedule.frequency) {
    const currentDue = new Date(schedule.next_due_date)
    const nextDue    = calcNextDueDate(schedule.frequency as ScheduleFrequency, currentDue)

    await supabase
      .from('maintenance_schedules')
      .update({
        last_completed_date: lastCompleted,
        next_due_date:       nextDue.toISOString().split('T')[0],
      })
      .eq('id', scheduleId)
  } else {
    // Seasonal / one-time: just record completion date
    await supabase
      .from('maintenance_schedules')
      .update({ last_completed_date: lastCompleted })
      .eq('id', scheduleId)
  }
}

// ── Feature 2: Log actual cost (PM-side) ─────────────────────────────────────

export async function logActualCost(
  workOrderId: string,
  data: { actual_cost: number; invoice_reference?: string }
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: wo, error: fetchErr } = await supabase
    .from('work_orders')
    .select('id, status, title, property_id, actual_cost')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: fetchErr?.message ?? 'Work order not found' }

  const { error } = await supabase
    .from('work_orders')
    .update({
      actual_cost:       data.actual_cost,
      invoice_reference: data.invoice_reference || null,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrderId,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               null,
    status_to:                 null,
    notes:                     `Actual cost logged: $${data.actual_cost.toFixed(2)}${data.invoice_reference ? ` (Invoice: ${data.invoice_reference})` : ''}`,
  })

  // Upsert expense transaction with actual cost
  if (wo.status === 'completed') {
    const { data: existing } = await supabase
      .from('owner_transactions')
      .select('id')
      .eq('work_order_id', workOrderId)
      .single()

    if (existing) {
      await supabase
        .from('owner_transactions')
        .update({ amount: data.actual_cost, description: wo.title })
        .eq('id', existing.id)
    } else {
      await supabase.from('owner_transactions').insert({
        property_id:      wo.property_id,
        org_id:           membership.org_id,
        work_order_id:    workOrderId,
        transaction_type: 'expense',
        category:         'maintenance',
        amount:           data.actual_cost,
        description:      wo.title,
        transaction_date: isoDate(),
      })
    }
  }

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return {}
}

// ── Feature 1: Upload work order photo (record after client-side upload) ──────

export async function recordWorkOrderPhoto(
  workOrderId: string,
  storagePath: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: { user } } = await supabase.auth.getUser()

  const { error } = await supabase.from('work_order_photos').insert({
    work_order_id: workOrderId,
    storage_path:  storagePath,
    uploaded_by:   user?.id ?? 'pm',
  })

  if (error) return { error: error.message }

  revalidatePath(`/maintenance/${workOrderId}`)
  return {}
}

export async function deleteWorkOrderPhoto(photoId: string): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: photo } = await supabase
    .from('work_order_photos')
    .select('id, storage_path, work_order_id')
    .eq('id', photoId)
    .single()

  if (!photo) return { error: 'Photo not found' }

  // Verify the work order belongs to this org before deleting
  const { data: wo } = await supabase
    .from('work_orders')
    .select('id')
    .eq('id', photo.work_order_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Photo not found' }

  // Delete from storage
  await supabase.storage.from('work-order-photos').remove([photo.storage_path])

  // Delete record
  await supabase.from('work_order_photos').delete().eq('id', photoId)

  revalidatePath(`/maintenance/${photo.work_order_id}`)
  return {}
}

// ── Feature 5: Request vendor quote ──────────────────────────────────────────

export async function requestVendorQuote(
  workOrderId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, vendor_id, property_id, status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Work order not found' }
  if (!wo.vendor_id) return { error: 'Assign a vendor before requesting a quote' }
  if (wo.status !== 'pending') return { error: 'Can only request a quote on a pending work order' }

  const quote_token = crypto.randomUUID().replace(/-/g, '')
  const quote_token_expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('work_orders')
    .update({ status: 'quote_requested', quote_token, quote_token_expires_at })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrderId,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               'pending',
    status_to:                 'quote_requested',
    notes:                     'Quote requested from vendor',
  })

  await inngest.send({
    name: 'work-order/quote-requested',
    data: {
      work_order_id: workOrderId,
      property_id:   wo.property_id,
      org_id:        membership.org_id,
      vendor_id:     wo.vendor_id,
      quote_token,
    },
  })

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return {}
}

export async function approveVendorQuote(workOrderId: string): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, vendor_id, quoted_amount, status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo || wo.status !== 'quote_requested') return { error: 'Work order not in quote_requested state' }

  const completion_token = crypto.randomUUID().replace(/-/g, '')
  const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('work_orders')
    .update({
      status:                    'assigned',
      estimated_cost:            wo.quoted_amount ?? undefined,
      portal_enabled:            true,
      completion_token,
      completion_token_expires_at,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrderId,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               'quote_requested',
    status_to:                 'assigned',
    notes:                     `Quote approved — $${wo.quoted_amount?.toFixed(2) ?? '?'}. Vendor notified.`,
  })

  if (wo.vendor_id) {
    await inngest.send({
      name: 'work-order/created',
      data: {
        work_order_id:  workOrderId,
        property_id:    '',
        org_id:         membership.org_id,
        vendor_id:      wo.vendor_id,
        portal_enabled: true,
      },
    })
  }

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return {}
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

  // Feature 4: Advance next_due_date immediately on manual WO creation from schedule
  if (schedule.schedule_type === 'routine' && schedule.frequency && schedule.next_due_date) {
    const nextDue = calcNextDueDate(schedule.frequency as ScheduleFrequency, new Date(schedule.next_due_date))
    await supabase
      .from('maintenance_schedules')
      .update({ next_due_date: nextDue.toISOString().split('T')[0] })
      .eq('id', scheduleId)
  }

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

// ── Maintenance Schedule CRUD ────────────────────────────────────────────────

export async function createMaintenanceSchedule(
  data: {
    property_id:       string
    name:              string
    description:       string | null
    schedule_type:     ScheduleType
    frequency:         ScheduleFrequency | null
    month_due:         number | null
    next_due_date:     string | null
    estimated_cost:    number | null
    assigned_vendor_id: string | null
    auto_create_wo:    boolean
    instructions:      string | null
  }
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', data.property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  const { error } = await supabase.from('maintenance_schedules').insert({
    property_id:        data.property_id,
    org_id:             membership.org_id,
    name:               data.name,
    description:        data.description || null,
    schedule_type:      data.schedule_type,
    frequency:          data.frequency || null,
    month_due:          data.month_due || null,
    next_due_date:      data.next_due_date || null,
    estimated_cost:     data.estimated_cost || null,
    assigned_vendor_id: data.assigned_vendor_id || null,
    auto_create_wo:     data.auto_create_wo,
    instructions:       data.instructions || null,
    is_active:          true,
  })

  if (error) return { error: error.message }

  revalidatePath('/maintenance')
  return { success: true }
}

export async function updateMaintenanceSchedule(
  scheduleId: string,
  data: {
    name:              string
    description:       string | null
    schedule_type:     ScheduleType
    frequency:         ScheduleFrequency | null
    month_due:         number | null
    next_due_date:     string | null
    estimated_cost:    number | null
    assigned_vendor_id: string | null
    auto_create_wo:    boolean
    instructions:      string | null
  }
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('maintenance_schedules')
    .update({
      name:               data.name,
      description:        data.description || null,
      schedule_type:      data.schedule_type,
      frequency:          data.frequency || null,
      month_due:          data.month_due || null,
      next_due_date:      data.next_due_date || null,
      estimated_cost:     data.estimated_cost || null,
      assigned_vendor_id: data.assigned_vendor_id || null,
      auto_create_wo:     data.auto_create_wo,
      instructions:       data.instructions || null,
    })
    .eq('id', scheduleId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/maintenance')
  return { success: true }
}

export async function deleteMaintenanceSchedule(
  scheduleId: string
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('maintenance_schedules')
    .update({ is_active: false })
    .eq('id', scheduleId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  revalidatePath('/maintenance')
  return { success: true }
}
