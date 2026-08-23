// Starting an inspection — the server half, reached from the dashboard outbox.
//
// The device creates the inspection locally and queues it here (see
// lib/dexie/dashboard/start-inspection-local.ts). Online that drain happens
// within a second and this behaves exactly as the Server Action it replaced;
// offline it arrives on reconnect, possibly hours later.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CLOCK
//
// §8 used to require `started_at` to be a server clock. 20260823053931 revises
// that: the device says what time it believed the walk began AND what time it
// believes it is NOW, both read at the same instant, so this can measure the
// skew and correct. A tablet four hours off still yields a correct start time;
// the only residual error is drift during the offline window.
//
// What survives unchanged is that the RECORD says which it was. `started_at`
// carries a `started_at_source`, and a device-timed start keeps its raw claim
// and the measured offset — so a report can show a duration as device-timed
// rather than presenting every duration as equally authoritative.

import { NextResponse } from 'next/server'

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { verifyPropertyInOrg } from '@/lib/tenancy/verify'
import { getPmMembers } from '@/lib/inngest/helpers'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import {
  buildHeaderSnapshot,
  parseFormSnapshot,
  recordedConditions,
  reportedConditions,
  type ConditionsSnapshot,
} from '@/lib/inspections/snapshots'
import { resolveStartTime } from '@/lib/inspections/start-time'
import { createServiceClient } from '@/lib/supabase/server'
import type { OrgMembership } from '@/lib/auth'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * How stale a start may be before the weather stops being evidence.
 *
 * §12.3 wants conditions because "a roof assessed under six inches of snow was
 * not really assessed". That is a claim about the weather DURING the walk. A
 * create that arrives six hours late would attach the weather at sync time,
 * which is a different afternoon — so past this window it records nothing
 * rather than something confidently wrong.
 */
const WEATHER_FRESHNESS_MS = 2 * 60 * 60 * 1000

/** A clock this far out is not skew, it is a broken or spoofed device. */
const MAX_PLAUSIBLE_OFFSET_SECONDS = 10 * 365 * 24 * 60 * 60

export async function POST(req: Request) {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const body = await req.json().catch(() => null)
    const parsed = parseBody(body)
    if ('error' in parsed) {
      return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 })
    }

    const verified = await verifyPropertyInOrg(
      supabase, membership.org_id, parsed.propertyId, 'route.inspections.create',
    )
    if (!verified.ok) {
      // 400, not 500 — terminal for the outbox. A property that is not this
      // org's will never become this org's by retrying.
      return NextResponse.json({ ok: false, error: verified.error }, { status: 400 })
    }

    const clock = resolveStartTime(parsed.deviceStartedAt, parsed.deviceNow)
    const property = await loadPropertyForHeader(supabase, membership.org_id, parsed.propertyId)
    if (!property) {
      return NextResponse.json({ ok: false, error: 'Could not load the property.' }, { status: 400 })
    }

    // ignoreDuplicates is what makes a replay safe: the drain deletes a queued
    // row only after its handler resolves, so a response lost in flight resends
    // the same create. ON CONFLICT DO NOTHING means the second one is a no-op
    // rather than a second inspection — and cannot overwrite one that has since
    // been completed.
    const { error } = await supabase
      .from('inspections')
      .upsert({
        id:            parsed.id,
        org_id:        membership.org_id,
        property_id:   parsed.propertyId,
        form_id:       parsed.formId,
        form_version:  parsed.formVersion,
        // The DEVICE's snapshot, deliberately. It records the form actually
        // walked; rebuilding it here would freeze whatever the form says now,
        // which after a re-seed is a different set of questions.
        form_snapshot: parsed.formSnapshot,
        header_snapshot: buildHeaderSnapshot({
          property,
          orgName:      membership.org?.name ?? '',
          orgOwnerName: await loadOrgOwnerName(supabase, membership.org_id, membership),
          conditions:   await captureConditions(property, clock.startedAt),
          capturedAt:   new Date().toISOString(),
        }),
        // §7. Validated below rather than trusted: a schedule id from a device
        // decides which schedule COMPLETION will advance, so an id belonging to
        // another org — or to a work-order schedule — must not be written.
        source_schedule_id:          await resolveSourceSchedule(supabase, membership.org_id, parsed.sourceScheduleId),
        scheduled_for:               parsed.scheduledFor,
        started_at:                  clock.startedAt,
        started_at_source:           'device',
        device_started_at:           parsed.deviceStartedAt,
        device_clock_offset_seconds: clock.offsetSeconds,
        assigned_to_user_id:         user.id,
      }, { onConflict: 'id', ignoreDuplicates: true })

    if (error) {
      reportError(error, { site: 'route.inspections.create' })
      // 500 so the outbox RETRIES. The inspection exists only on the device.
      return NextResponse.json({ ok: false, error: 'Could not start.' }, { status: 500 })
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inspection.started',
      targetType: 'inspection',
      targetId:   parsed.id,
      // Form and property only, plus the clock provenance — which is the one
      // thing an incident review would actually want here. No address, no owner
      // name: an audit row is not a second copy of the letterhead.
      metadata: {
        form_id: parsed.formId,
        property_id: parsed.propertyId,
        started_at_source: 'device',
        device_clock_offset_seconds: clock.offsetSeconds,
      },
    })

    return NextResponse.json({ ok: true, startedAt: clock.startedAt })
  } catch (err) {
    console.error('[inspections.create]', err)
    reportError(err, { site: 'route.inspections.create' })
    return NextResponse.json({ ok: false, error: 'Could not start.' }, { status: 500 })
  }
}

