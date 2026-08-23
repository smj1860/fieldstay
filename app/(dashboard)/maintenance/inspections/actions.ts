'use server'

// Starting an inspection.
//
// This is the ONE step of the whole flow that must be online, and
// docs/INSPECTIONS_SPEC.md §8 says why in the course of resolving the 24-hour
// rule against offline work: "`started_at` is server time, stamped when the
// inspection row is created — at assignment or first open, both of which are
// online. A device clock is both skewable and, for an artifact whose entire
// value is being believed, the wrong thing to trust."
//
// Everything after this — answering, photographing, signing — happens against
// the local cache and drains through the dashboard outbox. This action exists
// to put a row on the server with a server clock on it, and to freeze the two
// things that would otherwise be silently re-rendered later.

import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { verifyPropertyInOrg } from '@/lib/tenancy/verify'
import { getPmMembers } from '@/lib/inngest/helpers'
import { getWeatherForLocation } from '@/lib/weather/tomorrow'
import {
  buildFormSnapshot,
  buildHeaderSnapshot,
  recordedConditions,
  reportedConditions,
  type ConditionsSnapshot,
} from '@/lib/inspections/snapshots'
import { createServiceClient } from '@/lib/supabase/server'
import type { OrgMembership } from '@/lib/auth'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface StartInspectionResult {
  ok:            boolean
  inspectionId?: string
  error?:        string
}

interface StartInspectionInput {
  propertyId: string
  formKey:    'safety' | 'indoor' | 'outdoor'
  /**
   * Typed conditions, used ONLY when the weather lookup does not resolve.
   * §12.3: offline it will not resolve at all, which is exactly when an outdoor
   * inspection is most likely to be happening.
   */
  reportedConditionsText?: string
}

/**
 * Creates the inspection row and returns its id.
 *
 * admin|manager (is_org_member passes 'owner' unconditionally) — §5's note that
 * whoever the PM hands the tablet to counts as the inspector is about the NAME
 * typed at sign-off, not about who may start one.
 */
