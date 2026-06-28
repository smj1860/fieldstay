'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { logAuditEvent } from '@/lib/audit'
import type { WoStatus, ScheduleFrequency, ScheduleType, VendorSpecialty } from '@/types/database'
import { PriorityLevelSchema, WoStatusSchema } from '@/lib/schemas/work-order'
import type { SupabaseClient } from '@supabase/supabase-js'

export type MaintenanceActionState = { error?: string; success?: boolean; workOrderId?: string; templateId?: string; warning?: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() { return new Date().toISOString().split('T')[0] }

// ── Create Work Order ────────────────────────────────────────────────────────

export async function createWorkOrder(
  _prev: MaintenanceActionState | null,
  formData: FormData
): Promise<MaintenanceActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const title                  = (formData.get('title') as string)?.trim()
  const property_id            = formData.get('property_id') as string
  const description            = (formData.get('description') as string)?.trim() || null
  const priorityInput          = (formData.get('priority') as string) || 'medium'
  const priority               = PriorityLevelSchema.safeParse(priorityInput).data ?? 'medium'
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
  const woStatus            = WoStatusSchema.parse(
    request_quotes ? 'quote_requested' : (vendor_id ? 'assigned' : 'pending')
  )
  const usePortal           = portal_enabled && !request_quotes
  const completion_token    = usePortal ? crypto.randomUUID() : null
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
      priority,
      status:                  woStatus,
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

  if (error) {
    console.error('[createWorkOrder]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  // Send RFQ emails to each selected vendor
  if (request_quotes && quote_vendor_ids.length) {
    for (const vendorId of quote_vendor_ids) {
      const quote_token            = crypto.randomUUID()
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

  // Warn the PM when a vendor was assigned but no notification will be
  // sent — otherwise they're left assuming the vendor was notified.
  let warning: string | undefined
  if (vendor_id && !usePortal) {
    warning = 'Work order created, but the vendor was not notified because the portal link is disabled for this vendor. Enable the portal in Vendor settings or notify them manually.'
  }

  // Warn the PM when the assigned crew member marked time off that day —
  // non-blocking, since they may want to override.
  if (assigned_crew_member_id && scheduled_date) {
    const { data: timeOff } = await supabase
      .from('crew_availability')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('crew_member_id', assigned_crew_member_id)
      .eq('available_date', scheduled_date)
      .eq('is_available', false)
      .maybeSingle()

    if (timeOff) {
      warning = 'Work order created, but the assigned crew member marked time off on the scheduled date.'
    }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.created',
    targetType: 'work_order',
    targetId:   wo.id,
    metadata:   { title, property_id, priority, source: 'manual' },
  })

  // Internal crew assignment: no vendor, no portal/dispatch email. The WO
  // surfaces in the crew PWA via Dexie sync; this event scaffolds push notify.
  const isCrew = !vendor_id && !!assigned_crew_member_id
  if (isCrew) {
    await inngest.send({
      name: 'work-order/crew.assigned',
      data: {
        workOrderId:  wo.id,
        orgId:        membership.org_id,
        crewMemberId: assigned_crew_member_id,
      },
    })
  }

  revalidatePath('/maintenance')
  return { success: true, workOrderId: wo.id, warning }
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

  if (error) {
    console.error('[rateWorkOrderVendor]', error)
    return { error: 'Operation failed. Please try again.' }
  }
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

  if (error) {
    console.error('[assignCrewToWorkOrder]', error)
    return { error: 'Operation failed. Please try again.' }
  }
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
  const { supabase, membership, user } = await requireOrgMember()

  const priority = PriorityLevelSchema.safeParse(data.priority).data ?? 'medium'

  // Fetch current vendor_id before updating to detect a vendor change
  const { data: currentWo } = await supabase
    .from('work_orders')
    .select('vendor_id')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  const previousVendorId = currentWo?.vendor_id ?? null
  const newVendorId      = data.vendor_id || null

  const { error } = await supabase
    .from('work_orders')
    .update({
      title:          data.title,
      description:    data.description || null,
      priority,
      vendor_id:      newVendorId,
      scheduled_date: data.scheduled_date || null,
      estimated_cost: data.estimated_cost || null,
      portal_enabled: data.portal_enabled,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[updateWorkOrder]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  // Fire dispatch if a vendor was set or changed
  if (newVendorId && newVendorId !== previousVendorId) {
    await inngest.send({
      name: 'work-order/vendor.assigned',
      data: {
        workOrderId,
        orgId:           membership.org_id,
        vendorId:        newVendorId,
        previousVendorId,
      },
    })
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.updated',
    targetType: 'work_order',
    targetId:   workOrderId,
  })

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
    .select('status, source_schedule_id, source, actual_cost, estimated_cost, title, property_id')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!current) return { error: 'Work order not found' }

  // Already completed (e.g. double-click or retried request) — no-op rather
  // than re-firing work-order/completed and double-advancing its schedule.
  if (current.status === 'completed') return { success: true }

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

  if (error) {
    console.error('[updateWorkOrderStatus]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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
      await advanceScheduleAfterCompletion(supabase, current.source_schedule_id, membership.org_id, current.source ?? undefined)
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
  supabase: SupabaseClient,
  scheduleId: string,
  orgId: string,
  workOrderSource?: string
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
    // Bumped (gap-driven) completions anchor to the ACTUAL completion date —
    // anchoring to the original scheduled date would discard the benefit of
    // having done the work early and silently desync the cadence over time.
    // Normal on-time completions keep the existing fixed-calendar anchor.
    const anchor = workOrderSource === 'vacancy_gap_suggestion'
      ? new Date(lastCompleted)
      : new Date(schedule.next_due_date)

    const nextDue = calcNextDueDate(schedule.frequency as ScheduleFrequency, anchor)

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
  const { supabase, membership, user } = await requireOrgMember()

  const { data: wo, error: fetchErr } = await supabase
    .from('work_orders')
    .select('id, status, title, property_id, actual_cost')
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)
    .single()

  if (!wo) return { error: 'Work order not found' }

  const { error } = await supabase
    .from('work_orders')
    .update({
      actual_cost:       data.actual_cost,
      invoice_reference: data.invoice_reference || null,
    })
    .eq('id', workOrderId)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[logActualCost]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrderId,
    org_id:                    membership.org_id,
    updated_via_vendor_portal: false,
    status_from:               null,
    status_to:                 null,
    notes:                     `Actual cost logged: $${data.actual_cost.toFixed(2)}${data.invoice_reference ? ` (Invoice: ${data.invoice_reference})` : ''}`,
  })

  // Upsert expense transaction with actual cost (updates amount if already posted)
  if (wo.status === 'completed') {
    await supabase.from('owner_transactions').upsert({
      property_id:          wo.property_id,
      org_id:               membership.org_id,
      work_order_id:        workOrderId,
      source:               'wo_completion',
      source_reference_id:  workOrderId,
      transaction_type:     'expense',
      category:             'maintenance',
      amount:               data.actual_cost,
      description:          wo.title,
      transaction_date:     isoDate(),
    }, { onConflict: 'source_reference_id,source' })
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.cost.logged',
    targetType: 'work_order',
    targetId:   workOrderId,
    metadata:   { actual_cost: data.actual_cost },
  })

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

  if (error) {
    console.error('[recordWorkOrderPhoto]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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
    const quote_token            = crypto.randomUUID()
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

  // Atomic status guard — prevents double-approval from concurrent requests
  const { data: claimed } = await supabase
    .from('quote_requests')
    .update({ status: 'approved' })
    .eq('id', quoteRequestId)
    .eq('status', 'submitted')
    .select('id')
    .single()

  if (!claimed) return { error: 'Can only approve a quote that has been submitted by the vendor' }

  // Decline all other pending/submitted quotes for this WO
  await supabase
    .from('quote_requests')
    .update({ status: 'declined' })
    .eq('work_order_id', qr.work_order_id)
    .neq('id', quoteRequestId)
    .in('status', ['pending', 'submitted'])

  const completion_token            = crypto.randomUUID()
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

  if (error) {
    console.error('[approveQuoteRequest]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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
  const { supabase, membership, user } = await requireOrgMember()

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

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'work_order.cancelled',
      targetType: 'work_order',
      targetId:   workOrderId,
      metadata:   { previous_status: current.status },
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

  // Idempotency: skip if an open WO already exists for this schedule + date —
  // mirrors the auto-create check in the maintenance-schedule cron, so a
  // double-click on "Create Work Order Now" doesn't create a duplicate while
  // still allowing the next cycle's WO once this one is completed/cancelled.
  const { data: existingWO } = await supabase
    .from('work_orders')
    .select('id')
    .eq('source_schedule_id', scheduleId)
    .eq('scheduled_date', schedule.next_due_date)
    .not('status', 'in', '("completed","cancelled")')
    .maybeSingle()

  if (existingWO) return { success: true }

  const completion_token = crypto.randomUUID()
  const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: wo, error } = await supabase
    .from('work_orders')
    .insert({
      property_id:        schedule.property_id,
      org_id:             membership.org_id,
      vendor_id:          schedule.assigned_vendor_id,
      title:              schedule.name,
      description:        schedule.description,
      priority:           PriorityLevelSchema.parse('medium'),
      status:             WoStatusSchema.parse(schedule.assigned_vendor_id ? 'assigned' : 'pending'),
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

  if (error) {
    console.error('[createWorkOrderFromSchedule]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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

// ── Bulk Work Order Actions ──────────────────────────────────────────────────

export async function bulkAssignVendor(
  workOrderIds: string[],
  vendorId: string
): Promise<{ error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { data: vendor } = await supabase
    .from('vendors')
    .select('id')
    .eq('id', vendorId)
    .eq('org_id', membership.org_id)
    .single()

  if (!vendor) return { error: 'Vendor not found' }

  const { error } = await supabase
    .from('work_orders')
    .update({ vendor_id: vendorId, assigned_crew_member_id: null })
    .in('id', workOrderIds)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[bulkAssignVendor]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.bulk_assigned',
    targetType: 'work_order',
    metadata:   { workOrderIds, vendorId },
  })

  // Dispatch vendor assignment email for each WO
  if (workOrderIds.length > 0) {
    await inngest.send(
      workOrderIds.map((woId) => ({
        name: 'work-order/vendor.assigned' as const,
        data: {
          workOrderId:      woId,
          orgId:            membership.org_id,
          vendorId,
          previousVendorId: null,  // bulk assign doesn't know previous — always dispatch
        },
      }))
    )
  }

  revalidatePath('/maintenance')
  return {}
}

export async function bulkUpdateWorkOrderStatus(
  workOrderIds: string[],
  status: WoStatus
): Promise<{ error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { error } = await supabase
    .from('work_orders')
    .update({ status })
    .in('id', workOrderIds)
    .eq('org_id', membership.org_id)

  if (error) {
    console.error('[bulkUpdateWorkOrderStatus]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'work_order.bulk_status_changed',
    targetType: 'work_order',
    metadata:   { workOrderIds, status },
  })

  revalidatePath('/maintenance')
  return {}
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

  if (error) {
    console.error('[createMaintenanceSchedule]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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

  if (error) {
    console.error('[updateMaintenanceSchedule]', error)
    return { error: 'Operation failed. Please try again.' }
  }

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

  if (error) {
    console.error('[deleteMaintenanceSchedule]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  revalidatePath('/maintenance')
  return { success: true }
}

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
  const { supabase, membership } = await requireOrgMember()

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
  return { success: true, templateId: template.id }
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
  templateId:         string,
  propertyIds:        string[],
  nextDueDates:       Record<string, string>          = {},
  recurrenceOverrides: Record<string, ScheduleFrequency> = {},
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
    .select('id, name, description, schedule_frequency, vendor_specialty_hint, estimated_cost, sort_order, asset_category, active_from_month, active_to_month')
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
    .in('property_id', (properties as { id: string }[]).map((p) => p.id))

  const existingNames = new Set((existingSchedules ?? []).map((s: { property_id: string; name: string }) => `${s.property_id}::${s.name}`))

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
  return { success: true, created: rowsToInsert.length, skipped }
}

// ── Update Maintenance Template ──────────────────────────────────────────────

export async function updateMaintenanceTemplate(
  templateId: string,
  updates: { name: string; description: string | null }
): Promise<{ error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  if (!['owner', 'admin', 'manager'].includes(membership.role)) {
    return { error: 'Permission denied' }
  }

  const name        = updates.name.trim().slice(0, 100)
  const description = updates.description?.trim().slice(0, 500) ?? null

  if (!name) return { error: 'Name is required' }

  const { data: template } = await supabase
    .from('maintenance_schedule_templates')
    .select('id, is_system')
    .eq('id', templateId)
    .eq('org_id', membership.org_id)
    .single()

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
  return {}
}

// ── Update a per-property maintenance schedule item ───────────────────────────

export async function updateMaintenanceScheduleItem(
  itemId: string,
  updates: {
    name?:              string
    frequency?:         ScheduleFrequency
    next_due_date?:     string | null
    active_from_month?: number | null
    active_to_month?:   number | null
    asset_category?:    string | null
    instructions?:      string | null
    estimated_cost?:    number | null
  }
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { error } = await supabase
      .from('maintenance_schedules')
      .update(updates)
      .eq('id', itemId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[updateMaintenanceScheduleItem]', error)
      return { error: 'Failed to update item' }
    }

    revalidatePath('/maintenance')
    return { success: true }
  } catch (err) {
    console.error('[updateMaintenanceScheduleItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Duplicate a per-property maintenance schedule item ────────────────────────

export async function duplicateMaintenanceScheduleItem(
  itemId:      string,
  nextDueDate: string,
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data: original, error: fetchErr } = await supabase
      .from('maintenance_schedules')
      .select('*')
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .single()

    if (fetchErr || !original) return { error: 'Item not found' }

    const { id: _id, created_at: _ca, updated_at: _ua, ...rest } = original as Record<string, unknown>

    const { error } = await supabase
      .from('maintenance_schedules')
      .insert({
        ...rest,
        next_due_date:             nextDueDate,
        source_template_item_id:   null,
        is_from_standard_template: false,
      })

    if (error) {
      console.error('[duplicateMaintenanceScheduleItem]', error)
      return { error: 'Failed to duplicate item' }
    }

    revalidatePath(`/properties/${original.property_id}`)
    revalidatePath('/maintenance')
    return { success: true }
  } catch (err) {
    console.error('[duplicateMaintenanceScheduleItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Soft-delete a per-property maintenance schedule item ──────────────────────

export async function removeMaintenanceScheduleItem(
  itemId:     string,
  propertyId: string,
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { error } = await supabase
      .from('maintenance_schedules')
      .update({ is_active: false })
      .eq('id', itemId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[removeMaintenanceScheduleItem]', error)
      return { error: 'Failed to remove item' }
    }

    revalidatePath(`/properties/${propertyId}`)
    revalidatePath('/maintenance')
    return { success: true }
  } catch (err) {
    console.error('[removeMaintenanceScheduleItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Add a catalog item to a property ─────────────────────────────────────────

export async function addCatalogItemToProperty(
  propertyId:    string,
  catalogItemId: string,
  nextDueDate:   string,
  recurrence:    ScheduleFrequency,
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data: catalogItem, error: catErr } = await supabase
      .from('maintenance_catalog_items')
      .select('name, asset_category, description')
      .eq('id', catalogItemId)
      .single()

    if (catErr || !catalogItem) return { error: 'Catalog item not found' }

    const { error } = await supabase
      .from('maintenance_schedules')
      .insert({
        property_id:               propertyId,
        org_id:                    membership.org_id,
        name:                      catalogItem.name,
        asset_category:            catalogItem.asset_category ?? null,
        schedule_type:             'routine',
        frequency:                 recurrence,
        next_due_date:             nextDueDate,
        instructions:              catalogItem.description ?? null,
        is_from_standard_template: false,
        source_catalog_item_id:    catalogItemId,
        auto_create_wo:            false,
        is_active:                 true,
      })

    if (error) {
      console.error('[addCatalogItemToProperty]', error)
      return { error: 'Failed to add item' }
    }

    revalidatePath(`/properties/${propertyId}`)
    return { success: true }
  } catch (err) {
    console.error('[addCatalogItemToProperty]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Add a custom maintenance item to a property ───────────────────────────────

export async function addCustomMaintenanceItem(
  propertyId: string,
  item: {
    name:               string
    frequency:          ScheduleFrequency
    next_due_date:      string
    active_from_month?: number | null
    active_to_month?:   number | null
    asset_category?:    string | null
    instructions?:      string | null
    estimated_cost?:    number | null
  },
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { error } = await supabase
      .from('maintenance_schedules')
      .insert({
        property_id:               propertyId,
        org_id:                    membership.org_id,
        schedule_type:             'routine',
        auto_create_wo:            false,
        is_from_standard_template: false,
        is_active:                 true,
        ...item,
      })

    if (error) {
      console.error('[addCustomMaintenanceItem]', error)
      return { error: 'Failed to add item' }
    }

    revalidatePath(`/properties/${propertyId}`)
    return { success: true }
  } catch (err) {
    console.error('[addCustomMaintenanceItem]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Record a maintenance completion and advance next_due_date ─────────────────

export async function recordMaintenanceCompletion(
  scheduleItemId: string,
  input: { notes?: string; work_order_id?: string },
): Promise<{ error?: string; success?: boolean; nextDueDate?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgMember()

    const { data: item, error: fetchErr } = await supabase
      .from('maintenance_schedules')
      .select('property_id, org_id, asset_category, frequency, active_from_month, active_to_month')
      .eq('id', scheduleItemId)
      .eq('org_id', membership.org_id)
      .single()

    if (fetchErr || !item) return { error: 'Maintenance item not found' }

    const today = new Date()
    const next  = new Date(today)
    switch (item.frequency) {
      case 'weekly':      next.setDate(next.getDate() + 7);         break
      case 'biweekly':    next.setDate(next.getDate() + 14);        break
      case 'monthly':     next.setMonth(next.getMonth() + 1);       break
      case 'quarterly':   next.setMonth(next.getMonth() + 3);       break
      case 'semi_annual': next.setMonth(next.getMonth() + 6);       break
      case 'annual':      next.setFullYear(next.getFullYear() + 1); break
    }
    const nextDueDateStr = next.toISOString().split('T')[0]

    const { error: compErr } = await supabase
      .from('maintenance_completions')
      .insert({
        maintenance_schedule_id: scheduleItemId,
        property_id:             item.property_id,
        org_id:                  item.org_id,
        asset_category:          item.asset_category ?? null,
        completed_at:            today.toISOString(),
        completed_by:            user.id,
        notes:                   input.notes ?? null,
        work_order_id:           input.work_order_id ?? null,
        next_due_date_set:       nextDueDateStr,
      })

    if (compErr) {
      console.error('[recordMaintenanceCompletion] insert', compErr)
      return { error: 'Failed to record completion' }
    }

    const { error: updateErr } = await supabase
      .from('maintenance_schedules')
      .update({ next_due_date: nextDueDateStr })
      .eq('id', scheduleItemId)

    if (updateErr) {
      console.error('[recordMaintenanceCompletion] update next_due_date', updateErr)
    }

    revalidatePath(`/properties/${item.property_id}`)
    revalidatePath('/maintenance')
    return { success: true, nextDueDate: nextDueDateStr }
  } catch (err) {
    console.error('[recordMaintenanceCompletion]', err)
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Fetch Completed/Cancelled Work Orders (on demand) ───────────────────────
// The maintenance page query defaults to active-status work orders only
// (see app/(dashboard)/maintenance/page.tsx). This fetches the rest, for the
// "Show completed" toggle in the client board — same select shape as the
// page's initial query.

export async function fetchArchivedWorkOrders() {
  const { supabase, membership } = await requireOrgMember()

  const { data, error } = await supabase
    .from('work_orders')
    .select(`
      id, property_id, vendor_id, assigned_crew_member_id,
      wo_number, title, description, category, priority, status, source,
      scheduled_date, completed_date,
      estimated_cost, nte_amount, actual_cost,
      access_notes, completion_notes, invoice_reference,
      portal_enabled, completion_token,
      vendor_acknowledged_at, vendor_acknowledged_by,
      completion_verified_at, completion_verified_by,
      vendor_dispatch_email,
      created_at, updated_at,
      properties ( name, address, city, state, access_instructions ),
      vendors ( id, name, specialty ),
      work_order_line_items (
        id, line_type, description, quantity, unit,
        unit_cost, line_total, sort_order, created_at
      ),
      work_order_invoices ( id, status )
    `)
    .eq('org_id', membership.org_id)
    .in('status', ['completed', 'cancelled'])
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[fetchArchivedWorkOrders]', error)
    return []
  }

  return data ?? []
}
