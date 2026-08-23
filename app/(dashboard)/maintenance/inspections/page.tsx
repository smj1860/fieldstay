import type { Metadata } from 'next'

import { requireOrgMember } from '@/lib/auth'
import { reportQueryError } from '@/lib/supabase/unwrap'

import { InspectionsView } from './inspections-view'

export const metadata: Metadata = { title: 'Inspections' }

/**
 * The inspections list — docs/INSPECTIONS_SPEC.md §9a puts this at a real route
 * rather than a `?tab=` on /maintenance, so back and forward work, it can be
 * bookmarked, and the overdue email has something to link to.
 *
 * A Server Component, deliberately, even though §8 makes the FILL screen
 * offline-capable. Starting an inspection is the one step that must be online
 * anyway (`started_at` is a server clock), so there is nothing to gain from
 * rendering the list from a cache that could be stale about which inspections
 * already exist.
 */
export default async function InspectionsPage() {
  const { supabase, membership } = await requireOrgMember()

  const [propertiesResult, inspectionsResult] = await Promise.all([
    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .order('name')
      // Bounded: plan-capped at 50 properties, so 200 is headroom rather than a
      // guess — but an explicit ceiling regardless, because an unbounded select
      // is truncated at max_rows silently and a missing property here reads as
      // "that property cannot be inspected".
      .limit(200),

    supabase
      .from('inspections')
      .select('id, property_id, form_version, started_at, completed_at, inspector_name, form_snapshot')
      .eq('org_id', membership.org_id)
      .order('started_at', { ascending: false })
      .limit(100),
  ])

  // Distinguished from "no inspections yet", which is what an unchecked
  // `data ?? []` would turn an RLS regression or an outage into.
  if (propertiesResult.error) {
    reportQueryError(propertiesResult.error, { site: 'page.maintenance.inspections.properties' })
  }
  if (inspectionsResult.error) {
    reportQueryError(inspectionsResult.error, { site: 'page.maintenance.inspections.list' })
  }

  return (
    <InspectionsView
      properties={propertiesResult.data ?? []}
      inspections={(inspectionsResult.data ?? []).map((row) => ({
        id:             row.id,
        propertyId:     row.property_id,
        startedAt:      row.started_at,
        completedAt:    row.completed_at,
        inspectorName:  row.inspector_name,
        // The form's identity comes from the SNAPSHOT, not from a join to the
        // live form: §5 freezes it precisely so a later re-seed cannot restate
        // which form a finished inspection was.
        formKey:        readFormKey(row.form_snapshot),
        formVersion:    row.form_version,
      }))}
      loadFailed={!!propertiesResult.error || !!inspectionsResult.error}
    />
  )
}

/** The snapshot is jsonb; read one field defensively rather than trusting shape. */
function readFormKey(snapshot: unknown): string {
  if (snapshot && typeof snapshot === 'object' && 'form_key' in snapshot) {
    const value = (snapshot as { form_key?: unknown }).form_key
    if (typeof value === 'string') return value
  }
  return 'unknown'
}
