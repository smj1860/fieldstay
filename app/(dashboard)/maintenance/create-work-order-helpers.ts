import 'server-only'

import { inngest } from '@/lib/inngest/client'
import type { WoStatus, WoCategory } from '@/types/database'
import { WoStatusSchema } from '@/lib/schemas/work-order'
import type { SupabaseClient } from '@supabase/supabase-js'

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

  const { data: timeOff } = await supabase
    .from('crew_availability')
    .select('id')
    .eq('org_id', orgId)
    .eq('crew_member_id', crewMemberId)
    .eq('available_date', scheduledDate)
    .eq('is_available', false)
    .maybeSingle()

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

  if (usePortal) {
    await inngest.send({
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
    await inngest.send({
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
    await inngest.send({
      name: 'work-order/crew.assigned',
      data: {
        workOrderId,
        orgId,
        crewMemberId: assignedCrewMemberId,
      },
    })
  }
}
