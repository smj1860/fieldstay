'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import type { WoStatus, WoCategory, ScheduleFrequency, ScheduleType, VendorSpecialty, TablesUpdate, Enums } from '@/types/database'
import { PriorityLevelSchema, WoStatusSchema, WoCategorySchema } from '@/lib/schemas/work-order'
import {
  resolveWorkOrderStatus,
  sendQuoteRequestEmails,
  checkCrewMemberAssignable,
  checkQuoteVendorsAssignable,
  checkCrewTimeOffWarning,
  dispatchWorkOrderEvents,
} from './create-work-order-helpers'
import {
  COMPLETED_WORK_ORDER_SELECT,
  finalizeWorkOrderCompletion,
  workOrderCompletionFields,
  type CompletedWorkOrderRow,
} from './complete-work-order-helpers'
import {
  isVendorHardBlocked,
  VendorComplianceCheckError,
  VENDOR_HARD_BLOCKED_ERROR,
  VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR,
} from '@/lib/vendors/compliance'
import { toStorageObjectPath } from '@/lib/storage/object-path'

// work-order-photos is a PRIVATE bucket — reads go through short-lived
// signed URLs, never a `/object/public/...` link.
const WORK_ORDER_PHOTO_BUCKET      = 'work-order-photos'
const PHOTO_SIGNED_URL_TTL_SECONDS = 300  // 5 minutes

export type MaintenanceActionState = { error?: string; success?: boolean; workOrderId?: string; templateId?: string; warning?: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoDate() { return new Date().toISOString().split('T')[0] }

// ── Suggestion-override tracking for bulkAssignVendor ───────────────────────
//
// Mirrors app/(dashboard)/turnovers/actions.ts's trackAssignmentAgainstSuggestions,
// built with the override-handling that feature was originally missing
// rather than reproducing the same gap: if a work order had a pending vendor
// suggestion, assigning a different vendor here flips it to 'overridden'
// instead of leaving suggestion_status stuck at 'pending' forever.
async function trackVendorAssignmentAgainstSuggestions(
  orgId:     string,
  vendorId:  string,
  vendorName: string,
  workOrders: { id: string; suggestion_status?: string | null; suggested_vendor_ids?: string[] | null }[]
): Promise<void> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const service = createServiceClient({ system: 'action:maintenance-suggestion-tracking' })

    const overridden = workOrders.filter(wo =>
      wo.suggestion_status === 'pending' &&
      !(wo.suggested_vendor_ids ?? []).includes(vendorId)
    )

    if (overridden.length > 0) {
      // .eq('org_id') is mandatory, not redundant: this is a service-role
      // client, so RLS is not a backstop and an id list that ever reached
      // here from another org would be written unchecked. Its twin
      // trackAssignmentAgainstSuggestions in turnovers/actions.ts got this
      // filter from the CodeRabbit PR #512 review; this copy was missed.
      const { error: overrideError } = await service.from('work_orders')
        .update({ suggestion_status: 'overridden' })
        .eq('org_id', orgId)
        .in('id', overridden.map(wo => wo.id))
      if (overrideError) {
        console.error('[trackVendorAssignmentAgainstSuggestions] override update failed', overrideError)
        reportError(overrideError, { site: 'serverAction.maintenance.trackVendorAssignmentAgainstSuggestions.override', orgId })
      }

      const priorSuggestionRows = overridden.flatMap(wo =>
        (wo.suggested_vendor_ids ?? []).map(suggestedVendorId => ({
          work_order_id:    wo.id,
          org_id:           orgId,
          vendor_id:        suggestedVendorId,
          was_accepted:     false,
          override_reason:  `${vendorName} assigned instead of the suggestion`,
        }))
      )
      if (priorSuggestionRows.length > 0) {
        const { error: priorError } = await service.from('vendor_assignment_outcomes').upsert(priorSuggestionRows, {
          onConflict:       'work_order_id,vendor_id',
          ignoreDuplicates: false,
        })
        if (priorError) {
          console.error('[trackVendorAssignmentAgainstSuggestions] prior-suggestion upsert failed', priorError)
          reportError(priorError, { site: 'serverAction.maintenance.trackVendorAssignmentAgainstSuggestions.prior', orgId })
        }
      }
    }

    // Ensure an outcome row exists for whoever is actually assigned, whether
    // or not they were the suggestion.
    const ensureRows = workOrders.map(wo => ({
      work_order_id:  wo.id,
      org_id:         orgId,
      vendor_id:      vendorId,
      was_suggestion: (wo.suggested_vendor_ids ?? []).includes(vendorId),
    }))
    const { error: ensureError } = await service.from('vendor_assignment_outcomes').upsert(ensureRows, {
      onConflict:       'work_order_id,vendor_id',
      ignoreDuplicates: true,  // don't clobber a row the suggestion algorithm already scored
    })
    if (ensureError) {
      console.error('[trackVendorAssignmentAgainstSuggestions] ensure upsert failed', ensureError)
      reportError(ensureError, { site: 'serverAction.maintenance.trackVendorAssignmentAgainstSuggestions.ensure', orgId })
    }
  } catch (err) {
    // Suggestion-state/outcome tracking must never break the actual assignment
    console.error('[trackVendorAssignmentAgainstSuggestions]', err)
    reportError(err, { site: 'serverAction.maintenance.trackVendorAssignmentAgainstSuggestions', orgId })
  }
}

// ── Create Work Order ────────────────────────────────────────────────────────

