import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { reportError } from '@/lib/observability/report-error'
import { logAuditEvent } from '@/lib/audit'
import { categoryForAssetType } from '@/lib/asset-discovery/config'
import type { AssetType, PriorityLevel } from '@/types/database'

/**
 * Tell the PM, immediately, that crew flagged something.
 *
 * This route is the ONE crew work-order path. It previously did a bare insert
 * and stopped — no Inngest event of any kind — so unlike the PM and
 * scheduled-maintenance paths nothing notified anyone. The work order sat at
 * status 'pending' with no vendor until it surfaced in the 6pm daily wrap-up
 * digest (which sweeps `vendor_id IS NULL`): up to a day's delay, and the same
 * delay whether crew flagged a loose cabinet or a burst pipe.
 *
 * Deliberately NOT a vendor auto-suggest. The PM and schedule paths fire
 * `work-order/vendor-suggestion.requested`; crew flags stay a manual triage
 * queue by product decision. This closes the notification gap only.
 *
 * A service client is required: `notifications` is system-inserted only (org
 * members hold SELECT and an UPDATE on read_at, and no INSERT policy at all),
 * while crew authenticate with the RLS-enforced client from
 * requireCrewMember().
 *
 * Non-fatal in every direction — the work order is already committed, and a
 * failed notification must not turn a successful crew report into an error the
 * crew member is asked to retry.
 */
