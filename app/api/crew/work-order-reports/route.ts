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

type CrewSupabase = Extract<Awaited<ReturnType<typeof requireCrewMember>>, { ok: true }>['supabase']

interface CrewReportInput {
  report_id:    string
  property_id:  string
  asset_id:     string | null
  title:        string
  is_emergency: boolean
}

/** A lookup that either produced a value or already has the response to send. */
type LookupResult<T> = { ok: true; value: T } | { ok: false; response: NextResponse }

/** Validates the crew client's POST body. Fields are all client-supplied. */
function parseCrewReportBody(body: unknown): LookupResult<CrewReportInput> {
  const raw = (body ?? {}) as Record<string, unknown>

  const report_id   = typeof raw.report_id === 'string' ? raw.report_id : ''
  const property_id = typeof raw.property_id === 'string' ? raw.property_id : ''
  const title       = typeof raw.title === 'string' ? raw.title.trim() : ''

  if (!report_id)   return missingField('report_id')
  if (!property_id) return missingField('property_id')
  if (!title)       return missingField('title')

  return {
    ok:    true,
    value: {
      report_id,
      property_id,
      asset_id:     typeof raw.asset_id === 'string' ? raw.asset_id : null,
      title,
      is_emergency: raw.is_emergency === true,
    },
  }
}

function missingField(field: string): LookupResult<never> {
  return { ok: false, response: NextResponse.json({ error: `Missing ${field}` }, { status: 400 }) }
}

/**
 * The property the report is against, scoped to the crew member's org.
 *
 * PGRST116 is .single()'s "no rows" — a genuine 404, and the IDOR case (a
 * property outside the crew member's org) lands here too. Anything else is the
 * query itself failing, which must not be reported to an offline crew member as
 * "Property not found": that reads as permanent, so the Dexie outbox drops the
 * report instead of retrying a transient outage.
 */
async function loadReportProperty(
  supabase:   CrewSupabase,
  orgId:      string,
  propertyId: string,
): Promise<LookupResult<{ id: string; org_id: string; name: string | null }>> {
  const { data: property, error } = await supabase
    .from('properties')
    .select('id, org_id, name')
    .eq('id', propertyId)
    .eq('org_id', orgId)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('[CrewWorkOrderReport] property lookup', error)
    reportError(error, { site: 'api.crew.work-order-reports.propertyLookup', orgId })
    return { ok: false, response: NextResponse.json({ error: 'Something went wrong' }, { status: 503 }) }
  }

  if (!property) {
    return { ok: false, response: NextResponse.json({ error: 'Property not found' }, { status: 404 }) }
  }

  return { ok: true, value: property }
}

/**
 * The asset type behind the reported issue, or null when crew picked "Other".
 *
 * Crew never picks a category themselves — it's derived from the asset they
 * select. Same PGRST116 reasoning as the property lookup above.
 */
async function resolveReportAssetType(
  supabase:   CrewSupabase,
  orgId:      string,
  propertyId: string,
  assetId:    string | null,
): Promise<LookupResult<AssetType | null>> {
  if (!assetId) return { ok: true, value: null }

  const { data: asset, error } = await supabase
    .from('property_assets')
    .select('id, asset_type')
    .eq('id', assetId)
    .eq('property_id', propertyId)
    .eq('org_id', orgId)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('[CrewWorkOrderReport] asset lookup', error)
    reportError(error, { site: 'api.crew.work-order-reports.assetLookup', orgId })
    return { ok: false, response: NextResponse.json({ error: 'Something went wrong' }, { status: 503 }) }
  }

  if (!asset) {
    return { ok: false, response: NextResponse.json({ error: 'Asset not found' }, { status: 404 }) }
  }

  return { ok: true, value: asset.asset_type as AssetType }
}

export async function POST(request: NextRequest) {
  const parsed = parseCrewReportBody(await request.json().catch(() => null))
  if (!parsed.ok) return parsed.response
  const { report_id, property_id, asset_id, title, is_emergency } = parsed.value

  // Canonical crew gate (lib/crew-auth.ts) — a previous inline copy here
  // added an invite_accepted_at filter that locked out the ~third of live
  // crew rows onboarded outside the invite-link flow.
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { supabase, crew, user } = auth

  const propertyResult = await loadReportProperty(supabase, crew.org_id, property_id)
  if (!propertyResult.ok) return propertyResult.response
  const property = propertyResult.value

  const assetResult = await resolveReportAssetType(supabase, crew.org_id, property_id, asset_id)
  if (!assetResult.ok) return assetResult.response

  const category = categoryForAssetType(assetResult.value)
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