/**
 * The §7 schedule this walk satisfies, or null.
 *
 * Returns null rather than throwing for an id that does not resolve. The walk
 * is real and its answers are on a tablet; refusing the whole create because a
 * schedule link is stale would dead-letter it. The cost of null is that the
 * schedule does not advance and notifies again next occurrence, which is
 * visible and recoverable — the opposite is not.
 */
async function resolveSourceSchedule(
  supabase: SupabaseClient,
  orgId:    string,
  id:       string | null,
): Promise<string | null> {
  if (!id) return null

  const { data, error } = await supabase
    .from('maintenance_schedules')
    .select('id')
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('creates', 'inspection')
    .maybeSingle()

  if (error) {
    reportError(error, { site: 'route.inspections.create.sourceSchedule' })
    return null
  }
  return data?.id ?? null
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function loadPropertyForHeader(supabase: SupabaseClient, orgId: string, propertyId: string) {
  const { data, error } = await supabase
    .from('properties')
    .select('name, address, city, state, zip, lat, lng')
    .eq('org_id', orgId)
    .eq('id', propertyId)
    .maybeSingle()

  if (error) {
    reportError(error, { site: 'route.inspections.create.property' })
    return null
  }
  return data
}

/**
 * The org owner's display name for the letterhead. Null is a fine answer.
 *
 * getPmMembers, NOT a direct organization_members read: role-filtered
 * membership reads are a semgrep chokepoint and a guardrail so that "who counts
 * as an owner" — including the invite_accepted_at rule — has exactly one
 * definition. The service client's RLS bypass is justified by the requireOrgRole
 * above and scoped to that same org.
 */
async function loadOrgOwnerName(
  supabase:   SupabaseClient,
  orgId:      string,
  membership: OrgMembership,
): Promise<string | null> {
  const service = createServiceClient({ authorizedBy: membership })
  const [owner] = await getPmMembers(service, orgId, { roles: ['owner'], limit: 1 })
  if (!owner?.userId) return null

  const { data, error } = await supabase
    .from('profiles').select('full_name').eq('id', owner.userId).maybeSingle()

  if (error) {
    reportError(error, { site: 'route.inspections.create.owner' })
    return null
  }
  return data?.full_name ?? null
}

/**
 * Machine-recorded conditions where they still mean something.
 *
 * NEVER FATAL — a Tomorrow.io outage must not stop an inspection existing. And
 * never anachronistic: past WEATHER_FRESHNESS_MS the walk happened on a
 * different afternoon than this request, so recording today's weather as the
 * inspection's conditions would be inventing evidence.
 */
async function captureConditions(
  property:  { lat: number | null; lng: number | null },
  startedAt: string,
): Promise<ConditionsSnapshot | null> {
  if (Date.now() - Date.parse(startedAt) > WEATHER_FRESHNESS_MS) {
    return reportedConditions('Started offline — conditions not recorded at the time of the walk.')
  }
  if (property.lat === null || property.lng === null) return null

  try {
    return recordedConditions(await getWeatherForLocation(property.lat, property.lng))
  } catch (err) {
    // Warn, not report: an unavailable third-party forecast is an expected
    // operating condition, not a defect worth a Sentry issue per inspection.
    console.warn('[inspections.create] weather lookup failed:', err)
    return null
  }
}

// ── Validation ──────────────────────────────────────────────────────────────

interface ParsedCreate {
  id:              string
  propertyId:      string
  formId:          string
  formVersion:     number
  formSnapshot:    ReturnType<typeof parseFormSnapshot>
  deviceStartedAt: string
  deviceNow:       string
  /** §7's link, unvalidated here — resolveSourceSchedule checks it belongs. */
  sourceScheduleId: string | null
  scheduledFor:     string | null
}

function parseBody(body: unknown): ParsedCreate | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Malformed request.' }
  const r = body as Record<string, unknown>

  const id         = str(r.id)
  const propertyId = str(r.property_id)
  const formId     = str(r.form_id)
  if (!id || !propertyId || !formId) return { error: 'Malformed request.' }

  if (typeof r.form_version !== 'number' || !Number.isInteger(r.form_version)) {
    return { error: 'Malformed request.' }
  }

  // Parsed rather than trusted. A malformed snapshot is rejected here instead
  // of being stored, because a snapshot that will not parse later is an
  // inspection nobody can ever re-render — and the device still holds the only
  // good copy at this point, so failing loudly is recoverable.
  const formSnapshot = parseFormSnapshot(r.form_snapshot)
  if (!formSnapshot) return { error: 'That inspection form could not be read.' }

  const deviceStartedAt = str(r.device_started_at)
  const deviceNow       = str(r.device_now)
  if (!deviceStartedAt || !deviceNow) return { error: 'Malformed request.' }

  const startedMs = Date.parse(deviceStartedAt)
  const nowMs     = Date.parse(deviceNow)
  if (Number.isNaN(startedMs) || Number.isNaN(nowMs)) return { error: 'Malformed request.' }
  // The device cannot have started a walk after it thinks the present is. This
  // is the one internal contradiction the correction cannot absorb.
  if (startedMs > nowMs) return { error: 'That device’s clock is inconsistent.' }

  const offsetSeconds = Math.abs(Math.round((Date.now() - nowMs) / 1000))
  if (offsetSeconds > MAX_PLAUSIBLE_OFFSET_SECONDS) {
    return { error: 'That device’s clock is too far out to record a start time.' }
  }

  return {
    id, propertyId, formId, formVersion: r.form_version, formSnapshot,
    deviceStartedAt, deviceNow,
    sourceScheduleId: str(r.source_schedule_id),
    scheduledFor:     str(r.scheduled_for),
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}