async function notifyPmOfCrewFlag(
  crew: { id: string; org_id: string },
  n: {
    orgId:        string
    /** Stable across Dexie-outbox retries; the work order id is not. */
    reportId:     string
    workOrderId?: string | null
    propertyName: string | null
    issueTitle:   string
    urgent:       boolean
  },
): Promise<void> {
  try {
    const supabase = createServiceClient({ crew })

    // On the duplicate path the insert returned no row, so recover the id the
    // first attempt created — the notification is worthless without a link.
    let workOrderId = n.workOrderId ?? null
    if (!workOrderId) {
      const { data, error: lookupError } = await supabase
        .from('work_orders')
        .select('id')
        .eq('client_report_id', n.reportId)
        .eq('org_id', n.orgId)
        .maybeSingle()

      // "The row isn't there" and "the lookup failed" are different problems,
      // and only the second one is worth reporting — collapsing them would
      // hide an outage behind a silent no-notification.
      if (lookupError) {
        console.error('[notifyPmOfCrewFlag] work order lookup', lookupError)
        reportError(lookupError, {
          site:  'api.crew.work-order-reports.notifyPm.lookup',
          orgId: n.orgId,
        })
        return
      }
      workOrderId = data?.id ?? null
    }
    if (!workOrderId) return

    const where = n.propertyName ? ` at ${n.propertyName}` : ''

    await createPmNotification(supabase, {
      orgId:     n.orgId,
      type:      'work_order_created',
      title:     `${n.urgent ? '🚨 Urgent — ' : ''}Crew flagged an issue${where}`,
      subtitle:  n.issueTitle,
      href:      `/maintenance/${workOrderId}`,
      severity:  n.urgent ? 'red' : 'amber',
      // Keyed on the client report id, not the work order id: the outbox
      // re-POSTs the same report after a dropped response, and this is what
      // makes the re-notify above a no-op rather than a second bell.
      dedupeKey: `crew-flag-${n.reportId}`,
    })
  } catch (err) {
    console.error('[notifyPmOfCrewFlag]', err)
    reportError(err, { site: 'api.crew.work-order-reports.notifyPm', orgId: n.orgId })
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)

  const report_id    = typeof body?.report_id === 'string' ? body.report_id : null
  const property_id  = typeof body?.property_id === 'string' ? body.property_id : null
  const asset_id     = typeof body?.asset_id === 'string' ? body.asset_id : null
  const title        = typeof body?.title === 'string' ? body.title.trim() : ''
  const is_emergency = body?.is_emergency === true

  if (!report_id)   return NextResponse.json({ error: 'Missing report_id' }, { status: 400 })
  if (!property_id) return NextResponse.json({ error: 'Missing property_id' }, { status: 400 })
  if (!title)       return NextResponse.json({ error: 'Missing title' }, { status: 400 })

  // Canonical crew gate (lib/crew-auth.ts) — a previous inline copy here
  // added an invite_accepted_at filter that locked out the ~third of live
  // crew rows onboarded outside the invite-link flow.
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { supabase, crew, user } = auth

  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('id, org_id, name')
    .eq('id', property_id)
    .eq('org_id', crew.org_id)
    .single()

  // PGRST116 is .single()'s "no rows" — a genuine 404, and the IDOR case
  // (a property outside the crew member's org) lands here too. Anything else
  // is the query itself failing, which must not be reported to an offline crew
  // member as "Property not found": that reads as permanent, so the Dexie
  // outbox drops the report instead of retrying a transient outage.
  if (propertyError && propertyError.code !== 'PGRST116') {
    console.error('[CrewWorkOrderReport] property lookup', propertyError)
    reportError(propertyError, {
      site:  'api.crew.work-order-reports.propertyLookup',
      orgId: crew.org_id,
    })
    return NextResponse.json({ error: 'Something went wrong' }, { status: 503 })
  }

  if (!property) return NextResponse.json({ error: 'Property not found' }, { status: 404 })

  // Crew never picks a category themselves — it's derived from the asset
  // they select (falls back to 'general' for "Other" / no asset).
  let assetType: AssetType | null = null
  if (asset_id) {
    const { data: asset, error: assetError } = await supabase
      .from('property_assets')
      .select('id, asset_type')
      .eq('id', asset_id)
      .eq('property_id', property_id)
      .eq('org_id', crew.org_id)
      .single()

    // Same reasoning as the property lookup above: PGRST116 is a genuine
    // 404, anything else is the query itself failing.
    if (assetError && assetError.code !== 'PGRST116') {
      console.error('[CrewWorkOrderReport] asset lookup', assetError)
      reportError(assetError, {
        site:  'api.crew.work-order-reports.assetLookup',
        orgId: crew.org_id,
      })
      return NextResponse.json({ error: 'Something went wrong' }, { status: 503 })
    }

    if (!asset) return NextResponse.json({ error: 'Asset not found' }, { status: 404 })
    assetType = asset.asset_type as AssetType
  }

  const category = categoryForAssetType(assetType)
  const priority: PriorityLevel = is_emergency ? 'urgent' : 'medium'

  const { data: created, error } = await supabase.from('work_orders').insert({
    org_id:                     property.org_id,
    property_id,
    asset_id,
    title,
    category,
    priority,
    status: 'pending',
    source: 'crew_flag',
    reported_by_crew_member_id: crew.id,
    client_report_id:           report_id,
  })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation on work_orders_client_report_id_unique — the
    // Dexie outbox retried this exact report (e.g. after a dropped
    // response, however long that retry was delayed). Same report_id means
    // it already landed; treat as success rather than a duplicate.
    //
    // Still notify. The retry exists precisely because the first response was
    // lost, and the notification may have been what was lost with it — the
    // dedupe_key below makes a second call a no-op, so re-notifying is free
    // and never-notifying is not recoverable.
    if (error.code === '23505') {
      await notifyPmOfCrewFlag(crew, {
        orgId:        crew.org_id,
        reportId:     report_id,
        propertyName: property.name,
        issueTitle:   title,
        urgent:       is_emergency,
      })
      return NextResponse.json({ success: true, duplicate: true })
    }
    console.error('[CrewWorkOrderReport]', error)
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 })
  }

  await notifyPmOfCrewFlag(crew, {
    orgId:        crew.org_id,
    reportId:     report_id,
    workOrderId:  created?.id ?? null,
    propertyName: property.name,
    issueTitle:   title,
    urgent:       is_emergency,
  })

  await logAuditEvent({
    orgId:      crew.org_id as string,
    actorId:    user.id,
    action:     'work_order.created',
    targetType: 'work_order',
    metadata:   { source: 'crew_flag', property_id, asset_id, title },
  })

  return NextResponse.json({ success: true })
}
