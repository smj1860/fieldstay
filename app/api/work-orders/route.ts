// Raising a work order — the server half, reached from the dashboard outbox.
//
// §8 widened offline support from inspections alone to the whole Maintenance
// page, for a reason that is about the job rather than the architecture: a PM
// standing at a property with no signal who notices a broken handrail wants to
// raise a work order, and "the inspection works offline but the work order does
// not" is a line drawn by us, not by them.
//
// ─────────────────────────────────────────────────────────────────────────────
// A ROUTE HANDLER, NOT THE SERVER ACTION
//
// The modal's `createWorkOrder` Server Action still exists and still handles
// the online path. This is deliberately a second ENTRY POINT and not a second
// IMPLEMENTATION: a queued row can outlive the release that wrote it — a tablet
// offline across a deploy — and Server Action ids are not stable across builds,
// so a replayed action would 404 and dead-letter work that exists nowhere else.
//
// Everything that decides whether the work order may exist, and what it looks
// like, is shared: `validateWorkOrderCreate` and `buildWorkOrderInsert` are the
// same functions the action calls. CLAUDE.md's rule for this path is explicit
// that it reuse them rather than reimplement them, and the reason has teeth —
// the tenant-isolation check on `assigned_crew_member_id` exists because a
// foreign org's crew id handed that tenant read access to the work order. A
// second create path that forgot it would reopen exactly that hole.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE OFFLINE PATH DELIBERATELY DOES NOT DO
//
// No quote requests and no portal link. Both are outbound dispatch that needs a
// network at the moment of choosing — an RFQ queued at a property and sent six
// hours later, to vendors whose compliance was checked against a stale cache,
// is worse than one the PM sends when they are back in signal. The offline
// create captures the FINDING; the dispatch decisions stay online, on a work
// order that by then exists and can be opened.
//
// `dispatchWorkOrderEvents` still runs when the row lands, because that is what
// notifies — and it runs HERE, at sync time, rather than being replayed from
// the device.

import { NextResponse } from 'next/server'

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import {
  buildWorkOrderInsert,
  dispatchWorkOrderEvents,
  validateWorkOrderCreate,
  type WorkOrderFormInput,
} from '@/app/(dashboard)/maintenance/create-work-order-helpers'
import { PriorityLevelSchema, WoCategorySchema } from '@/lib/schemas/work-order'

export async function POST(req: Request) {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const body = await req.json().catch(() => null)
    const parsed = parseBody(body)
    if ('error' in parsed) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
    }

    const valid = await validateWorkOrderCreate(supabase, membership.org_id, parsed.input)
    if (!valid.ok) {
      // 400, not 500 — TERMINAL for the outbox. A hard-blocked vendor or a
      // property that is not this org's will not become acceptable by retrying,
      // and burning five attempts only delays the banner telling the PM why.
      return NextResponse.json({ ok: false, error: valid.error }, { status: 400 })
    }

    const { payload, usePortal } = buildWorkOrderInsert(parsed.input, membership.org_id)

    // The DEVICE's id, and ignoreDuplicates, are what make a replay safe: the
    // drain deletes a queued row only after its handler resolves, so a response
    // lost in flight resends the same create. ON CONFLICT DO NOTHING makes the
    // second one a no-op rather than a second work order.
    //
    // `.select('id')` returns ONLY the rows actually inserted, so an empty
    // result is how this tells a first write from a replay — which decides
    // whether the notifications below fire again.
    const { data: inserted, error } = await supabase
      .from('work_orders')
      .upsert({ ...payload, id: parsed.id }, { onConflict: 'id', ignoreDuplicates: true })
      .select('id')

    if (error) {
      reportError(error, { site: 'route.work-orders.create' })
      // 500 so the outbox RETRIES: until this lands, the work order exists only
      // on the tablet that raised it.
      return NextResponse.json({ ok: false, error: 'Could not raise the work order.' }, { status: 500 })
    }

    // A replay. The work order is already there, its events already fired, and
    // re-dispatching would notify a vendor twice for one job.
    if (!inserted?.length) return NextResponse.json({ ok: true, duplicate: true })

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      // The existing action, not a new one: this IS a work order creation, and
      // HOW it arrived belongs in metadata rather than in a parallel verb that
      // every audit query would then have to know about.
      action:     'work_order.created',
      targetType: 'work_order',
      targetId:   parsed.id,
      // Provenance only. NEVER the title, description or cost: the title is
      // free text a PM typed at a property and the cost is financial detail,
      // and an audit row is not a second place for either.
      metadata: { property_id: parsed.input.property_id, source: 'offline_outbox' },
    })

    await dispatchWorkOrderEvents({
      workOrderId:          parsed.id,
      propertyId:           parsed.input.property_id,
      orgId:                membership.org_id,
      vendorId:             parsed.input.vendor_id,
      usePortal,
      requestQuotes:        false,
      category:             parsed.input.category,
      assignedCrewMemberId: parsed.input.assigned_crew_member_id,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[work-orders.create]', err)
    reportError(err, { site: 'route.work-orders.create' })
    return NextResponse.json({ ok: false, error: 'Could not raise the work order.' }, { status: 500 })
  }
}

/** Free text off a tablet. Long enough for a real description, not a payload. */
const MAX_TEXT = 2_000

type ParsedBody =
  | { id: string; input: WorkOrderFormInput }
  | { error: string }

/**
 * Validates the SHAPE. `validateWorkOrderCreate` then validates the meaning.
 *
 * The payload was assembled on a tablet and held in IndexedDB, possibly across
 * a release. None of that makes it hostile; none of it makes it trustworthy.
 * The same bias as the inspection submit parser applies — reject a wrong shape,
 * tolerate a missing optional value — because a rejection here is terminal and
 * the work order exists nowhere else.
 */
function parseBody(body: unknown): ParsedBody {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const r = body as Record<string, unknown>

  if (typeof r.id !== 'string' || !r.id) return { error: 'Malformed request.' }

  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) return { error: 'Title is required' }
  if (title.length > MAX_TEXT) return { error: 'That title is too long.' }

  if (typeof r.property_id !== 'string' || !r.property_id) {
    return { error: 'Property is required' }
  }

  const description = optionalText(r.description)
  if (description === false) return { error: 'That description is too long.' }

  return {
    id: r.id,
    input: {
      title,
      property_id:             r.property_id,
      description,
      priority:                PriorityLevelSchema.safeParse(r.priority).data ?? 'medium',
      category:                WoCategorySchema.safeParse(r.category).data ?? null,
      vendor_id:               optionalId(r.vendor_id),
      assigned_crew_member_id: optionalId(r.assigned_crew_member_id),
      scheduled_date:          optionalId(r.scheduled_date),
      scheduled_time:          optionalId(r.scheduled_time),
      estimated_cost:          optionalNumber(r.estimated_cost),
      nte_amount:              optionalNumber(r.nte_amount),
      asset_id:                optionalId(r.asset_id),
      // Both forced off — see the header. Neither decision can be made
      // responsibly against a cache that may be hours old.
      portal_enabled:          false,
      request_quotes:          false,
      quote_vendor_ids:        [],
    },
  }
}

/** `false` means present-but-invalid, which is different from absent. */
function optionalText(value: unknown): string | null | false {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return false
  return value.length > MAX_TEXT ? false : value.trim()
}

/** An absent, empty or non-string id is simply "not provided". */
function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * NaN is neither null nor undefined, so `??` never catches it and every
 * comparison against it is false — Number.isFinite is the only guard that stops
 * a garbage cost reaching the insert.
 */
function optionalNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}
