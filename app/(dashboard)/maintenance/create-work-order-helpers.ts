import { unwrap } from '@/lib/supabase/unwrap'
import 'server-only'
import { fetchAllRows } from '@/lib/inngest/paginate'

import { inngest, sendEventAsync } from '@/lib/inngest/client'
import type { WoStatus, WoCategory } from '@/types/database'
import { WoStatusSchema } from '@/lib/schemas/work-order'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import {
  isVendorHardBlocked,
  VendorComplianceCheckError,
  VENDOR_HARD_BLOCKED_ERROR,
  VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR,
} from '@/lib/vendors/compliance'

/**
 * Helpers extracted out of createWorkOrder() (./actions.ts) — status
 * derivation, RFQ email fan-out, the crew-time-off warning check, and
 * Inngest event dispatch each used to live inline in one 207-line Server
 * Action. Every query filter, dedup, and idempotency behavior below is
 * unchanged — pure code motion, not exported as Server Actions (this file
 * has no 'use server' directive) since these are internal helpers only
 * createWorkOrder calls.
 */
export function resolveWorkOrderStatus(requestQuotes: boolean, vendorId: string | null): WoStatus {
  return WoStatusSchema.parse(
    requestQuotes ? 'quote_requested' : (vendorId ? 'assigned' : 'pending')
  )
}

/**
 * Verifies a crew member belongs to the caller's org before it can be written
 * to work_orders.assigned_crew_member_id.
 *
 * This is a TENANT ISOLATION check, not a data-hygiene one. The
 * `work_orders_select` RLS policy grants read access on a second, OR'd branch:
 * "any work order whose assigned_crew_member_id is one of YOUR crew_members
 * rows". Until migration 20260801210000 that branch was not scoped to the work
 * order's org at all, so writing a FOREIGN org's crew id onto a work order made
 * that work order readable by the other tenant's crew user — title,
 * description, notes, costs, property linkage.
 *
 * Both server actions that set this column took the id straight from the client
 * and never checked it. The migration closes the read path; this closes the
 * write path, so the bad row is never created in the first place.
 *
 * Returns an error object to surface to the PM, or null when the crew member is
 * in-org (or none was supplied). FAILS CLOSED: a query error blocks rather than
 * passes, because "we could not confirm this crew member is yours" must never
 * resolve to "assign them".
 */
