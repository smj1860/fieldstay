import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { logAuditEvent } from '@/lib/audit'
import { vendorDeclineReasonLabel } from '@/lib/work-orders/vendor-progress'
import { tryUnwrap } from '@/lib/supabase/unwrap'

/**
 * A vendor declined a dispatch, or cancelled one they had already accepted.
 *
 * The route has already returned the work order to the unassigned queue
 * (`status = 'pending'`, `vendor_id = NULL`) before this fires. This function
 * does the three things that must not block the vendor's own request:
 *
 *   1. records the decline so it is visible and attributable
 *   2. tells the PM, with the reason and whether a booked visit was lost
 *   3. asks the EXISTING scorer for the next best vendor
 *
 * IT DOES NOT AUTO-DISPATCH, and that is deliberate rather than unfinished.
 * `organizations.vendor_auto_assign_mode` is CHECK-constrained to
 * ('suggest','disabled') and `auto-assign-vendor.ts` only ever writes
 * `suggested_vendor_ids` / `suggestion_reasoning` / `suggestion_status`, never
 * `assigned_vendor_id`. Crew scheduling has a third mode that really does
 * assign with nobody in the loop; vendors have two. That asymmetry is a
 * documented GAP awaiting the planned vendor-Autopilot work, so a decline
 * handler is the wrong place to quietly cross it: it would mean an unattended
 * cron chose a contractor, sent them a property's access details, and told
 * nobody, on a path triggered by a third party.
 *
 * So a decline produces a SUGGESTION and a notification. A human still picks.
 */
export const workOrderVendorDeclined = inngest.createFunction(
  { id: 'work-order-vendor-declined', name: 'Vendor Declined Work Order', retries: 3 },
  { event: 'work-order/vendor-declined' },
  async ({ event, step }) => {
    const { work_order_id, property_id, org_id, vendor_id, reason, note, category, stage } = event.data

    const context = await step.run('record-decline', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-declined' })

      // The vendor name, for the notification. A missing vendor row is not a
      // reason to fail: the decline happened, and "a vendor" is still an
      // actionable alert.
      const vendorRes = await supabase
        .from('vendors')
        .select('name')
        .eq('id', vendor_id)
        .eq('org_id', org_id)
        .maybeSingle()

      const woRes = await supabase
        .from('work_orders')
        .select('wo_number, title')
        .eq('id', work_order_id)
        .eq('org_id', org_id)
        .maybeSingle()

      const vendorLookup = tryUnwrap(vendorRes, { site: 'inngest.work-order-vendor-declined.vendor', orgId: org_id })
      const woLookup     = tryUnwrap(woRes,     { site: 'inngest.work-order-vendor-declined.wo',     orgId: org_id })

      return {
        vendorName: vendorLookup.ok ? (vendorLookup.data?.name ?? 'A vendor') : 'A vendor',
        woLabel:    woLookup.ok
          ? (woLookup.data?.wo_number ?? woLookup.data?.title ?? 'A work order')
          : 'A work order',
        // A deleted work order means there is nothing left to re-suggest for.
        // Distinguished from a failed READ, which must not be treated as
        // absence — that is the whole point of tryUnwrap here.
        stillExists: !woLookup.ok || woLookup.data !== null,
      }
    })

    // The reason is NOT logged as free text. vendor_progress_note can carry a
    // vendor's own words, which may name a person or a price, and audit rows
    // are read by staff investigating an incident rather than being a second
    // home for data that should not be logged at all.
    await step.run('audit', async () => {
      await logAuditEvent({
        orgId:      org_id,
        actorId:    undefined,
        action:     'work_order.updated',
        targetType: 'work_order',
        targetId:   work_order_id,
        metadata:   { change: 'vendor_declined', vendor_id, reason, stage },
      })
    })

    await step.run('notify-pm', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-vendor-declined' })

      const cancelled = stage === 'after_accepting'
      const noteSuffix = note ? ` They said: ${note}` : ''

      await createPmNotification(supabase, {
        orgId:    org_id,
        type:     cancelled ? 'work_order.vendor_cancelled' : 'work_order.vendor_declined',
        title:    cancelled
          ? `${context.vendorName} cancelled a booked job`
          : `${context.vendorName} declined a work order`,
        subtitle: `${context.woLabel}: ${vendorDeclineReasonLabel(reason)}.${noteSuffix}`,
        href:     `/maintenance/${work_order_id}`,
        // A cancellation after acceptance is worse than a refusal: the PM
        // believed the visit was booked and may have told an owner or a guest.
        severity: cancelled ? 'red' : 'amber',
        // One alert per work order per vendor per decline stage. A retry is a
        // no-op; the same vendor declining the same work order again after a
        // re-dispatch is genuinely new and keys differently on stage.
        dedupeKey: `vendor_declined:${work_order_id}:${vendor_id}:${stage}`,
      })
    })

    // Top level, not inside a step.run: step tooling nested in a step callback
    // unwinds the request to schedule the inner op and leaves the enclosing
    // step unresolved, replaying every side effect above it on the next pass.
    if (context.stillExists && category) {
      await step.sendEvent('request-vendor-suggestion', {
        name: 'work-order/vendor-suggestion.requested',
        data: { work_order_id, property_id, org_id, category },
      })
    }

    return { declined: true, stage, suggested: context.stillExists && category !== null }
  }
)
