'use server'

import { revalidatePath } from 'next/cache'
import { redirect, unstable_rethrow } from 'next/navigation'
import { verifyPropertyInOrg } from '@/lib/tenancy/verify'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { fetchAllRows, SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { reportQueryError } from '@/lib/supabase/unwrap'
import type { WoStatus, WoCategory, ScheduleFrequency, ScheduleType, Enums } from '@/types/database'
import { PriorityLevelSchema, WoStatusSchema, WoCategorySchema } from '@/lib/schemas/work-order'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveWorkOrderStatus,
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

// A refused UPDATE returns 0 rows and NO error, so `if (error)` alone reports
// success for a change that never happened. Every write below whose WHERE
// clause is just id + org — where 0 rows can only mean refused or gone, never
// "already in that state" — reads the row count back and returns this.
// Phrased for a PM. Mirrors turnovers/actions.ts and properties/actions.ts.
const NOTHING_UPDATED =
  'You do not have permission to make this change, or the record no longer exists.'

// work-order-photos is a PRIVATE bucket — reads go through short-lived
// signed URLs, never a `/object/public/...` link.
const WORK_ORDER_PHOTO_BUCKET      = 'work-order-photos'
const PHOTO_SIGNED_URL_TTL_SECONDS = 300  // 5 minutes

export type MaintenanceActionState = { error?: string; success?: boolean; workOrderId?: string; templateId?: string; warning?: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Everything createWorkOrder reads off the form, parsed and defaulted once.
 *
 * Extracted for the same reason parsePropertyForm() was: nineteen fields of
 * `(formData.get(x) as string) || null` and `cond ? parse(...) : null` are
 * almost the entire cognitive-complexity score of the action, while being the
 * part with no decisions in it. Pulling them out leaves the action's own
 * branching — the guards and the two dispatch modes — legible on its own.
 */
interface WorkOrderFormInput {
  title:                   string
  property_id:             string
  description:             string | null
  priority:                ReturnType<typeof PriorityLevelSchema.safeParse>['data'] & string
  category:                WoCategory | null
  vendor_id:               string | null
  assigned_crew_member_id: string | null
  scheduled_date:          string | null
  scheduled_time:          string | null
  estimated_cost:          number | null
  nte_amount:              number | null
  asset_id:                string | null
  portal_enabled:          boolean
  request_quotes:          boolean
  quote_vendor_ids:        string[]
}

/** `''` and a missing key both mean "not provided" for every optional field. */
function formText(formData: FormData, key: string): string | null {
  const raw = formData.get(key)
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

function formNumber(formData: FormData, key: string): number | null {
  const raw = formText(formData, key)
  if (raw === null) return null
  const parsed = parseFloat(raw)
  // NaN is neither null nor undefined, so `??` never catches it, and every
  // comparison against it is false — Number.isFinite is the only guard that
  // stops a garbage cost field reaching the insert as `null` via JSON.
  return Number.isFinite(parsed) ? parsed : null
}

function parseWorkOrderForm(formData: FormData): WorkOrderFormInput {
  const categoryInput = formText(formData, 'category')
  const portalRaw     = formData.get('portal_enabled')

  return {
    title:                   formText(formData, 'title')?.trim() ?? '',
    property_id:             formText(formData, 'property_id') ?? '',
    description:             formText(formData, 'description')?.trim() ?? null,
    priority:                PriorityLevelSchema.safeParse(formText(formData, 'priority') ?? 'medium').data ?? 'medium',
    category:                categoryInput ? (WoCategorySchema.safeParse(categoryInput).data ?? null) : null,
    vendor_id:               formText(formData, 'vendor_id'),
    assigned_crew_member_id: formText(formData, 'assigned_crew_member_id'),
    scheduled_date:          formText(formData, 'scheduled_date'),
    scheduled_time:          formText(formData, 'scheduled_time'),
    estimated_cost:          formNumber(formData, 'estimated_cost'),
    nte_amount:              formNumber(formData, 'nte_amount'),
    asset_id:                formText(formData, 'asset_id'),
    portal_enabled:          portalRaw === 'on' || portalRaw === 'true',
    request_quotes:          formData.get('request_quotes') === 'true',
    quote_vendor_ids:        formData.getAll('quote_vendor_ids') as string[],
  }
}

/**
 * Every reason to refuse before the work order exists, in the order the DB
 * reads have to happen. Returns the state to hand back, or null to proceed.
 *
 * These must ALL run ahead of the insert. A hard-blocked vendor or a foreign
 * crew id caught afterwards would leave an orphan work order with no way to
 * explain itself — which is exactly why the quote-vendor check stays here even
 * though sendQuoteRequests repeats it later.
 */
async function validateWorkOrderCreate(
  supabase: SupabaseClient,
  orgId:    string,
  input:    WorkOrderFormInput,
): Promise<MaintenanceActionState | null> {
  if (!input.title)       return { error: 'Title is required' }
  if (!input.property_id) return { error: 'Property is required' }
  if (input.request_quotes && !input.quote_vendor_ids.length) {
    return { error: 'Select at least one vendor to request quotes from' }
  }

  const owned = await verifyPropertyInOrg(
    supabase, orgId, input.property_id, 'serverAction.maintenance.createWorkOrder.property',
  )
  if (!owned.ok) return { error: owned.error }

  const directVendor = input.vendor_id && !input.request_quotes
  if (directVendor && await isVendorHardBlocked(supabase, input.vendor_id!, orgId)) {
    return { error: VENDOR_HARD_BLOCKED_ERROR }
  }

  // Quote mode dispatches to `quote_vendor_ids` instead of `vendor_id`, and
  // used to skip both the in-org check and the compliance gate entirely.
  if (input.request_quotes) {
    const quoteVendorProblem = await checkQuoteVendorsAssignable(supabase, orgId, input.quote_vendor_ids)
    if (quoteVendorProblem) return quoteVendorProblem
  }

  // TENANT ISOLATION: assigned_crew_member_id arrives from the client and was
  // written unverified. work_orders_select grants read on an OR'd branch keyed
  // by that column, so a foreign org's crew id here handed the other tenant's
  // crew user read access to this work order.
  return checkCrewMemberAssignable(supabase, orgId, input.assigned_crew_member_id)
}

/** The insert payload plus the one derived flag the caller still needs. */
function buildWorkOrderInsert(input: WorkOrderFormInput, orgId: string) {
  // In quote-request mode the WO starts as quote_requested with no vendor
  // assigned yet, and no portal link — there is nobody to give one to.
  const usePortal = input.portal_enabled && !input.request_quotes
  const tokenExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  return {
    usePortal,
    payload: {
      property_id:             input.property_id,
      org_id:                  orgId,
      vendor_id:               input.request_quotes ? null : input.vendor_id,
      assigned_crew_member_id: input.assigned_crew_member_id,
      asset_id:                input.asset_id,
      title:                   input.title,
      description:             input.description,
      category:                input.category,
      priority:                input.priority,
      status:                  resolveWorkOrderStatus(input.request_quotes, input.vendor_id),
      source:                  'manual' as const,
      scheduled_date:          input.scheduled_date,
      scheduled_time:          input.scheduled_time,
      estimated_cost:          input.estimated_cost,
      nte_amount:              input.nte_amount,
      portal_enabled:          usePortal,
      completion_token:            usePortal ? crypto.randomUUID() : null,
      completion_token_expires_at: usePortal ? tokenExpiry : null,
    },
  }
}

/**
 * The non-blocking "it was created, but…" message, if there is one.
 *
 * A crew member's time off outranks the vendor-notification warning: only one
 * can be shown, and being told the assignee is away is more actionable than
 * being told to email a vendor manually.
 */
async function resolveCreationWarning(
  supabase:  SupabaseClient,
  orgId:     string,
  input:     WorkOrderFormInput,
  usePortal: boolean,
): Promise<string | undefined> {
  const timeOff = await checkCrewTimeOffWarning(
    supabase, orgId, input.assigned_crew_member_id, input.scheduled_date,
  )
  if (timeOff) return timeOff

  // Otherwise the PM is left assuming the vendor was notified.
  if (input.vendor_id && !usePortal) {
    return 'Work order created, but the vendor was not notified because the portal link is disabled for this vendor. Enable the portal in Vendor settings or notify them manually.'
  }
  return undefined
}

/**
 * ONE RFQ path. This used to call a separate exported sender in
 * create-work-order-helpers.ts, so the create modal reached the database
 * without the dedup filter, the vendor-id validation or the work-order status
 * check that sendQuoteRequests performs — and the two senders had already
 * drifted. That helper is gone; this goes through the same action the work
 * order detail's quote panel calls.
 *
 * Returns a state to hand back, or null when every RFQ went out and the caller
 * should redirect. A partial send used to be invisible: the old helper
 * returned void and swallowed each failure, so the PM was redirected to a work
 * order in "Awaiting Quote" that looked identical whether four vendors or none
 * had been contacted. redirect() throws, which would discard the warning with
 * it — so anything short of a clean send returns instead.
 */
async function dispatchQuoteRequestsForNewWorkOrder(
  workOrderId: string,
  vendorIds:   string[],
): Promise<MaintenanceActionState | null> {
  const rfq = await sendQuoteRequests(workOrderId, vendorIds)
  revalidatePath('/maintenance')

  if (!rfq.error) return null

  return {
    success:     true,
    workOrderId,
    warning:     `Work order created, but the quote requests were not all sent: ${rfq.error}`,
  }
}

export async function createWorkOrder(
  _prev: MaintenanceActionState | null,
  formData: FormData
): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const input   = parseWorkOrderForm(formData)
    const invalid = await validateWorkOrderCreate(supabase, membership.org_id, input)
    if (invalid) return invalid

    const { payload, usePortal } = buildWorkOrderInsert(input, membership.org_id)

    const { data: wo, error } = await supabase
      .from('work_orders')
      .insert(payload)
      .select('id')
      .single()

    if (error) {
      console.error('[createWorkOrder]', error)
      return { error: 'Operation failed. Please try again.' }
    }

    if (input.request_quotes && input.quote_vendor_ids.length) {
      const partial = await dispatchQuoteRequestsForNewWorkOrder(wo.id, input.quote_vendor_ids)
      if (partial) return partial
      redirect(`/maintenance/${wo.id}`)
    }

    await dispatchWorkOrderEvents({
      workOrderId:          wo.id,
      propertyId:           input.property_id,
      orgId:                membership.org_id,
      vendorId:             input.vendor_id,
      usePortal,
      requestQuotes:        input.request_quotes,
      category:             input.category,
      assignedCrewMemberId: input.assigned_crew_member_id,
    })

    const warning = await resolveCreationWarning(supabase, membership.org_id, input, usePortal)

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'work_order.created',
      targetType: 'work_order',
      targetId:   wo.id,
      metadata:   { title: input.title, property_id: input.property_id, priority: input.priority, source: 'manual' },
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

    const { data: rated, error } = await supabase
      .from('work_orders')
      .update({
        vendor_rating:       rating,
        vendor_rating_notes: ratingNotes ?? null,
      })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[rateWorkOrderVendor]', error)
      reportError(error, { site: 'serverAction.maintenance.rateWorkOrderVendor', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!rated) return { error: NOTHING_UPDATED }
    revalidatePath('/maintenance')
    revalidatePath('/vendors')
    return {}
  } catch (err) {
    console.error('[rateWorkOrderVendor]', err)
    reportError(err, { site: 'serverAction.maintenance.rateWorkOrderVendor' })
    return { error: 'Operation failed. Please try again.' }
  }
}

// ── Work-order editing: deliberately absent ──────────────────────────────────
//
// Seven exported actions used to sit here — assignCrewToWorkOrder,
// updateWorkOrder, addWorkOrderNote, updateWorkOrderStatus, logActualCost,
// recordWorkOrderPhoto, deleteWorkOrderPhoto. None had a caller. They read as
// the pieces of a work-order detail screen, but that screen already exists
// (/maintenance/[id] -> components/work-orders/work-order-detail.tsx) and gets
// the same jobs done through narrower, purpose-built actions:
//
//   status changes  -> markVendorAcknowledged / markWorkVerified / cancel,
//                      each carrying its own side effects, plus
//                      bulkUpdateWorkOrderStatus from the board
//   vendor dispatch -> dispatchWorkOrderToVendor (app/actions/work-order-public)
//   actual cost     -> the Stripe invoice webhook writes the real invoice
//                      total; finalizeWorkOrderCompletion falls back to
//                      estimated_cost. A hand-entered figure competes with
//                      both, over the one field CLAUDE.md says never to log.
//   history entries -> written by the status-change and completion helpers
//   photos          -> attached at creation (CreateWorkOrderModal) and by the
//                      vendor through /api/work-orders/[token]/photos
//
// Three capabilities went with them and genuinely do not exist anywhere else:
// editing a work order's fields after creation, re-assigning crew after
// creation, and a PM adding or removing a photo after creation. Deleting them
// is the deliberate choice — the live flow is create (maintenance page, the
// create modal, or a maintenance schedule) then dispatch, and a dead action is
// not a feature. If one of those is wanted later it gets written against the
// detail page that exists now, rather than revived from a version that
// predates it.
//
// The one worth knowing about before it went: recordWorkOrderPhoto never
// verified that its workOrderId belonged to the caller's org — it leaned
// entirely on the RLS WITH CHECK — and it wrote a caller-supplied storagePath
// verbatim, bypassing orgScopedStoragePath(). Its sibling deleteWorkOrderPhoto
// does both checks. That asymmetry is exactly the shape this class of finding
// keeps taking: the reachable half got hardened, the dead half did not.

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


// ── Send quote requests to multiple vendors ───────────────────────────────────

/** How long a vendor has to respond to an RFQ before the token stops working. */
const QUOTE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Sends one RFQ (quote_requests row + Inngest notify event) per vendor.
 *
 * Not exported and not a Server Action: sendQuoteRequests below is the ONLY
 * way to send an RFQ, including from createWorkOrder. There used to be a
 * second exported sender in create-work-order-helpers.ts that the create modal
 * called directly, bypassing every check this action performs — the two had
 * already drifted (only this path deduped against live RFQs, only this path
 * validated the vendor ids), and each discarded its insert failures in its own
 * different way. Deleted rather than shared, so there is nothing left to call
 * around the gate.
 *
 * The per-vendor loop is intrinsic: each RFQ needs its own generated token
 * before its own event fires, so a batched insert would have to move token
 * generation to the caller. Bounded by the vendor count the PM ticked in one
 * dialog.
 */
async function insertQuoteRequests(
  supabase:    SupabaseClient,
  workOrderId: string,
  propertyId:  string,
  orgId:       string,
  vendorIds:   string[],
): Promise<{ sent: number; failed: string[] }> {
  const outcomes = await Promise.all(
    vendorIds.map(async (vendorId) => {
      const quote_token            = crypto.randomUUID()
      const quote_token_expires_at = new Date(Date.now() + QUOTE_TOKEN_TTL_MS).toISOString()

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

      if (qrError || !qr) {
        // A failed RFQ used to vanish — one sender returned `false` and
        // reported only the success count, the other swallowed it without even
        // a log. Either way the PM got a work order in "Awaiting Quote" that
        // looked identical whether every vendor had been contacted or none had.
        console.error('[sendQuoteRequests] RFQ insert failed', {
          workOrderId, vendorId, code: qrError?.code, message: qrError?.message,
        })
        reportError(qrError ?? new Error('quote_requests insert returned no row'), {
          site: 'serverAction.maintenance.sendQuoteRequests.insert', orgId,
        })
        return { ok: false as const, vendorId }
      }

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

      return { ok: true as const, vendorId }
    })
  )

  return {
    sent:   outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).map((o) => o.vendorId),
  }
}

export async function sendQuoteRequests(
  workOrderId: string,
  vendorIds: string[]
): Promise<{ error?: string; sent: number }> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    if (!vendorIds.length) return { error: 'Select at least one vendor', sent: 0 }

    const woRes = await supabase
      .from('work_orders')
      .select('id, property_id, status')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(woRes.error, { site: 'serverAction.maintenance.sendQuoteRequests.workOrder', orgId: membership.org_id })) {
      return { error: 'Could not load the work order. Please try again.', sent: 0 }
    }
    const wo = woRes.data

    if (!wo) return { error: 'Work order not found', sent: 0 }
    if (wo.status === 'completed' || wo.status === 'cancelled') {
      return { error: 'Cannot request quotes on a completed or cancelled work order', sent: 0 }
    }

    // This action validated the work order but never the vendor ids — neither
    // that they belong to the caller's org nor that they are compliance-clear.
    const vendorProblem = await checkQuoteVendorsAssignable(supabase, membership.org_id, vendorIds)
    if (vendorProblem) return { ...vendorProblem, sent: 0 }

    // Skip vendors who already have a pending or submitted quote for this WO.
    //
    // This is a dedup filter with no unique constraint behind it, so its empty
    // result and its failure must not share a branch: a failed read made
    // existingVendorIds empty, every selected vendor was re-sent, and each got
    // a SECOND RFQ email carrying a second quote token. A duplicate outbound
    // vendor email is worse than making the PM retry.
    // Paginated too: a truncated page has the same effect as the failed read
    // described above — a vendor already holding a live RFQ looks new and gets
    // a second one.
    const existingRes = await supabase
      .from('quote_requests')
      .select('vendor_id')
      .eq('work_order_id', workOrderId)
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'submitted'])
      .limit(SUPABASE_MAX_ROWS)

    if (reportQueryError(existingRes.error, { site: 'serverAction.maintenance.sendQuoteRequests.existing', orgId: membership.org_id })) {
      return { error: 'Could not check existing quote requests. Please try again.', sent: 0 }
    }
    const existing = existingRes.data

    const existingVendorIds = new Set((existing ?? []).map((r) => r.vendor_id))
    const toSend = vendorIds.filter((id) => !existingVendorIds.has(id))

    if (!toSend.length) {
      return { error: 'All selected vendors already have an active quote request', sent: 0 }
    }

    const rfq = await insertQuoteRequests(
      supabase, workOrderId, wo.property_id, membership.org_id, toSend,
    )

    revalidatePath(`/maintenance/${workOrderId}`)
    revalidatePath('/maintenance')

    if (rfq.failed.length > 0) {
      return {
        sent:  rfq.sent,
        error: rfq.sent === 0
          ? 'Could not send the quote requests. Please try again.'
          : `Sent ${rfq.sent} of ${toSend.length} quote requests — the rest failed. Please try the remaining vendors again.`,
      }
    }

    return { sent: rfq.sent }
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

    const qrRes = await supabase
      .from('quote_requests')
      .select('id, work_order_id, vendor_id, quoted_amount, status, org_id')
      .eq('id', quoteRequestId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(qrRes.error, { site: 'serverAction.maintenance.approveQuoteRequest', orgId: membership.org_id })) {
      return { error: 'Could not load the quote request. Please try again.' }
    }
    const qr = qrRes.data

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

    // property_id was hardcoded to '' here. It type-checks (the event declares
    // `string`) and then PROPAGATES: handleWorkOrderCreated forwards it into a
    // further inngest.send, where a filter on an empty property id matches
    // nothing — and because this is the dispatch path, the symptom is "the
    // vendor was never notified" rather than a validation error. Read it from
    // the work order the transaction actually committed against.
    const propRes = await supabase
      .from('work_orders')
      .select('property_id')
      .eq('id', result.work_order_id)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(propRes.error, { site: 'serverAction.maintenance.approveQuoteRequest.property', orgId: membership.org_id })) {
      return { error: 'The quote was approved but the vendor could not be notified. Please retry the dispatch.' }
    }

    // From the RPC's return, not the pre-read: these are the ids the
    // transaction actually committed against.
    await inngest.send({
      name: 'work-order/created',
      data: {
        work_order_id:  result.work_order_id,
        property_id:    propRes.data?.property_id ?? '',
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

    const qrRes = await supabase
      .from('quote_requests')
      .select('id, work_order_id')
      .eq('id', quoteRequestId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(qrRes.error, { site: 'serverAction.maintenance.declineQuoteRequest', orgId: membership.org_id })) {
      return { error: 'Could not decline the quote. Please try again.' }
    }
    const qr = qrRes.data

    if (!qr) return { error: 'Quote request not found' }

    // approveQuoteRequest goes through a transactional RPC; this twin threw its
    // write result away entirely and returned success unconditionally, so a
    // refused or failed decline closed the dialog as though it had worked. The
    // org filter matches every sibling write — the id was already proven in-org
    // by the read above, so this is consistency, not a new gate.
    const { data: declined, error: declineError } = await supabase
      .from('quote_requests')
      .update({ status: 'declined' })
      .eq('id', quoteRequestId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (declineError) {
      console.error('[declineQuoteRequest]', declineError)
      reportError(declineError, { site: 'serverAction.maintenance.declineQuoteRequest.update', orgId: membership.org_id })
      return { error: 'Could not decline the quote. Please try again.' }
    }
    if (!declined) return { error: NOTHING_UPDATED }

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

    const currentRes = await supabase
      .from('work_orders')
      .select('status')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    // Throws rather than returning, because this action is Promise<void> and
    // its caller (use-work-order-actions.ts) renders the thrown message. The
    // message is written here rather than letting SupabaseQueryError surface,
    // so nothing internal reaches the UI. A silent null used to skip the whole
    // cancel block — no status change, no update row, no audit event — while
    // the confirm dialog closed as if the work order had been cancelled.
    if (reportQueryError(currentRes.error, { site: 'serverAction.maintenance.deleteWorkOrder', orgId: membership.org_id })) {
      throw new Error('Could not load the work order. Please try again.')
    }
    const current = currentRes.data

    if (current) {
      // A completed work order has already posted its owner_transactions
      // expense (handleWorkOrderCompleted, keyed on source_reference_id), and
      // cancelling here does NOT reverse it — the owner would keep being
      // charged for work the WO now says was cancelled. updateWorkOrderStatus
      // early-returns on 'completed' and approve_quote_request refuses to
      // touch a completed WO; this, the destructive path, had no guard at all.
      if (current.status === 'completed') {
        throw new Error(
          'This work order is already completed and cannot be cancelled. ' +
          'Adjust the logged cost or issue a credit instead.'
        )
      }
      // Already there — nothing to do, and re-writing would add a second
      // cancellation row and audit event for one action.
      if (current.status === 'cancelled') {
        revalidatePath('/maintenance')
        return
      }

      const { error: cancelError } = await supabase
        .from('work_orders')
        .update({ status: 'cancelled' })
        .eq('id', workOrderId)
        .eq('org_id', membership.org_id)

      // The READ above was fixed so a failure could not close the confirm
      // dialog as though the work order had been cancelled (see the comment
      // there). The WRITE had exactly the same hole: its result was discarded,
      // so a failed cancel still logged the audit event and returned normally.
      if (cancelError) {
        console.error('[deleteWorkOrder] cancel', cancelError)
        reportError(cancelError, {
          site:  'serverAction.maintenance.deleteWorkOrder.cancel',
          orgId: membership.org_id,
        })
        throw new Error('Could not cancel the work order. Please try again.')
      }

      const { error: noteError } = await supabase.from('work_order_updates').insert({
        work_order_id:             workOrderId,
        org_id:                    membership.org_id,
        updated_via_vendor_portal: false,
        status_from:               current.status as WoStatus,
        status_to:                 'cancelled',
        notes:                     'Cancelled by property manager',
      })

      if (noteError) {
        reportError(noteError, {
          site:  'serverAction.maintenance.deleteWorkOrder.note',
          orgId: membership.org_id,
        })
      }

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
    // A failed lookup must not read as "no vendor of that specialty" — that
    // silently downgrades the WO to unassigned. Report it and fall through
    // explicitly, matching the hard-blocked branch below.
    const { data: hintVendor, error: hintError } = await supabase
      .from('vendors')
      .select('id')
      .eq('org_id', orgId)
      .eq('specialty', schedule.vendor_specialty_hint)
      .eq('is_active', true)
      .order('avg_rating', { ascending: false })
      .limit(1)
      .maybeSingle()

    reportQueryError(hintError, {
      site:  'serverAction.maintenance.resolveVendorForSchedule.hintVendor',
      orgId,
    })
    vendorId = hintVendor?.id ?? null
  }

  if (!vendorId) return null

  return (await isVendorHardBlocked(supabase, vendorId, orgId)) ? null : vendorId
}

/**
 * Advances a routine schedule past the work order just created from it.
 *
 * Reported, not returned: the work order IS created by the time this runs, so
 * failing the action here would tell the PM nothing happened. But the result
 * used to be discarded ENTIRELY, and a schedule that never advances is due
 * again tomorrow — the cron re-creates the same work order every run, with no
 * signal that the advance is the thing failing.
 */
async function advanceScheduleNextDueDate(
  supabase:   Awaited<ReturnType<typeof requireOrgRole>>['supabase'],
  schedule:   { schedule_type: string | null; frequency: string | null; next_due_date: string | null },
  scheduleId: string,
  orgId:      string,
): Promise<void> {
  if (schedule.schedule_type !== 'routine' || !schedule.frequency || !schedule.next_due_date) return

  const nextDue = calcNextDueDate(schedule.frequency as ScheduleFrequency, new Date(schedule.next_due_date))

  const { error } = await supabase
    .from('maintenance_schedules')
    .update({ next_due_date: nextDue.toISOString().split('T')[0] })
    .eq('id', scheduleId)
    .eq('org_id', orgId)

  if (error) {
    console.error('[createWorkOrderFromSchedule] next_due_date advance failed', error)
    reportError(error, {
      site:  'serverAction.maintenance.createWorkOrderFromSchedule.advance',
      orgId,
    })
  }
}

export async function createWorkOrderFromSchedule(
  scheduleId: string
): Promise<MaintenanceActionState> {
  try {
    const { supabase, membership } = await requireOrgRole(['admin', 'manager'])

    // maybeSingle() + an explicit error check: single() reports zero rows as
    // PGRST116, which made a real read failure and a genuinely missing
    // schedule both surface as "Schedule not found".
    const { data: schedule, error: scheduleError } = await supabase
      .from('maintenance_schedules')
      .select('*')
      .eq('id', scheduleId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(scheduleError, {
      site:  'serverAction.maintenance.createWorkOrderFromSchedule.schedule',
      orgId: membership.org_id,
    })) {
      return { error: 'Operation failed. Please try again.' }
    }

    if (!schedule) return { error: 'Schedule not found' }

    // next_due_date is nullable — a schedule with no due date has no date to
    // create (or de-duplicate) a work order against.
    const scheduledDate = schedule.next_due_date
    if (!scheduledDate) return { error: 'This schedule has no next due date yet.' }

    // Idempotency: skip if an open WO already exists for this schedule + date —
    // mirrors the auto-create check in the maintenance-schedule cron, so a
    // double-click on "Create Work Order Now" doesn't create a duplicate while
    // still allowing the next cycle's WO once this one is completed/cancelled.
    const { data: existingWO, error: existingWOError } = await supabase
      .from('work_orders')
      .select('id')
      .eq('source_schedule_id', scheduleId)
      .eq('scheduled_date', scheduledDate)
      .not('status', 'in', '("completed","cancelled")')
      .maybeSingle()

    // Fail CLOSED. Discarding this error left `existingWO` null, which reads as
    // "no open WO for this schedule" and falls straight through to creating
    // one — so a failed idempotency check produced exactly the duplicate the
    // check exists to prevent.
    if (reportQueryError(existingWOError, {
      site:  'serverAction.maintenance.createWorkOrderFromSchedule.existingWO',
      orgId: membership.org_id,
    })) {
      return { error: 'Operation failed. Please try again.' }
    }

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

    // Feature 4: Advance next_due_date immediately on manual WO creation from
    // schedule. Extracted to a named helper rather than inlined: binding and
    // reporting the result took this function to a cognitive complexity of 16,
    // over CLAUDE.md's limit of 15.
    await advanceScheduleNextDueDate(supabase, schedule, scheduleId, membership.org_id)

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

    const vendorRes = await supabase
      .from('vendors')
      .select('id, name')
      .eq('id', vendorId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(vendorRes.error, { site: 'serverAction.maintenance.bulkAssignVendor.vendor', orgId: membership.org_id })) {
      return { error: 'Could not verify the vendor. Please try again.' }
    }
    const vendor = vendorRes.data

    if (!vendor) return { error: 'Vendor not found' }

    if (await isVendorHardBlocked(supabase, vendorId, membership.org_id)) {
      return { error: VENDOR_HARD_BLOCKED_ERROR }
    }

    // Fails closed, and it can afford to: this read is before the UPDATE, so
    // an early return leaves nothing half-done. A silent null skipped
    // trackVendorAssignmentAgainstSuggestions entirely, which left every work
    // order in the batch on suggestion_status 'pending' forever — the UI keeps
    // offering accept/dismiss on an already-assigned WO, and nothing
    // reconciles it later — while the vendor-scoring loop recorded nothing.
    const workOrdersRes = await supabase
      .from('work_orders')
      .select('id, suggestion_status, suggested_vendor_ids')
      .in('id', workOrderIds)
      .eq('org_id', membership.org_id)
      .limit(SUPABASE_MAX_ROWS)

    if (reportQueryError(workOrdersRes.error, { site: 'serverAction.maintenance.bulkAssignVendor.workOrders', orgId: membership.org_id })) {
      return { error: 'Could not load the selected work orders. Please try again.' }
    }
    const workOrders = workOrdersRes.data

    // The row count is read back and compared against the ids the org-scoped
    // read above actually returned. `.in('id', …)` matching FEWER rows than
    // asked for is silent — no error, just a shorter result — so a bulk assign
    // where every id was foreign or refused wrote nothing at all and still
    // reported success, having already told the PM the vendor was assigned.
    const { data: assignedRows, error } = await supabase
      .from('work_orders')
      .update({ vendor_id: vendorId, assigned_crew_member_id: null })
      .in('id', workOrderIds)
      .eq('org_id', membership.org_id)
      .select('id')

    if (error) {
      console.error('[bulkAssignVendor]', error)
      reportError(error, { site: 'serverAction.maintenance.bulkAssignVendor.update', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!assignedRows?.length) return { error: NOTHING_UPDATED }

    // Advance the status too. Both vendor-assignment paths now split the vendor
    // write from the status advance so the status only ever moves FORWARD; this
    // path used to write vendor_id alone, so a bulk-assigned work order kept
    // saying `pending` while carrying a vendor and having already emailed them.
    // Production had two of those and not a single work order in `assigned` or
    // `in_progress` at all.
    //
    // A SECOND, filtered statement rather than a column on the update above:
    // the vendor must be set on every selected row, but the status must only
    // move FORWARD. Folding it in would either drag an in_progress work order
    // back to `assigned` on a reassignment, or (if filtered inline) skip the
    // vendor write on exactly the rows that are mid-flight.
    const { error: statusError } = await supabase
      .from('work_orders')
      .update({ status: 'assigned' })
      .in('id', workOrderIds)
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'quote_requested'])

    // Reported, not returned: the vendor IS assigned and about to be emailed.
    // Failing the whole action here would tell the PM nothing happened.
    if (statusError) {
      console.error('[bulkAssignVendor] status advance failed', statusError)
      reportError(statusError, {
        site: 'serverAction.maintenance.bulkAssignVendor.status', orgId: membership.org_id,
      })
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

/**
 * The statuses a pending vendor suggestion may still be accepted from.
 *
 * An ALLOWLIST, not a `completed`/`cancelled` denylist, so a wo_status value
 * added later fails closed rather than silently joining the acceptable set.
 */
const VENDOR_SUGGESTION_ACCEPTABLE_STATUSES = [
  'pending', 'quote_requested', 'assigned', 'in_progress',
] as const

function terminalVendorSuggestionError(status: string): string {
  if (status === 'cancelled') {
    return 'This work order was cancelled — accepting the suggestion would reopen it.'
  }
  return 'This work order is already complete — accepting the suggestion would reopen it.'
}

export async function acceptVendorSuggestion(workOrderId: string): Promise<{ error?: string }> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const woRes = await supabase
      .from('work_orders')
      .select('id, status, suggested_vendor_ids')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(woRes.error, { site: 'serverAction.maintenance.acceptVendorSuggestion', orgId: membership.org_id })) {
      return { error: 'Could not load the work order. Please try again.' }
    }
    const wo = woRes.data

    if (!wo) return { error: 'Work order not found' }

    // bulkAssignVendor — the OTHER way a PM assigns a vendor — already splits
    // the vendor write from the status advance so the status only moves
    // FORWARD. This path still folded `status: 'assigned'` into one
    // unconditional update, so accepting a suggestion on a completed work order
    // reopened it, and accepting on an in_progress one dragged it back to
    // `assigned`. Terminal states are refused outright; the rest advance only
    // from the two pre-vendor statuses, exactly as bulkAssignVendor does.
    if (!(VENDOR_SUGGESTION_ACCEPTABLE_STATUSES as readonly string[]).includes(wo.status)) {
      return { error: terminalVendorSuggestionError(wo.status) }
    }

    const vendorId = (wo.suggested_vendor_ids as string[] | null)?.[0]
    if (!vendorId) return { error: 'No suggestion to accept' }

    if (await isVendorHardBlocked(supabase, vendorId, membership.org_id)) {
      return { error: VENDOR_HARD_BLOCKED_ERROR }
    }

    // The status allowlist repeats the check above as the ATOMIC one, so a
    // completion landing between the read and this write cannot be overwritten.
    // The row count is read back for the same reason it is everywhere else in
    // this file: a refused UPDATE returns 0 rows and NO error.
    const { data: accepted, error } = await supabase
      .from('work_orders')
      .update({ vendor_id: vendorId, suggestion_status: 'accepted' })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .in('status', VENDOR_SUGGESTION_ACCEPTABLE_STATUSES)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[acceptVendorSuggestion]', error)
      reportError(error, { site: 'serverAction.maintenance.acceptVendorSuggestion', orgId: membership.org_id })
      return { error: 'Failed to accept suggestion. Please try again.' }
    }
    if (!accepted) {
      return { error: 'You do not have permission to make this change, or the work order no longer exists.' }
    }

    // Forward-only, in its own filtered statement — see bulkAssignVendor.
    const { error: statusError } = await supabase
      .from('work_orders')
      .update({ status: 'assigned' })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'quote_requested'])

    // Reported, not returned: the vendor IS assigned and about to be notified.
    if (statusError) {
      console.error('[acceptVendorSuggestion] status advance failed', statusError)
      reportError(statusError, { site: 'serverAction.maintenance.acceptVendorSuggestion.status', orgId: membership.org_id })
    }

    try {
      const { createServiceClient } = await import('@/lib/supabase/server')
      const service = createServiceClient({ system: 'action:maintenance-suggestion-tracking' })
      // `if (error) throw` is load-bearing, not decoration. A PostgREST builder
      // RESOLVES with { error } on a database failure — it never rejects — so
      // the bare `await` this replaces meant the catch below caught nothing and
      // its comment described a signal that could not fire. The turnovers-side
      // twins (acceptSuggestion/dismissSuggestion) have always thrown here.
      const { error: outcomeError } = await service.from('vendor_assignment_outcomes').upsert(
        { work_order_id: workOrderId, org_id: membership.org_id, vendor_id: vendorId, was_accepted: true, was_suggestion: true },
        { onConflict: 'work_order_id,vendor_id', ignoreDuplicates: false }
      )
      if (outcomeError) throw outcomeError
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

    // Fails closed BEFORE the dismissal write, same call as turnovers'
    // dismissSuggestion. A silent null left vendorId undefined, so the
    // "rejected" outcome row was never written (the algorithm keeps suggesting
    // the vendor the PM just rejected) and the audit row below recorded
    // `vendor_id: null` for a dismissal that did have one — an affirmatively
    // wrong row in the log someone reads during an incident. The update is
    // idempotent, so a retry gets both.
    const woRes = await supabase
      .from('work_orders')
      .select('suggested_vendor_ids')
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .maybeSingle()

    if (reportQueryError(woRes.error, { site: 'serverAction.maintenance.dismissVendorSuggestion', orgId: membership.org_id })) {
      return { error: 'Could not load the work order. Please try again.' }
    }
    const wo = woRes.data

    const { data: dismissed, error } = await supabase
      .from('work_orders')
      .update({ suggestion_status: 'dismissed' })
      .eq('id', workOrderId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[dismissVendorSuggestion]', error)
      reportError(error, { site: 'serverAction.maintenance.dismissVendorSuggestion', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    // The row count is what stops a refused dismissal from still writing the
    // negative training signal below — the same fix the turnovers-side
    // dismissSuggestion already carries.
    if (!dismissed) return { error: NOTHING_UPDATED }

    const vendorId = (wo?.suggested_vendor_ids as string[] | null)?.[0]
    if (vendorId) {
      try {
        const { createServiceClient } = await import('@/lib/supabase/server')
        const service = createServiceClient({ system: 'action:maintenance-suggestion-tracking' })
        // See acceptVendorSuggestion: an awaited builder resolves with
        // { error }, it does not reject, so without this throw the catch below
        // was unreachable for the failure it exists to report.
        const { error: outcomeError } = await service.from('vendor_assignment_outcomes').upsert(
          { work_order_id: workOrderId, org_id: membership.org_id, vendor_id: vendorId, was_accepted: false, was_suggestion: true },
          { onConflict: 'work_order_id,vendor_id', ignoreDuplicates: false }
        )
        if (outcomeError) throw outcomeError
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

/**
 * The first next_due_date for a schedule the caller did not supply one for.
 *
 * A schedule with a NULL next_due_date is INERT, not merely undated. Every
 * consumer selects on that column with a comparison — the maintenance cron
 * uses `.lt('next_due_date', today)` for overdue and `.lte(...)` for the alert
 * window, and cron-daily-wrapup's due section does the same — and in SQL a
 * NULL satisfies no comparison, so the row is absent from every one of those
 * result sets. It is not reported late; it is not reported at all. And the
 * only writer of next_due_date anywhere is the roll-forward after a work
 * order fires, which advances an EXISTING date. Nothing bootstraps a missing
 * one, so NULL is permanent.
 *
 * Two callers were shipping exactly that: schedules-browser.tsx's "add
 * schedule" hard-codes next_due_date: null with auto_create_wo: true, and
 * maintenance-board.tsx reads the field from a form input the PM may leave
 * blank. Both produced a schedule that renders as active with auto-create
 * ticked and silently never does anything. Deriving the date here rather than
 * at either call site is deliberate — it is the one place both go through,
 * and the property is about the stored row, not about any one form.
 *
 * (Mirrors the fallback the standard-template broadcast already applies in
 * maintenance-template-actions.ts, but frequency-aware: a weekly schedule
 * should not wait the flat 30 days that path uses.)
 */
function resolveFirstDueDate(
  scheduleType: ScheduleType,
  frequency:    ScheduleFrequency | null,
  monthDue:     number | null,
  provided:     string | null,
): string | null {
  if (provided) return provided

  const today = new Date()
  if (scheduleType === 'routine') {
    // No frequency is not a real state for a routine schedule, but the column
    // is nullable — calcNextDueDate's own default (monthly) covers it rather
    // than letting the row fall through to NULL.
    return calcNextDueDate(frequency ?? 'monthly', today).toISOString().split('T')[0]!
  }

  if (scheduleType === 'seasonal' && monthDue) {
    // The next occurrence of that month: this year if it has not passed,
    // otherwise next year. Carried over from the deleted setup-step action,
    // which is the only piece of it worth keeping.
    const year = today.getMonth() + 1 >= monthDue ? today.getFullYear() + 1 : today.getFullYear()
    return `${year}-${String(monthDue).padStart(2, '0')}-01`
  }

  // Seasonal with no month is genuinely underspecified — there is nothing to
  // derive from. The row stays dormant, and the UI flags it as unscheduled
  // rather than pretending a date we invented is what the PM meant.
  return null
}

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

    const owned = await verifyPropertyInOrg(supabase, membership.org_id, data.property_id, 'serverAction.maintenance.createMaintenanceSchedule')
    if (!owned.ok) return { error: owned.error }

    const { error } = await supabase.from('maintenance_schedules').insert({
      property_id:        data.property_id,
      org_id:             membership.org_id,
      name:               data.name,
      description:        data.description || null,
      schedule_type:      data.schedule_type,
      frequency:          data.frequency || null,
      month_due:          data.month_due || null,
      next_due_date:      resolveFirstDueDate(
        data.schedule_type, data.frequency || null, data.month_due || null, data.next_due_date || null,
      ),
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

    const { data: updated, error } = await supabase
      .from('maintenance_schedules')
      .update({
        name:               data.name,
        description:        data.description || null,
        schedule_type:      data.schedule_type,
        frequency:          data.frequency || null,
        month_due:          data.month_due || null,
        // Same derivation as create. An edit that clears the date would
        // otherwise re-open exactly the hole create just closed — and the
        // inline row editor sends the whole row on every Save, so clearing
        // the date box is a single keystroke away. Pausing a schedule is
        // is_active = false; a blank date has never meant "paused".
        next_due_date:      resolveFirstDueDate(
          data.schedule_type, data.frequency || null, data.month_due || null, data.next_due_date || null,
        ),
        estimated_cost:     data.estimated_cost || null,
        assigned_vendor_id: data.assigned_vendor_id || null,
        auto_create_wo:     data.auto_create_wo,
        instructions:       data.instructions || null,
      })
      .eq('id', scheduleId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[updateMaintenanceSchedule]', error)
      reportError(error, { site: 'serverAction.maintenance.updateMaintenanceSchedule', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!updated) return { error: NOTHING_UPDATED }

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

    const { data: deleted, error } = await supabase
      .from('maintenance_schedules')
      .update({ is_active: false })
      .eq('id', scheduleId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[deleteMaintenanceSchedule]', error)
      reportError(error, { site: 'serverAction.maintenance.deleteMaintenanceSchedule', orgId: membership.org_id })
      return { error: 'Operation failed. Please try again.' }
    }
    if (!deleted) return { error: NOTHING_UPDATED }

    revalidatePath('/maintenance')
    revalidatePath('/templates/maintenance/schedules')
    return { success: true }
  } catch (err) {
    console.error('[deleteMaintenanceSchedule]', err)
    reportError(err, { site: 'serverAction.maintenance.deleteMaintenanceSchedule' })
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

    const { data: updated, error } = await supabase
      .from('maintenance_schedules')
      .update(updates)
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[updateMaintenanceScheduleItem]', error)
      reportError(error, { site: 'serverAction.maintenance.updateMaintenanceScheduleItem', orgId: membership.org_id })
      return { error: 'Failed to update item' }
    }
    if (!updated) return { error: NOTHING_UPDATED }

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

    const { data: removed, error } = await supabase
      .from('maintenance_schedules')
      .update({ is_active: false })
      .eq('id', itemId)
      .eq('org_id', membership.org_id)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[removeMaintenanceScheduleItem]', error)
      reportError(error, { site: 'serverAction.maintenance.removeMaintenanceScheduleItem', orgId: membership.org_id })
      return { error: 'Failed to remove item' }
    }
    if (!removed) return { error: NOTHING_UPDATED }

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
    const owned = await verifyPropertyInOrg(supabase, membership.org_id, propertyId, 'serverAction.maintenance.addCatalogItemToProperty')
    if (!owned.ok) return { error: owned.error }

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
    const owned = await verifyPropertyInOrg(supabase, membership.org_id, propertyId, 'serverAction.maintenance.addCustomMaintenanceItem')
    if (!owned.ok) return { error: owned.error }

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

// recordMaintenanceCompletion was DELETED 2026-08-06. It was a second, and
// DIVERGENT, implementation of the schedule advance that already lives in
// advanceSchedulesAfterCompletion (./complete-work-order-helpers.ts), and it
// disagreed with the live one in three ways that would each have shipped as a
// bug the moment anything called it:
//
//   - it anchored next_due_date to TODAY on every completion. The live path
//     anchors to the schedule's own next_due_date, so a fixed calendar cadence
//     stays fixed; only a gap-driven (vacancy_gap_suggestion) completion
//     re-anchors to the actual date. Anchoring always-to-today silently walks
//     every recurring schedule later with each early completion.
//   - it ignored schedule_type entirely, so a seasonal or one-time schedule
//     would have been advanced as if routine.
//   - it SELECTed active_from_month / active_to_month and then never read
//     them, which is what a half-finished seasonal implementation looks like.
//
// It was also the only writer of maintenance_completions anywhere in the
// codebase, so that table has never held a row. Reviving the action rather
// than deleting it would have meant reviving the cadence drift with it.

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