export async function startInspection(input: StartInspectionInput): Promise<StartInspectionResult> {
  try {
    const { supabase, membership, user } = await requireOrgRole(['admin', 'manager'])

    const verified = await verifyPropertyInOrg(
      supabase, membership.org_id, input.propertyId, 'serverAction.inspections.startInspection',
    )
    if (!verified.ok) return { ok: false, error: verified.error }

    const form = await loadActiveForm(supabase, input.formKey)
    if (!form) return { ok: false, error: 'That inspection form is not available. Please try again.' }

    const property = await loadPropertyForHeader(supabase, membership.org_id, input.propertyId)
    if (!property) return { ok: false, error: 'Could not load the property. Please try again.' }

    const capturedAt = new Date().toISOString()

    const { data: inspection, error } = await supabase
      .from('inspections')
      .insert({
        org_id:       membership.org_id,
        property_id:  input.propertyId,
        form_id:      form.id,
        form_version: form.version,
        form_snapshot: buildFormSnapshot(
          form.key, form.version, form.sections, form.items, capturedAt,
        ),
        header_snapshot: buildHeaderSnapshot({
          property,
          orgName:      membership.org?.name ?? '',
          orgOwnerName: await loadOrgOwnerName(supabase, membership.org_id, membership),
          conditions:   await captureConditions(property, input.reportedConditionsText),
          capturedAt,
        }),
        // NOT set from the client and NOT defaulted away: started_at's whole
        // job is to be a server clock. The column's DEFAULT now() supplies it.
        assigned_to_user_id: user.id,
      })
      .select('id')
      .single()

    if (error || !inspection) {
      console.error('[startInspection]', error)
      reportError(error, { site: 'serverAction.inspections.startInspection' })
      return { ok: false, error: 'Could not start the inspection. Please try again.' }
    }

    await logAuditEvent({
      orgId:      membership.org_id,
      actorId:    user.id,
      action:     'inspection.started',
      targetType: 'inspection',
      targetId:   inspection.id,
      // Form and property only. No address, no owner name — an audit row is for
      // staff investigating an incident, not a second copy of the letterhead.
      metadata:   { form_key: input.formKey, property_id: input.propertyId },
    })

    revalidatePath('/maintenance/inspections')
    return { ok: true, inspectionId: inspection.id }
  } catch (err) {
    unstable_rethrow(err)
    console.error('[startInspection]', err)
    reportError(err, { site: 'serverAction.inspections.startInspection' })
    return { ok: false, error: 'Could not start the inspection. Please try again.' }
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────


/**
 * The highest active version of a form, with every section and item.
 *
 * `.limit()` on both child reads rather than leaving them open: these are
 * platform tables with no org dimension, so PostgREST's max_rows would truncate
 * them silently, and a truncated FORM is not a short list — it is a form
 * missing questions that the snapshot then records as never having been asked.
 */
async function loadActiveForm(supabase: SupabaseClient, formKey: string) {
  const { data: form, error: formError } = await supabase
    .from('inspection_forms')
    .select('id, key, version')
    .eq('key', formKey)
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (formError || !form) {
    if (formError) reportError(formError, { site: 'serverAction.inspections.loadActiveForm' })
    return null
  }

  const { data: sections, error: sectionsError } = await supabase
    .from('inspection_form_sections')
    .select('*')
    .eq('form_id', form.id)
    .order('sort_order')
    .limit(100)

  const { data: items, error: itemsError } = await supabase
    .from('inspection_form_items')
    .select('*')
    .in('section_id', (sections ?? []).map((s) => s.id))
    .order('sort_order')
    .limit(1000)

  if (sectionsError || itemsError || !sections || !items) {
    reportError(sectionsError ?? itemsError, { site: 'serverAction.inspections.loadActiveForm' })
    return null
  }

  return { id: form.id, key: form.key, version: form.version, sections, items }
}

async function loadPropertyForHeader(supabase: SupabaseClient, orgId: string, propertyId: string) {
  const { data, error } = await supabase
    .from('properties')
    .select('name, address, city, state, zip, lat, lng')
    .eq('org_id', orgId)
    .eq('id', propertyId)
    .maybeSingle()

  if (error) {
    reportError(error, { site: 'serverAction.inspections.loadPropertyForHeader' })
    return null
  }
  return data
}

/**
 * The org owner's display name for the letterhead.
 *
 * Null is a perfectly good answer — the letterhead prints what it has. An org
 * with no accepted owner row is unusual but not a reason to refuse to start an
 * inspection.
 */
async function loadOrgOwnerName(
  supabase:   SupabaseClient,
  orgId:      string,
  membership: OrgMembership,
): Promise<string | null> {
  // getPmMembers, NOT a direct organization_members read. Role-filtered
  // membership reads are a semgrep chokepoint and a guardrail: they belong in
  // the auth/notification helpers so that "who counts as an owner" — including
  // the invite_accepted_at rule — has exactly one definition. Open-coding it
  // here is how that rule drifts, and it has drifted before.
  // A SERVICE client, and the context argument names why: getPmMembers is the
  // sanctioned reader for role-filtered membership and is typed for one. The
  // RLS bypass is justified by the requireOrgRole above — the caller is already
  // proven an admin/manager of this org — and the read is scoped to that same
  // orgId, so nothing crosses a tenant boundary.
  const service = createServiceClient({ authorizedBy: membership })
  const [owner] = await getPmMembers(service, orgId, { roles: ['owner'], limit: 1 })
  if (!owner?.userId) return null

  const { data, error } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', owner.userId)
    .maybeSingle()

  if (error) {
    reportError(error, { site: 'serverAction.inspections.loadOrgOwnerName' })
    return null
  }
  return data?.full_name ?? null
}

/**
 * Machine-recorded conditions where possible, the inspector's typed text where
 * not, and null where neither exists.
 *
 * NEVER FATAL. §12.3 wants the weather because "a roof assessed under six
 * inches of snow was not really assessed" — it is context on the report, not a
 * precondition for walking the property. A Tomorrow.io outage must not stop an
 * inspection starting.
 */
async function captureConditions(
  property: { lat: number | null; lng: number | null },
  reportedText: string | undefined,
): Promise<ConditionsSnapshot | null> {
  if (property.lat !== null && property.lng !== null) {
    try {
      const recorded = recordedConditions(await getWeatherForLocation(property.lat, property.lng))
      if (recorded) return recorded
    } catch (err) {
      // Warn, not report: an unavailable third-party forecast is an expected
      // operating condition, not a defect worth a Sentry issue per inspection.
      console.warn('[startInspection] weather lookup failed; falling back to reported conditions:', err)
    }
  }
  return reportedText ? reportedConditions(reportedText) : null
}