export async function createWorkOrder(
  _prev: MaintenanceActionState | null,
  formData: FormData
): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const title                  = (formData.get('title') as string)?.trim()
    const property_id            = formData.get('property_id') as string
    const description            = (formData.get('description') as string)?.trim() || null
    const priorityInput          = (formData.get('priority') as string) || 'medium'
    const priority               = PriorityLevelSchema.safeParse(priorityInput).data ?? 'medium'
    const categoryInput          = (formData.get('category') as string) || null
    const category               = categoryInput ? (WoCategorySchema.safeParse(categoryInput).data ?? null) : null
    const vendor_id               = (formData.get('vendor_id') as string) || null
    const assigned_crew_member_id = (formData.get('assigned_crew_member_id') as string) || null
    const scheduled_date         = (formData.get('scheduled_date') as string) || null
    const scheduled_time         = (formData.get('scheduled_time') as string) || null
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

    if (vendor_id && !request_quotes && await isVendorHardBlocked(supabase, vendor_id, membership.org_id)) {
      return { error: VENDOR_HARD_BLOCKED_ERROR }
    }

    // Quote mode dispatches to `quote_vendor_ids` instead of `vendor_id`, and
    // used to skip both the in-org check and the compliance gate entirely.
    const quoteVendorProblem = request_quotes
      ? await checkQuoteVendorsAssignable(supabase, membership.org_id, quote_vendor_ids)
      : null
    if (quoteVendorProblem) return quoteVendorProblem

    // TENANT ISOLATION: assigned_crew_member_id arrives from the client and was
    // written unverified. work_orders_select grants read on an OR'd branch
    // keyed by that column, so a foreign org's crew id here handed the other
    // tenant's crew user read access to this work order.
    const crewProblem = await checkCrewMemberAssignable(
      supabase, membership.org_id, assigned_crew_member_id,
    )
    if (crewProblem) return crewProblem

    // In quote-request mode, WO starts as quote_requested with no vendor assigned yet
    const woStatus            = resolveWorkOrderStatus(request_quotes, vendor_id)
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
        category,
        priority,
        status:                  woStatus,
        source:                  'manual',
        scheduled_date:          scheduled_date || null,
        scheduled_time:          scheduled_time || null,
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
      await sendQuoteRequestEmails(supabase, wo.id, property_id, membership.org_id, quote_vendor_ids)

      revalidatePath('/maintenance')
      redirect(`/maintenance/${wo.id}`)
    }

    await dispatchWorkOrderEvents({
      workOrderId:          wo.id,
      propertyId:           property_id,
      orgId:                membership.org_id,
      vendorId:             vendor_id,
      usePortal,
      requestQuotes:        request_quotes,
      category,
      assignedCrewMemberId: assigned_crew_member_id,
    })

    // Warn the PM when a vendor was assigned but no notification will be
    // sent — otherwise they're left assuming the vendor was notified.
    // The crew-time-off warning below overrides this if both apply.
    let warning: string | undefined
    if (vendor_id && !usePortal) {
      warning = 'Work order created, but the vendor was not notified because the portal link is disabled for this vendor. Enable the portal in Vendor settings or notify them manually.'
    }
    warning = (await checkCrewTimeOffWarning(supabase, membership.org_id, assigned_crew_member_id, scheduled_date)) ?? warning

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'work_order.created',
      targetType: 'work_order',
      targetId:   wo.id,
      metadata:   { title, property_id, priority, source: 'manual' },
    })

    revalidatePath('/maintenance')
    return { success: true, workOrderId: wo.id, warning }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[createWorkOrder]', err)
    reportError(err, { site: 'serverAction.maintenance.createWorkOrder' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Rate Work Order Vendor ────────────────────────────────────────────────────

export async function rateWorkOrderVendor(
  workOrderId: string,
  rating: 1 | 2 | 3 | 4 | 5,
  ratingNotes: string | null
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
  } catch (err) {
    console.error('[rateWorkOrderVendor]', err)
    reportError(err, { site: 'serverAction.maintenance.rateWorkOrderVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Assign Crew to Work Order ─────────────────────────────────────────────────

export async function assignCrewToWorkOrder(
  workOrderId: string,
  crewMemberId: string | null
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // Same tenant-isolation check as createWorkOrder: the .eq('org_id') below
    // scopes the WORK ORDER to this org, but nothing scoped the CREW ID being
    // written into it, and that column is what the RLS read policy keys its
    // second branch on.
    const crewProblem = await checkCrewMemberAssignable(supabase, membership.org_id, crewMemberId)
    if (crewProblem) return crewProblem

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
  } catch (err) {
    console.error('[assignCrewToWorkOrder]', err)
    reportError(err, { site: 'serverAction.maintenance.assignCrewToWorkOrder' })
    return { error: 'Operation failed. Please try again.' }
  }
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
    scheduled_time:  string | null
    estimated_cost:  number | null
    portal_enabled:  boolean
  }
): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

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

    if (
      newVendorId &&
      newVendorId !== previousVendorId &&
      await isVendorHardBlocked(supabase, newVendorId, membership.org_id)
    ) {
      return { error: VENDOR_HARD_BLOCKED_ERROR }
    }

    const { error } = await supabase
      .from('work_orders')
      .update({
        title:          data.title,
        description:    data.description || null,
        priority,
        vendor_id:      newVendorId,
        scheduled_date: data.scheduled_date || null,
        scheduled_time: data.scheduled_time || null,
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
  } catch (err) {
    console.error('[updateWorkOrder]', err)
    reportError(err, { site: 'serverAction.maintenance.updateWorkOrder' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Add Work Order Note ──────────────────────────────────────────────────────

export async function addWorkOrderNote(
  workOrderId: string,
  note: string
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
  } catch (err) {
    console.error('[addWorkOrderNote]', err)
    reportError(err, { site: 'serverAction.maintenance.addWorkOrderNote' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Update Work Order Status ─────────────────────────────────────────────────

export async function updateWorkOrderStatus(
  workOrderId: string,
  status: WoStatus,
  notes?: string
): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: current } = await supabase
      .from('work_orders')
      .select('status, source_schedule_id, source, actual_cost, estimated_cost, title, property_id, vendor_id')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    if (!current) return { error: 'Work order not found' }

    // Already completed (e.g. double-click or retried request) — no-op rather
    // than re-firing work-order/completed and double-advancing its schedule.
    if (current.status === 'completed') return { success: true }

    // Vendor-assigned work orders must be completed through the vendor's own
    // portal (line items → invoice → Stripe Connect payout) — completing it
    // here would leave no invoice and no payment path.
    if (status === 'completed' && current.vendor_id) {
      return { error: 'This work order is assigned to a vendor — it must be completed through the vendor portal so the invoice and payment can be generated.' }
    }

    const update: TablesUpdate<'work_orders'> = status === 'completed'
      ? workOrderCompletionFields(notes ?? null)
      : { status }

    // Completing is guarded by the WHERE clause as well as by the read above:
    // .neq('status', 'completed') makes exactly one of two racing UPDATEs
    // match a row, so the loser gets `updated === null` and does not re-fire
    // the completion fan-out.
    let query = supabase
      .from('work_orders')
      .update(update)
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
    if (status === 'completed') query = query.neq('status', 'completed')

    const { data: updated, error } = await query.select(COMPLETED_WORK_ORDER_SELECT).maybeSingle()

    if (error) {
      console.error('[updateWorkOrderStatus]', error)
      reportError(error, { site: 'serverAction.maintenance.updateWorkOrderStatus.update', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    if (status === 'completed') {
      // Every completion side effect — the work-order/completed event that
      // posts the owner_transactions expense, the work_order_updates row, and
      // the source maintenance-schedule advance — lives in ONE helper shared
      // with bulkUpdateWorkOrderStatus and markWorkVerified.
      if (updated) {
        await finalizeWorkOrderCompletion(
          supabase,
          membership.org_id,
          [updated as CompletedWorkOrderRow],
          {
            statusFromById: new Map([[workOrderId, current.status as WoStatus]]),
            notes:          notes ?? null,
          },
        )
      }
    } else {
      await supabase.from('work_order_updates').insert({
        work_order_id:             workOrderId,
        org_id:                    membership.org_id,
        updated_via_vendor_portal: false,
        status_from:               current.status as WoStatus,
        status_to:                 status,
        notes:                     notes ?? null,
      })
    }

    revalidatePath('/maintenance')
    revalidatePath(`/maintenance/${workOrderId}`)
    return { success: true }
  } catch (err) {
    console.error('[updateWorkOrderStatus]', err)
    reportError(err, { site: 'serverAction.maintenance.updateWorkOrderStatus' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// Feature 4 (advance the source schedule after a WO completion) now lives in
// ./complete-work-order-helpers.ts, alongside the rest of the completion side
// effects, so all three completion paths get it.

// ── Feature 2: Log actual cost (PM-side) ─────────────────────────────────────

export async function logActualCost(
  workOrderId: string,
  data: { actual_cost: number; invoice_reference?: string }
): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const { data: wo } = await supabase
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
      notes:                     `Actual cost logged: $${data.actual_cost.toFixed(2)}${data.invoice_reference ? ' (Invoice: ' + data.invoice_reference + ')' : ''}`,
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
    })

    revalidatePath(`/maintenance/${workOrderId}`)
    revalidatePath('/maintenance')
    return {}
  } catch (err) {
    console.error('[logActualCost]', err)
    reportError(err, { site: 'serverAction.maintenance.logActualCost' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Feature 1: Upload work order photo (record after client-side upload) ──────

export async function recordWorkOrderPhoto(
  workOrderId: string,
  storagePath: string
): Promise<{ error?: string }> {
  try {
    // org scoping enforced by RLS's WITH CHECK on work_order_photos_insert
    const { supabase } = await requireOrgRole(['admin', 'manager'])

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
  } catch (err) {
    console.error('[recordWorkOrderPhoto]', err)
    reportError(err, { site: 'serverAction.maintenance.recordWorkOrderPhoto' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Mints short-lived signed URLs for a work order's photos.
 *
 * `work-order-photos` is a PRIVATE bucket: there is no public URL to build,
 * and the RLS SELECT policy only sees objects whose first path segment is the
 * caller's org — which legacy `wo-<id>/…` objects predate. Both problems are
 * solved the same way: authorize here (org membership + the work order really
 * belongs to that org), then sign with the service client so a legacy path
 * resolves too instead of 404-ing on the PM.
 */
export async function getWorkOrderPhotoUrls(
  workOrderId: string
): Promise<{ urls?: Record<string, string>; error?: string }> {
  try {
    const { supabase, membership } = await requireOrgMember()

    // IDOR gate — membership proves an org, not THIS work order.
    //
    // The error is read, not just the data: collapsing "the query failed" into
    // the same 'Work order not found' the zero-rows case returns would show a
    // PM a confident denial for a work order that exists, and hide a real
    // outage behind what reads as a normal empty state. PGRST116 IS the
    // zero-rows case for .single(), so it stays on the not-found path.
    const { data: wo, error: woErr } = await supabase
      .from('work_orders')
      .select('id')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    if (woErr && woErr.code !== 'PGRST116') {
      console.error('[getWorkOrderPhotoUrls] work order lookup', woErr)
      return { error: 'Could not load photos. Please try again.' }
    }
    if (!wo) return { error: 'Work order not found' }

    const { data: photos, error: photosErr } = await supabase
      .from('work_order_photos')
      .select('id, storage_path')
      .eq('work_order_id', workOrderId)

    if (photosErr) {
      console.error('[getWorkOrderPhotoUrls]', photosErr)
      return { error: 'Could not load photos. Please try again.' }
    }
    if (!photos?.length) return { urls: {} }

    const { createServiceClient } = await import('@/lib/supabase/server')
    const service = createServiceClient({ authorizedBy: membership })

    // Drop unresolvable rows BEFORE signing so the response array still lines
    // up index-for-index with `signable` (createSignedUrls preserves order).
    const signable = photos.flatMap((photo) => {
      const path = toStorageObjectPath(WORK_ORDER_PHOTO_BUCKET, photo.storage_path)
      return path ? [{ id: photo.id, path }] : []
    })
    if (!signable.length) return { urls: {} }

    const { data: signed, error: signErr } = await service.storage
      .from(WORK_ORDER_PHOTO_BUCKET)
      .createSignedUrls(signable.map((p) => p.path), PHOTO_SIGNED_URL_TTL_SECONDS)

    if (signErr) {
      console.error('[getWorkOrderPhotoUrls]', signErr)
      return { error: 'Could not load photos. Please try again.' }
    }

    // createSignedUrls() reports per-object errors inline, so a single missing
    // object degrades to one broken thumbnail rather than an empty gallery.
    const urls: Record<string, string> = {}
    signable.forEach((photo, i) => {
      const signedUrl = signed?.[i]?.signedUrl
      if (signedUrl) urls[photo.id] = signedUrl
    })

    return { urls }
  } catch (err) {
    console.error('[getWorkOrderPhotoUrls]', err)
    reportError(err, { site: 'serverAction.maintenance.getWorkOrderPhotoUrls' })
    return { error: 'Could not load photos. Please try again.' }
  }
}

export async function deleteWorkOrderPhoto(photoId: string): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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

    // Delete from storage with the SERVICE client, not the caller's.
    // The storage DELETE policy only matches objects whose first path segment
    // is the caller's org id; legacy `wo-<id>/…` objects predate that
    // contract, so an RLS-scoped remove() would silently no-op on them and
    // leave the file behind after its row was deleted. The org ownership
    // check above is what authorizes this.
    const { createServiceClient } = await import('@/lib/supabase/server')
    const service = createServiceClient({ authorizedBy: membership })
    const objectPath = toStorageObjectPath(WORK_ORDER_PHOTO_BUCKET, photo.storage_path)
    if (objectPath) {
      const { error: removeErr } = await service.storage.from(WORK_ORDER_PHOTO_BUCKET).remove([objectPath])
      if (removeErr) console.error('[deleteWorkOrderPhoto] storage remove failed', removeErr)
    }

    // Delete record
    await supabase.from('work_order_photos').delete().eq('id', photoId)

    revalidatePath(`/maintenance/${photo.work_order_id}`)
    return {}
  } catch (err) {
    console.error('[deleteWorkOrderPhoto]', err)
    reportError(err, { site: 'serverAction.maintenance.deleteWorkOrderPhoto' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Send quote requests to multiple vendors ───────────────────────────────────

export async function sendQuoteRequests(
  workOrderId: string,
  vendorIds: string[]
): Promise<{ error?: string; sent: number }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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

    // This action validated the work order but never the vendor ids — neither
    // that they belong to the caller's org nor that they are compliance-clear.
    const vendorProblem = await checkQuoteVendorsAssignable(supabase, membership.org_id, vendorIds)
    if (vendorProblem) return { ...vendorProblem, sent: 0 }

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

    const results = await Promise.all(
      toSend.map(async (vendorId) => {
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

        if (error || !qr) return false

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

        return true
      })
    )

    const sent = results.filter(Boolean).length

    revalidatePath(`/maintenance/${workOrderId}`)
    revalidatePath('/maintenance')
    return { sent }
  } catch (err) {
    console.error('[sendQuoteRequests]', err)
    reportError(err, { site: 'serverAction.maintenance.sendQuoteRequests' })
    return { error: 'Operation failed. Please try again.', sent: 0 }
  }
}

// ── Approve one quote — assign WO, decline all others ────────────────────────

/** Return shape of the `approve_quote_request(uuid, uuid, text, timestamptz)` RPC. */
type ApproveQuoteResult =
  | { ok: true;  work_order_id: string; vendor_id: string; quoted_amount: number | null; declined: number }
  | { ok: false; reason: 'quote_not_found' | 'not_submitted' | 'work_order_not_found' | 'work_order_not_assignable' }

export async function approveQuoteRequest(
  quoteRequestId: string
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: qr } = await supabase
      .from('quote_requests')
      .select('id, work_order_id, vendor_id, quoted_amount, status, org_id')
      .eq('id', quoteRequestId)
      .eq('org_id', membership.org_id)
      .single()

    if (!qr) return { error: 'Quote request not found' }

    // Approval is the point where the vendor is actually assigned
    // (portal_enabled + a completion token), and it never checked compliance
    // at all — so an RFQ sent before a COI lapsed could still be approved into
    // a live dispatch 46+ days later. Checked BEFORE the atomic claim below so
    // a blocked vendor doesn't leave the quote stuck in 'approved' with the
    // work order unassigned. isVendorHardBlocked fails closed (throws) — that
    // must block, not fall through to the generic catch as a pass.
    try {
      if (await isVendorHardBlocked(supabase, qr.vendor_id, membership.org_id)) {
        return { error: VENDOR_HARD_BLOCKED_ERROR }
      }
    } catch (complianceErr) {
      if (complianceErr instanceof VendorComplianceCheckError) {
        return { error: VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR }
      }
      throw complianceErr
    }

    // ONE transaction: claim the quote, decline its siblings, assign the
    // vendor, log the change. Previously these were four sequential writes
    // with no way back — a failure on the work-order UPDATE left the winning
    // quote 'approved', every competing quote 'declined', and the work order
    // still UNASSIGNED with no live RFQ left to approve. Nothing in the UI
    // explained it and the PM's only option was to re-request quotes from
    // scratch. The function locks both parent rows before its first write, so
    // the cases that cannot proceed are refused while nothing has changed.
    const completion_token            = crypto.randomUUID()
    const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: rpcResult, error: rpcError } = await supabase.rpc('approve_quote_request', {
      p_quote_request_id: quoteRequestId,
      p_org_id:           membership.org_id,
      p_completion_token: completion_token,
      p_token_expires_at: completion_token_expires_at,
    })

    if (rpcError || !rpcResult) {
      console.error('[approveQuoteRequest]', rpcError)
      reportError(rpcError ?? new Error('approve_quote_request returned no result'), {
        site: 'serverAction.maintenance.approveQuoteRequest.rpc', orgId: membership.org_id,
      })
      return { error: 'Operation failed. Please try again.' }
    }

    const result = rpcResult as ApproveQuoteResult

    if (!result.ok) {
      if (result.reason === 'work_order_not_found') {
        return { error: 'The work order for this quote no longer exists.' }
      }
      // The RPC refuses to resurrect a cancelled or completed work order. Say
      // so — falling through to the "not submitted by the vendor" message
      // below would describe the wrong thing entirely.
      if (result.reason === 'work_order_not_assignable') {
        return { error: 'That work order is already completed or cancelled, so a quote can no longer be approved against it.' }
      }
      return { error: 'Can only approve a quote that has been submitted by the vendor' }
    }

    // From the RPC's return, not the pre-read: these are the ids the
    // transaction actually committed against.
    await inngest.send({
      name: 'work-order/created',
      data: {
        work_order_id:  result.work_order_id,
        property_id:    '',
        org_id:         membership.org_id,
        vendor_id:      result.vendor_id,
        portal_enabled: true,
      },
    })

    revalidatePath(`/maintenance/${result.work_order_id}`)
    revalidatePath('/maintenance')
    return {}
  } catch (err) {
    console.error('[approveQuoteRequest]', err)
    reportError(err, { site: 'serverAction.maintenance.approveQuoteRequest' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Decline a single quote request ────────────────────────────────────────────

export async function declineQuoteRequest(
  quoteRequestId: string
): Promise<{ error?: string }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
  } catch (err) {
    console.error('[declineQuoteRequest]', err)
    reportError(err, { site: 'serverAction.maintenance.declineQuoteRequest' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Delete (cancel) Work Order ───────────────────────────────────────────────

export async function deleteWorkOrder(workOrderId: string): Promise<void> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

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
  } catch (err) {
    console.error('[deleteWorkOrder]', err)
    reportError(err, { site: 'serverAction.maintenance.deleteWorkOrder' })
    throw err
  }
}

// ── Create Work Order from Schedule ─────────────────────────────────────────

/**
 * Vendor selection chain for a schedule-created WO: explicitly assigned
 * vendor → best-rated active vendor matching the specialty hint → nobody.
 *
 * A hard-blocked vendor is not a valid resolution — it falls through as if the
 * chain found no one, so the WO lands in the vendor-suggestion flow instead of
 * silently assigning someone 31+ days out of compliance. Mirrors
 * resolveScheduleVendor() in lib/inngest/functions/cron/work-order-ops.ts so
 * the manual "Create Work Order Now" button resolves a vendor exactly the way
 * the nightly automation does.
 */
async function resolveVendorForSchedule(
  supabase: Awaited<ReturnType<typeof requireOrgRole>>['supabase'],
  orgId:    string,
  schedule: { assigned_vendor_id: string | null; vendor_specialty_hint: Enums<'vendor_specialty'> | null },
): Promise<string | null> {
  let vendorId: string | null = schedule.assigned_vendor_id ?? null

  if (!vendorId && schedule.vendor_specialty_hint) {
    const { data: hintVendor } = await supabase
      .from('vendors')
      .select('id')
      .eq('org_id', orgId)
      .eq('specialty', schedule.vendor_specialty_hint)
      .eq('is_active', true)
      .order('avg_rating', { ascending: false })
      .limit(1)
      .maybeSingle()
    vendorId = hintVendor?.id ?? null
  }

  if (!vendorId) return null

  return (await isVendorHardBlocked(supabase, vendorId, orgId)) ? null : vendorId
}

export async function createWorkOrderFromSchedule(
  scheduleId: string
): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: schedule } = await supabase
      .from('maintenance_schedules')
      .select('*')
      .eq('id', scheduleId)
      .eq('org_id', membership.org_id)
      .single()

    if (!schedule) return { error: 'Schedule not found' }

    // next_due_date is nullable — a schedule with no due date has no date to
    // create (or de-duplicate) a work order against.
    const scheduledDate = schedule.next_due_date
    if (!scheduledDate) return { error: 'This schedule has no next due date yet.' }

    // Idempotency: skip if an open WO already exists for this schedule + date —
    // mirrors the auto-create check in the maintenance-schedule cron, so a
    // double-click on "Create Work Order Now" doesn't create a duplicate while
    // still allowing the next cycle's WO once this one is completed/cancelled.
    const { data: existingWO } = await supabase
      .from('work_orders')
      .select('id')
      .eq('source_schedule_id', scheduleId)
      .eq('scheduled_date', scheduledDate)
      .not('status', 'in', '("completed","cancelled")')
      .maybeSingle()

    if (existingWO) return { success: true }

    const vendorId = await resolveVendorForSchedule(supabase, membership.org_id, schedule)

    // vendor_specialty_hint values are a subset of WoCategory, so this is a
    // safe direct cast — the closest thing a maintenance schedule has to a
    // WO category, and needed for vendor suggestions to have anything to
    // match a vendor's specialty against.
    const category = (schedule.vendor_specialty_hint as WoCategory | null) ?? null

    const completion_token = crypto.randomUUID()
    const completion_token_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: wo, error } = await supabase
      .from('work_orders')
      .insert({
        property_id:        schedule.property_id,
        org_id:             membership.org_id,
        vendor_id:          vendorId,
        category,
        title:              schedule.name,
        description:        schedule.description,
        priority:           PriorityLevelSchema.parse('medium'),
        status:             WoStatusSchema.parse(vendorId ? 'assigned' : 'pending'),
        source:             'maintenance_schedule',
        source_schedule_id: schedule.id,
        scheduled_date:     scheduledDate,
        estimated_cost:     schedule.estimated_cost,
        portal_enabled:     !!vendorId,
        completion_token:   vendorId ? completion_token : null,
        completion_token_expires_at: vendorId ? completion_token_expires_at : null,
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

    if (vendorId) {
      await inngest.send({
        name: 'work-order/created',
        data: {
          work_order_id:  wo.id,
          property_id:    schedule.property_id,
          org_id:         membership.org_id,
          vendor_id:      vendorId,
          portal_enabled: true,
        },
      })
    } else if (category) {
      await inngest.send({
        name: 'work-order/vendor-suggestion.requested',
        data: {
          work_order_id: wo.id,
          property_id:   schedule.property_id,
          org_id:        membership.org_id,
          category,
        },
      })
    }

    revalidatePath('/maintenance')
    return { success: true }
  } catch (err) {
    console.error('[createWorkOrderFromSchedule]', err)
    reportError(err, { site: 'serverAction.maintenance.createWorkOrderFromSchedule' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Bulk Work Order Actions ──────────────────────────────────────────────────

export async function bulkAssignVendor(
  workOrderIds: string[],
  vendorId: string
): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const { data: vendor } = await supabase
      .from('vendors')
      .select('id, name')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .single()

    if (!vendor) return { error: 'Vendor not found' }

    if (await isVendorHardBlocked(supabase, vendorId, membership.org_id)) {
      return { error: VENDOR_HARD_BLOCKED_ERROR }
    }

    const { data: workOrders } = await supabase
      .from('work_orders')
      .select('id, suggestion_status, suggested_vendor_ids')
      .in('id', workOrderIds)
      .eq('org_id', membership.org_id)

    const { error } = await supabase
      .from('work_orders')
      .update({ vendor_id: vendorId, assigned_crew_member_id: null })
      .in('id', workOrderIds)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[bulkAssignVendor]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    if (workOrders?.length) {
      await trackVendorAssignmentAgainstSuggestions(membership.org_id, vendorId, vendor.name, workOrders)
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
  } catch (err) {
    console.error('[bulkAssignVendor]', err)
    reportError(err, { site: 'serverAction.maintenance.bulkAssignVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Accept auto-suggested vendor ─────────────────────────────────────────────

export async function acceptVendorSuggestion(workOrderId: string): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const { data: wo } = await supabase
      .from('work_orders')
      .select('id, suggested_vendor_ids')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    if (!wo) return { error: 'Work order not found' }

    const vendorId = (wo.suggested_vendor_ids as string[] | null)?.[0]
    if (!vendorId) return { error: 'No suggestion to accept' }

    if (await isVendorHardBlocked(supabase, vendorId, membership.org_id)) {
      return { error: VENDOR_HARD_BLOCKED_ERROR }
    }

    const { error } = await supabase
      .from('work_orders')
      .update({ vendor_id: vendorId, status: 'assigned', suggestion_status: 'accepted' })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[acceptVendorSuggestion]', error)
      return { error: 'Failed to accept suggestion. Please try again.' }
    }

    try {
      const { createServiceClient } = await import('@/lib/supabase/server')
      const service = createServiceClient({ system: 'action:maintenance-suggestion-tracking' })
      await service.from('vendor_assignment_outcomes').upsert(
        { work_order_id: workOrderId, org_id: membership.org_id, vendor_id: vendorId, was_accepted: true, was_suggestion: true },
        { onConflict: 'work_order_id,vendor_id', ignoreDuplicates: false }
      )
    } catch (err) {
      // Outcome recording must not break the acceptance flow — but the failure
      // still needs to be visible, or the vendor-score learning loop silently
      // starves with zero operator signal.
      console.error('[acceptVendorSuggestion] outcome recording failed:', err)
      reportError(err, { site: 'serverAction.maintenance.acceptVendorSuggestion', orgId: membership.org_id })
    }

    // Dispatch is gated inside this handler on the WO's own portal_enabled
    // flag — the PM's per-WO decision, unaffected by whether a vendor was
    // suggested or manually picked.
    await inngest.send({
      name: 'work-order/vendor.assigned',
      data: { workOrderId, orgId: membership.org_id, vendorId, previousVendorId: null },
    })

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'work_order.suggestion.accepted',
      targetType: 'work_order',
      targetId:   workOrderId,
      metadata:   { vendor_id: vendorId },
    })

    revalidatePath('/maintenance')
    return {}
  } catch (err) {
    console.error('[acceptVendorSuggestion]', err)
    reportError(err, { site: 'serverAction.maintenance.acceptVendorSuggestion' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Dismiss auto-suggested vendor ────────────────────────────────────────────

export async function dismissVendorSuggestion(workOrderId: string): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const { data: wo } = await supabase
      .from('work_orders')
      .select('suggested_vendor_ids')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .single()

    const { error } = await supabase
      .from('work_orders')
      .update({ suggestion_status: 'dismissed' })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)

    if (error) {
      console.error('[dismissVendorSuggestion]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    const vendorId = (wo?.suggested_vendor_ids as string[] | null)?.[0]
    if (vendorId) {
      try {
        const { createServiceClient } = await import('@/lib/supabase/server')
        const service = createServiceClient({ system: 'action:maintenance-suggestion-tracking' })
        await service.from('vendor_assignment_outcomes').upsert(
          { work_order_id: workOrderId, org_id: membership.org_id, vendor_id: vendorId, was_accepted: false, was_suggestion: true },
          { onConflict: 'work_order_id,vendor_id', ignoreDuplicates: false }
        )
      } catch (err) {
        // Outcome recording must not break the dismissal flow — but the
        // failure still needs to be visible, or the vendor-score learning
        // loop silently starves with zero operator signal.
        console.error('[dismissVendorSuggestion] outcome recording failed:', err)
        reportError(err, { site: 'serverAction.maintenance.dismissVendorSuggestion', orgId: membership.org_id })
      }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'work_order.suggestion.dismissed',
      targetType: 'work_order',
      targetId:   workOrderId,
      metadata:   { vendor_id: vendorId ?? null },
    })

    revalidatePath('/maintenance')
    return {}
  } catch (err) {
    console.error('[dismissVendorSuggestion]', err)
    reportError(err, { site: 'serverAction.maintenance.dismissVendorSuggestion' })
    return { error: 'Operation failed. Please try again.' }
  }
}

/**
 * Vendor-assigned work orders must be completed through the vendor's own
 * portal (line items → invoice → Stripe Connect payout) — bulk-completing them
 * here would leave no invoice and no payment path. Split the target set
 * instead of failing the whole batch, so any crew/unassigned WOs in the same
 * selection still go through. Also carries each WO's prior status out for the
 * work_order_updates row the completion helper writes.
 */
async function splitVendorAssignedWorkOrders(
  supabase:     Awaited<ReturnType<typeof requireOrgRole>>['supabase'],
  orgId:        string,
  workOrderIds: string[],
): Promise<{ targetIds: string[]; skippedCount: number; statusFromById: Map<string, WoStatus | null> }> {
  // Paginated AND throwing, both deliberately. This read is what decides which
  // work orders are vendor-assigned and must therefore NOT be completed here —
  // vendor work has to go through the vendor portal, which is what generates
  // the invoice and the Stripe Connect payout.
  //
  // Discarding the error made that decision FAIL OPEN: a failed read left
  // `rows` null, so vendorAssignedIds came back empty, every selected work
  // order looked unassigned, and the bulk action completed the vendor ones too
  // — marking vendor work done with no invoice and no way to pay for it. And a
  // truncated read (the .in() list is a bulk selection, which can exceed
  // max_rows) fails open the same way for everything past row 1000.
  //
  // fetchAllRows throws on a query error, so the caller aborts instead of
  // silently completing the wrong set.
  const rows = await fetchAllRows<{ id: string; vendor_id: string | null; status: string | null }>(
    (from, to) => supabase
      .from('work_orders')
      .select('id, vendor_id, status')
      .in('id', workOrderIds)
      .eq('org_id', orgId)
      .order('id')
      .range(from, to),
    { label: 'maintenance.splitVendorAssignedWorkOrders' },
  )

  const vendorAssignedIds = new Set(rows.filter((r) => r.vendor_id).map((r) => r.id))
  const statusFromById    = new Map<string, WoStatus | null>(
    rows.map((r) => [r.id, (r.status ?? null) as WoStatus | null])
  )

  return {
    targetIds:    workOrderIds.filter((id) => !vendorAssignedIds.has(id)),
    skippedCount: vendorAssignedIds.size,
    statusFromById,
  }
}

export async function bulkUpdateWorkOrderStatus(
  workOrderIds: string[],
  status: WoStatus
): Promise<{ error?: string; warning?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const isCompleting = status === 'completed'

    const { targetIds, skippedCount, statusFromById } = isCompleting
      ? await splitVendorAssignedWorkOrders(supabase, membership.org_id, workOrderIds)
      : { targetIds: workOrderIds, skippedCount: 0, statusFromById: new Map<string, WoStatus | null>() }

    if (targetIds.length === 0) {
      return skippedCount > 0
        ? { error: `${skippedCount} work order${skippedCount !== 1 ? 's are' : ' is'} assigned to a vendor — complete ${skippedCount !== 1 ? 'them' : 'it'} through the vendor portal instead.` }
        : {}
    }

    // Same completion payload the single-WO path writes — bulk previously set
    // `status` alone, leaving completed_date NULL on every bulk-completed WO.
    const update = isCompleting ? workOrderCompletionFields() : { status }

    // `.neq('status', 'completed')` + selecting the claimed rows back is what
    // makes the fan-out below fire exactly once per work order even if two
    // bulk completions race — never off a pre-read that both would have seen.
    let query = supabase
      .from('work_orders')
      .update(update)
      .in('id', targetIds)
      .eq('org_id', membership.org_id)
    if (isCompleting) query = query.neq('status', 'completed')

    const { data: updatedRows, error } = await query.select(COMPLETED_WORK_ORDER_SELECT)

    if (error) {
      console.error('[bulkUpdateWorkOrderStatus]', error)
      reportError(error, { site: 'serverAction.maintenance.bulkUpdateWorkOrderStatus.update', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }

    // The completion fan-out the bulk path never had: without this a PM who
    // bulk-completes ten recurring WOs at month end gets an owner P&L short
    // ten maintenance expenses, and ten source schedules stuck on their old
    // next_due_date so the cron re-creates the same work orders.
    if (isCompleting && updatedRows?.length) {
      await finalizeWorkOrderCompletion(
        supabase,
        membership.org_id,
        updatedRows as CompletedWorkOrderRow[],
        { statusFromById, updatedByUserId: user.id },
      )
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'work_order.bulk_status_changed',
      targetType: 'work_order',
      metadata:   { workOrderIds: targetIds, status },
    })

    revalidatePath('/maintenance')
    return skippedCount > 0
      ? { warning: `${skippedCount} vendor-assigned work order${skippedCount !== 1 ? 's were' : ' was'} skipped — complete ${skippedCount !== 1 ? 'them' : 'it'} through the vendor portal instead.` }
      : {}
  } catch (err) {
    console.error('[bulkUpdateWorkOrderStatus]', err)
    reportError(err, { site: 'serverAction.maintenance.bulkUpdateWorkOrderStatus' })
    return { error: 'Operation failed. Please try again.' }
  }
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
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
    revalidatePath('/templates/maintenance/schedules')
    return { success: true }
  } catch (err) {
    console.error('[createMaintenanceSchedule]', err)
    reportError(err, { site: 'serverAction.maintenance.createMaintenanceSchedule' })
    return { error: 'Operation failed. Please try again.' }
  }
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
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
    revalidatePath('/templates/maintenance/schedules')
    return { success: true }
  } catch (err) {
    console.error('[updateMaintenanceSchedule]', err)
    reportError(err, { site: 'serverAction.maintenance.updateMaintenanceSchedule' })
    return { error: 'Operation failed. Please try again.' }
  }
}

export async function deleteMaintenanceSchedule(
  scheduleId: string
): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
    revalidatePath('/templates/maintenance/schedules')
    return { success: true }
  } catch (err) {
    console.error('[deleteMaintenanceSchedule]', err)
    reportError(err, { site: 'serverAction.maintenance.deleteMaintenanceSchedule' })
    return { error: 'Operation failed. Please try again.' }
  }
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
export async function broadcastMaintenanceTemplate(
  templateId:         string,
  propertyIds:        string[],
  nextDueDates:       Record<string, string>          = {},
  recurrenceOverrides: Record<string, ScheduleFrequency> = {},
): Promise<BroadcastResult> {
  try {
    const { supabase, user, membership } = await requireOrgRole(['admin', 'manager'])

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
    revalidatePath('/templates/maintenance/saved')
    return {}
  } catch (err) {
    console.error('[updateMaintenanceTemplate]', err)
    reportError(err, { site: 'serverAction.maintenance.updateMaintenanceTemplate' })
    return { error: 'Operation failed. Please try again.' }
  }
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
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
    reportError(err, { site: 'serverAction.maintenance.updateMaintenanceScheduleItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Duplicate a per-property maintenance schedule item ────────────────────────

export async function duplicateMaintenanceScheduleItem(
  itemId:      string,
  nextDueDate: string,
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    const { data: original, error: fetchErr } = await supabase
      .from('maintenance_schedules')
      .select('*')
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .single()

    if (fetchErr || !original) return { error: 'Item not found' }

    // `original` is a fully typed maintenance_schedules row; casting it to
    // Record<string, unknown> here erased that and left the insert below
    // unchecked against the table it writes to.
    const { id: _id, created_at: _ca, updated_at: _ua, ...rest } = original

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
    reportError(err, { site: 'serverAction.maintenance.duplicateMaintenanceScheduleItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Soft-delete a per-property maintenance schedule item ──────────────────────

export async function removeMaintenanceScheduleItem(
  itemId:     string,
  propertyId: string,
): Promise<{ error?: string; success?: boolean }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

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
    reportError(err, { site: 'serverAction.maintenance.removeMaintenanceScheduleItem' })
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
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // Verify property belongs to this org — propertyId is client-supplied and
    // must not be trusted to already scope to the caller's org.
    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

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
    reportError(err, { site: 'serverAction.maintenance.addCatalogItemToProperty' })
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
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // Verify property belongs to this org — propertyId is client-supplied and
    // must not be trusted to already scope to the caller's org.
    const { data: property } = await supabase
      .from('properties')
      .select('id')
      .eq('id', propertyId)
      .eq('org_id', membership.org_id)
      .single()

    if (!property) return { error: 'Property not found' }

    const { error } = await supabase
      .from('maintenance_schedules')
      // Explicit field list, NOT `...item`. The spread came LAST, so a client
      // sending extra keys could override the very fields above it that scope
      // this row — including property_id, which the check immediately above
      // had just verified belongs to this org. Verifying a value and then
      // letting the same request overwrite it is the check doing nothing.
      // TypeScript's parameter type is compile-time only and stops none of it.
      .insert({
        property_id:               propertyId,
        org_id:                    membership.org_id,
        schedule_type:             'routine',
        auto_create_wo:            false,
        is_from_standard_template: false,
        is_active:                 true,
        name:                      item.name,
        frequency:                 item.frequency,
        next_due_date:             item.next_due_date,
        active_from_month:         item.active_from_month ?? null,
        active_to_month:           item.active_to_month ?? null,
        asset_category:            item.asset_category ?? null,
        instructions:              item.instructions ?? null,
        estimated_cost:            item.estimated_cost ?? null,
      })

    if (error) {
      console.error('[addCustomMaintenanceItem]', error)
      return { error: 'Failed to add item' }
    }

    revalidatePath(`/properties/${propertyId}`)
    return { success: true }
  } catch (err) {
    console.error('[addCustomMaintenanceItem]', err)
    reportError(err, { site: 'serverAction.maintenance.addCustomMaintenanceItem' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Record a maintenance completion and advance next_due_date ─────────────────

export async function recordMaintenanceCompletion(
  scheduleItemId: string,
  input: { notes?: string; work_order_id?: string },
): Promise<{ error?: string; success?: boolean; nextDueDate?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

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
    reportError(err, { site: 'serverAction.maintenance.recordMaintenanceCompletion' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Fetch Completed/Cancelled Work Orders (on demand) ───────────────────────
// The maintenance page query defaults to active-status work orders only
// (see app/(dashboard)/maintenance/page.tsx). This fetches the rest, for the
// "Show completed" toggle in the client board — same select shape as the
// page's initial query.

// Read-only — intentionally left on requireOrgMember() rather than
// requireOrgRole(), since a viewer should still be able to see archived
// work orders even though they can't mutate them.
export async function fetchArchivedWorkOrders() {
  try {
    const { supabase, membership } = await requireOrgMember()

    const { data, error } = await supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, assigned_crew_member_id,
        wo_number, title, description, category, priority, status, source,
        scheduled_date, completed_date,
        estimated_cost, nte_amount, actual_cost,
        access_notes, completion_notes, completed_by_name, invoice_reference,
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
      .limit(200)

    if (error) {
      console.error('[fetchArchivedWorkOrders]', error)
      return []
    }

    return data ?? []
  } catch (err) {
    console.error('[fetchArchivedWorkOrders]', err)
    reportError(err, { site: 'serverAction.maintenance.fetchArchivedWorkOrders' })
    return []
  }
}
