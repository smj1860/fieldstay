'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import type { WoStatus, ScheduleFrequency, ScheduleType, VendorSpecialty } from '@/types/database'

export type MaintenanceActionState = { error?: string; success?: boolean; workOrderId?: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() { return new Date().toISOString().split('T')[0] }

// ── Create Work Order ────────────────────────────────────────────────────────

export async function createWorkOrder(
  _prev: MaintenanceActionState | null,
  formData: FormData
): Promise<MaintenanceActionState> {
  const { supabase, membership } = await requireOrgMember()

  const title                  = (formData.get('title') as string)?.trim()
  const property_id            = formData.get('property_id') as string
  const description            = (formData.get('description') as string)?.trim() || null
  const priority               = (formData.get('priority') as string) || 'medium'
  const vendor_id              = (formData.get('vendor_id') as string) || null
  const assigned_crew_member_id = (formData.get('assigned_crew_member_id') as string) || null
  const scheduled_date         = (formData.get('scheduled_date') as string) || null
  const estimated_cost         = formData.get('estimated_cost')
    ? parseFloat(formData.get('estimated_cost') as string)
    : null
  const nte_amount             = formData.get('nte_amount')
    ? parseFloat(formData.get('nte_amount') as string)
    : null
  const asset_id         = (formData.get('asset_id') as string) || null
  const portal_enabled   = formData.get('portal_enabled') === 'on' || formData.get('portal_enabled') === 'true'
  // Quote-request mode: create WO as quote_requested and send RFQs to selected vendors
  const request_quotes   = formData.get('request_quotes') === 'true'
  const quote_vendor_ids = formData.getAll('quote_vendor_ids') as string[]

  if (!title) return { error: 'Title is required' }
  if (!property_id) return { error: 'Property is required' }
  if (request_quotes && !quote_vendor_ids.length) {
    return { error: 'Select at least one vendor to request quotes from' }
  }

  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', property_id)
    .eq('org_id', membership.org_id)
    .single()

  if (!property) return { error: 'Property not found' }

  // In quote-request mode, WO starts as quote_requested with no vendor assigned yet
  const woStatus            = request_quotes ? 'quote_requested' : (vendor_id ? 'assigned' : 'pending')
  const usePortal           = portal_enabled && !request_quotes
  const completion_token    = usePortal ? crypto.randomUUID().replace(/-/g, '') : null
  const completion_token_expires_at = usePortal
    ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    : null

  const { data: wo, error } = await supabase
    .from('work_orders')
    .insert({
      property_id,
      org_id:                  membership.org_id,
      vendor_id:               request_quotes ? null : (vendor_id || null),
      assigned_crew_member_id: assigned_crew_member_id || null,
      asset_id:                asset_id || null,
      title,
      description,
      priority:                priority as never,
      status:                  woStatus as never,
      source:                  'manual',
      scheduled_date:          scheduled_date || null,
      estimated_cost,
      nte_amount,
      portal_enabled:          usePortal,
      completion_token,
      completion_token_expires_at,
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  // Send RFQ emails to each selected vendor
  if (request_quotes && quote_vendor_ids.length) {
    for (const vendorId of quote_vendor_ids) {
      const quote_token            = crypto.randomUUID().replace(/-/g, '')
      const quote_token_expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

      const { data: qr, error: qrError } = await supabase
        .from('quote_requests')
        .insert({
          work_order_id: wo.id,
          org_id:        membership.org_id,
          vendor_id:     vendorId,
          quote_token,
          quote_token_expires_at,
          status:        'pending',
        })
        .select('id')
        .single()

      if (qrError || !qr) continue

      await inngest.send({
        name: 'work-order/quote-requested' as const,
        data: {
          work_order_id:    wo.id,
          quote_request_id: qr.id,
          property_id,
          org_id:           membership.org_id,
          vendor_id:        vendorId,
          quote_token,
        },
      })
    }

    revalidatePath('/maintenance')
    redirect(`/maintenance/${wo.id}`)
  }

  if (usePortal) {
    await inngest.send({
      name: 'work-order/created',
      data: {
        work_order_id:  wo.id,
        property_id,
        org_id:         membership.org_id,
        vendor_id:      vendor_id ?? null,
        portal_enabled: true,
      },
    })
  }

  revalidatePath('/maintenance')
  return { success: true, workOrderId: wo.id }
}

// ── Rate Work Order Vendor ────────────────────────────────────────────────────

export async function rateWorkOrderVendor(
  workOrderId: string,
  rating: 1 | 2 | 3 | 4 | 5,
  ratingNotes: string | null
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({
      vendor_rating:       rating,
      vendor_rating_notes: ratingNotes ?? null,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }
  revalidatePath('/maintenance')
  revalidatePath('/vendors')
  return {}
}

// ── Assign Crew to Work Order ─────────────────────────────────────────────────

export async function assignCrewToWorkOrder(
  workOrderId: string,
  crewMemberId: string | null
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({
      assigned_crew_member_id: crewMemberId || null,
      vendor_id:               crewMemberId ? null : undefined,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }
  revalidatePath('/maintenance')
  return {}
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

  if (status === 'completed') {
    await inngest.send({
      name: 'work-order/completed',
      data: {
        work_order_id: workOrderId,
        property_id:   current.property_id,
        org_id:        membership.org_id,
        actual_cost:   current.actual_cost ?? current.estimated_cost ?? null,
      },
    })

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

// ── Send quote requests to multiple vendors ───────────────────────────────────

export async function sendQuoteRequests(
  workOrderId: string,
  vendorIds: string[]
): Promise<{ error?: string; sent: number }> {
  const { supabase, membership } = await requireOrgMember()

  if (!vendorIds.length) return { error: 'Select at least one vendor', sent: 0 }

  const { data: wo } = await supabase
    .from('work_orders')
    .select('id, property_id, status')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Work order not found', sent: 0 }
  if (wo.status === 'completed' || wo.status === 'cancelled') {
    return { error: 'Cannot request quotes on a completed or cancelled work order', sent: 0 }
  }

  // Skip vendors who already have a pending or submitted quote for this WO
  const { data: existing } = await supabase
    .from('quote_requests')
    .select('vendor_id')
    .eq('work_order_id', workOrderId)
    .in('status', ['pending', 'submitted'])

  const existingVendorIds = new Set((existing ?? []).map((r) => r.vendor_id))
  const toSend = vendorIds.filter((id) => !existingVendorIds.has(id))

  if (!toSend.length) {
    return { error: 'All selected vendors already have an active quote request', sent: 0 }
  }

  let sent = 0

  for (const vendorId of toSend) {
    const quote_token            = crypto.randomUUID().replace(/-/g, '')
    const quote_token_expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

    const { data: qr, error } = await supabase
      .from('quote_requests')
      .insert({
        work_order_id: workOrderId,
        org_id:        membership.org_id,
        vendor_id:     vendorId,
        quote_token,
        quote_token_expires_at,
        status:        'pending',
      })
      .select('id')
      .single()

    if (error || !qr) continue

    await inngest.send({
      name: 'work-order/quote-requested',
      data: {
        work_order_id:    workOrderId,
        quote_request_id: qr.id,
        property_id:      wo.property_id,
        org_id:           membership.org_id,
        vendor_id:        vendorId,
        quote_token,
      },
    })

    sent++
  }

  revalidatePath(`/maintenance/${workOrderId}`)
  revalidatePath('/maintenance')
  return { sent }
}

// ── Approve one quote — assign WO, decline all others ────────────────────────

export async function approveQuoteRequest(
  quoteRequestId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select('id, work_order_id, vendor_id, quoted_amount, status, org_id')
    .eq('id', quoteRequestId)
    .eq('org_id', membership.org_id)
    .single()

  if (!qr) return { error: 'Quote request not found' }
  if (qr.status !== 'submitted') return { error: 'Can only approve a quote that has been submitted by the vendor' }

  // Mark this one approved
  await supabase
    .from('quote_requests')
    .update({ status: 'approved' })
    .eq('id', quoteRequestId)

  // Decline all other pending/submitted quotes for this WO
  await supabase
    .from('quote_requests')
    .update({ status: 'declined' })
    .eq('work_order_id', qr.work_order_id)
    .neq('id', quoteRequestId)
    .in('status', ['pending', 'submitted'])

  const completion_token            = crypto.randomUUID().replace(/-/g, '')
  const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const { error } = await supabase
    .from('work_orders')
    .update({
      vendor_id:                  qr.vendor_id,
      status:                     'assigned',
      estimated_cost:             qr.quoted_amount ?? undefined,
      portal_enabled:             true,
      completion_token,
      completion_token_expires_at,
    })
    .eq('id', qr.work_order_id)
    .eq('org_id', membership.org_id)

  if (error) return { error: error.message }

  await supabase.from('work_order_updates').insert({
    work_order_id:             qr.work_order_id,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               'pending',
    status_to:                 'assigned',
    notes:                     `Quote approved — $${qr.quoted_amount?.toFixed(2) ?? '?'}. Vendor assigned and notified.`,
  })

  await inngest.send({
    name: 'work-order/created',
    data: {
      work_order_id:  qr.work_order_id,
      property_id:    '',
      org_id:         membership.org_id,
      vendor_id:      qr.vendor_id,
      portal_enabled: true,
    },
  })

  revalidatePath(`/maintenance/${qr.work_order_id}`)
  revalidatePath('/maintenance')
  return {}
}

// ── Decline a single quote request ────────────────────────────────────────────

export async function declineQuoteRequest(
  quoteRequestId: string
): Promise<{ error?: string }> {
  const { supabase, membership } = await requireOrgMember()

  const { data: qr } = await supabase
    .from('quote_requests')
    .select('id, work_order_id')
    .eq('id', quoteRequestId)
    .eq('org_id', membership.org_id)
    .single()

  if (!qr) return { error: 'Quote request not found' }

  await supabase
    .from('quote_requests')
    .update({ status: 'declined' })
    .eq('id', quoteRequestId)

  revalidatePath(`/maintenance/${qr.work_order_id}`)
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

// ── Maintenance Schedule Template Broadcasting ───────────────────────────────

export type BroadcastResult = {
  error?: string
  success?: boolean
  created?: number
  skipped?: number
}

// Idempotent: skip if a maintenance_schedule with the same name
// already exists on the property
export async function broadcastMaintenanceTemplate(
  templateId:  string,
  propertyIds: string[],
): Promise<BroadcastResult> {
  const { supabase, user, membership } = await requireOrgMember()

  if (propertyIds.length === 0) return { error: 'Select at least one property' }

  const { data: template } = await supabase
    .from('maintenance_schedule_templates')
    .select('id, org_id, is_system')
    .eq('id', templateId)
    .single()

  if (!template || (!template.is_system && template.org_id !== membership.org_id)) {
    return { error: 'Template not found' }
  }

  const { data: items } = await supabase
    .from('maintenance_schedule_template_items')
    .select('name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, sort_order')
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true })

  if (!items || items.length === 0) return { error: 'Template has no items' }

  const { data: properties } = await supabase
    .from('properties')
    .select('id')
    .eq('org_id', membership.org_id)
    .in('id', propertyIds)

  if (!properties || properties.length === 0) return { error: 'No matching properties found' }

  const { data: existingSchedules } = await supabase
    .from('maintenance_schedules')
    .select('property_id, name')
    .in('property_id', properties.map((p) => p.id))

  const existingNames = new Set((existingSchedules ?? []).map((s) => `${s.property_id}::${s.name}`))

  const nextDueDate = new Date(Date.now() + 30 * 86_400_000).toISOString().split('T')[0]

  const rowsToInsert: Array<{
    property_id:           string
    org_id:                string
    name:                  string
    description:           string | null
    schedule_type:         ScheduleType
    frequency:             ScheduleFrequency
    vendor_specialty_hint: VendorSpecialty | null
    estimated_cost:        number | null
    auto_create_wo:        boolean
    next_due_date:         string
    is_active:             boolean
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
        property_id:           property.id,
        org_id:                membership.org_id,
        name:                  item.name,
        description:           item.description,
        schedule_type:         'routine',
        frequency:             item.schedule_frequency,
        vendor_specialty_hint: item.vendor_specialty_hint,
        estimated_cost:        item.estimated_cost,
        auto_create_wo:        true,
        next_due_date:         nextDueDate,
        is_active:             true,
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
      property_ids: properties.map((p) => p.id),
      triggered_by: user.id,
    },
  })

  revalidatePath('/maintenance')
  return { success: true, created: rowsToInsert.length, skipped }
}