export async function checkCrewMemberAssignable(
  supabase:     SupabaseClient,
  orgId:        string,
  crewMemberId: string | null | undefined,
): Promise<{ error: string } | null> {
  if (!crewMemberId) return null

  const { data, error } = await supabase
    .from('crew_members')
    .select('id')
    .eq('id', crewMemberId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (error) {
    console.error('[checkCrewMemberAssignable] crew lookup failed', error)
    reportError(error, { site: 'maintenance.checkCrewMemberAssignable', orgId })
    return { error: 'Could not verify the selected crew member. Please try again.' }
  }

  // Not found means either no such crew member or one in a different org. Both
  // are the same answer to the caller, and deliberately so — distinguishing
  // them would confirm the existence of another tenant's crew id.
  if (!data) return { error: 'That crew member is not part of your organization.' }

  return null
}

/**
 * Gate every RFQ recipient the same way a direct assignment is gated.
 *
 * The quote-request flow used to route around both checks: `quote_vendor_ids`
 * went straight from the form to sendQuoteRequestEmails with no org check and
 * no compliance check, and `sendQuoteRequests` validated only the work order.
 * So a vendor whose COI expired 46+ days ago could be RFQ'd, quote, be
 * approved, and be dispatched — the exact outcome lib/vendors/compliance.ts's
 * header says every assignment path must prevent.
 *
 * Returns an error object to surface to the PM, or null when every vendor is
 * in-org and assignable. `isVendorHardBlocked` FAILS CLOSED (it throws
 * VendorComplianceCheckError when the compliance state can't be read), so that
 * throw is caught here and turned into a block, never into a pass.
 */
export async function checkQuoteVendorsAssignable(
  supabase:  SupabaseClient,
  orgId:     string,
  vendorIds: string[],
): Promise<{ error: string } | null> {
  const ids = Array.from(new Set(vendorIds.filter(Boolean)))
  if (ids.length === 0) return { error: 'Select at least one vendor' }

  // One query for the whole list — org membership of each vendor id, which
  // nothing in this flow previously verified at all.
  // Paginated: this is the in-org membership check for the selected vendors, so
  // a truncated result would read as "these vendors are not in your org" for
  // everything past the cap. fetchAllRows throws rather than returning a short
  // list, which is the safe direction for an authorization check.
  let vendors
  try {
    vendors = await fetchAllRows<{ id: string }>(
      (from, to) => supabase
        .from('vendors')
        .select('id')
        .eq('org_id', orgId)
        .in('id', ids)
        .order('id')
        .range(from, to),
      { label: 'maintenance.checkQuoteVendorsAssignable' },
    )
  } catch (error) {
    console.error('[checkQuoteVendorsAssignable] vendor lookup failed', error)
    reportError(error, { site: 'maintenance.checkQuoteVendorsAssignable', orgId })
    return { error: 'Could not verify the selected vendors. Please try again.' }
  }

  const owned = new Set((vendors ?? []).map((v: { id: string }) => v.id))
  if (ids.some((id) => !owned.has(id))) return { error: 'Vendor not found' }

  try {
    const blocked = await Promise.all(ids.map((id) => isVendorHardBlocked(supabase, id, orgId)))
    if (blocked.some(Boolean)) return { error: VENDOR_HARD_BLOCKED_ERROR }
  } catch (err) {
    if (err instanceof VendorComplianceCheckError) {
      return { error: VENDOR_COMPLIANCE_UNVERIFIABLE_ERROR }
    }
    throw err
  }

  return null
}

/** Sends one RFQ (quote_requests row + Inngest notify event) per selected vendor. */
export async function sendQuoteRequestEmails(
  supabase:      SupabaseClient,
  workOrderId:   string,
  propertyId:    string,
  orgId:         string,
  quoteVendorIds: string[],
): Promise<void> {
  await Promise.all(
    quoteVendorIds.map(async (vendorId) => {
      const quote_token            = crypto.randomUUID()
      const quote_token_expires_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

      const { data: qr, error: qrError } = await supabase
        .from('quote_requests')
        .insert({
          work_order_id: workOrderId,
          org_id:        orgId,
          vendor_id:     vendorId,
          quote_token,
          quote_token_expires_at,
          status:        'pending',
        })
        .select('id')
        .single()

      if (qrError || !qr) return

      await inngest.send({
        name: 'work-order/quote-requested' as const,
        data: {
          work_order_id:    workOrderId,
          quote_request_id: qr.id,
          property_id:      propertyId,
          org_id:           orgId,
          vendor_id:        vendorId,
          quote_token,
        },
      })
    })
  )
}

/**
 * Non-blocking warning check: did the crew member assigned to this work
 * order mark themselves unavailable on the scheduled date? Returns the
 * warning message to surface to the PM, or undefined if there's nothing to
 * warn about.
 */
export async function checkCrewTimeOffWarning(
  supabase:           SupabaseClient,
  orgId:              string,
  crewMemberId:       string | null,
  scheduledDate:      string | null,
): Promise<string | undefined> {
  if (!crewMemberId || !scheduledDate) return undefined

  // An empty result reads as "crew is available", so a failed read would
  // assign work to someone who booked the day off.
  const timeOffRes = await supabase
    .from('crew_availability')
    .select('id')
    .eq('org_id', orgId)
    .eq('crew_member_id', crewMemberId)
    .eq('available_date', scheduledDate)
    .eq('is_available', false)
    .maybeSingle()

  const timeOff = unwrap(timeOffRes, { site: 'serverAction.maintenance.crew-time-off', orgId })

  return timeOff
    ? 'Work order created, but the assigned crew member marked time off on the scheduled date.'
    : undefined
}

interface DispatchWorkOrderEventsParams {
  workOrderId:          string
  propertyId:           string
  orgId:                string
  vendorId:             string | null
  usePortal:            boolean
  requestQuotes:        boolean
  category:             WoCategory | null
  assignedCrewMemberId: string | null
}

/**
 * Fires the three independent, mutually-non-exclusive Inngest events a
 * newly-created work order can trigger: portal dispatch notification,
 * vendor-suggestion request, and crew-assignment notification. Each has
 * its own trigger condition and was previously a separate `if` block
 * sharing no state with the others.
 */
export async function dispatchWorkOrderEvents(params: DispatchWorkOrderEventsParams): Promise<void> {
  const { workOrderId, propertyId, orgId, vendorId, usePortal, requestQuotes, category, assignedCrewMemberId } = params

  // All three sends below are fire-and-forget — this function's only job is
  // dispatching notifications for an already-created work order; nothing
  // downstream in the caller depends on delivery having completed.
  if (usePortal) {
    sendEventAsync({
      name: 'work-order/created',
      data: {
        work_order_id:  workOrderId,
        property_id:    propertyId,
        org_id:         orgId,
        vendor_id:      vendorId ?? null,
        portal_enabled: true,
      },
    })
  }

  // Vendor suggestion — only when the PM left this to be figured out later:
  // no vendor picked yet, and not already in quote-request mode (that's an
  // explicit "let the market decide" flow, not a single top-pick recommendation).
  // The Inngest function itself checks vendor_auto_assign_mode and no-ops if
  // vendor suggestions are disabled for this org.
  if (!requestQuotes && !vendorId && category) {
    sendEventAsync({
      name: 'work-order/vendor-suggestion.requested',
      data: {
        work_order_id: workOrderId,
        property_id:   propertyId,
        org_id:        orgId,
        category,
      },
    })
  }

  // Internal crew assignment: no vendor, no portal/dispatch email. The WO
  // surfaces in the crew PWA via Dexie sync; this event scaffolds push notify.
  const isCrew = !vendorId && !!assignedCrewMemberId
  if (isCrew) {
    sendEventAsync({
      name: 'work-order/crew.assigned',
      data: {
        workOrderId,
        orgId,
        crewMemberId: assignedCrewMemberId,
      },
    })
  }
}
