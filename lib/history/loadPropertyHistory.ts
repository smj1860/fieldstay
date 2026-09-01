import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { unwrapList, unwrapCount } from '@/lib/supabase/unwrap'

// "Show me what happened" — Implementation Instructions, Workstream 1: an
// assembly job over data FieldStay already records, not a new capability.
// One screen — pick a property, pick a date range, read what happened in
// chronological order.
//
// CAPS. A date-windowed read is still an unbounded read — the window caps
// the days, not the rows, so the real ceiling is entities × period
// (CLAUDE.md's semgrep -windowed-select-unbounded rule exists for exactly
// this shape). Each of the six sources below is capped independently and
// its TRUE count fetched via a `count: 'exact', head: true` query, so a
// truncated result states so rather than silently reading as complete — the
// same discipline lib/inspections/report/model.ts's MAX_HISTORY_INSPECTIONS
// family follows. Recorded in CLAUDE.md's cap table and cross-checked by
// unit/guardrails/report-export-caps.test.ts.
export const MAX_HISTORY_EVENTS_PER_SOURCE = 200

export type PropertyHistoryEventType =
  | 'checklist_step'
  | 'work_order_update'
  | 'work_order_photo'
  | 'crew_assignment'
  | 'inspection_submitted'
  | 'inventory_count'

export interface PropertyHistoryEvent {
  type:             PropertyHistoryEventType
  occurredAt:       string
  title:            string
  detail:           string | null
  actorName:        string | null
  photoStoragePath: string | null
}

export interface PropertyHistoryResult {
  events:        PropertyHistoryEvent[]
  /** True count across all six sources in the window, before any cap. */
  totalCount:    number
  /** `totalCount - events.length` — 0 when nothing was truncated. */
  omittedCount:  number
}

interface LoadParams {
  supabase:   SupabaseClient
  orgId:      string
  propertyId: string
  /** Inclusive, ISO date or timestamp. */
  from: string
  /** Inclusive, ISO date or timestamp. */
  to:   string
}

/**
 * Loads everything that happened at one property in one date range, merged
 * into one chronological timeline. Every query is scoped to `propertyId`
 * (already verified to belong to `orgId` by the caller — see
 * app/(dashboard)/properties/[id]/history/page.tsx's use of
 * lib/auth.ts's requireProperty()) AND runs through the caller's
 * RLS-scoped `supabase` client, so tenant isolation is enforced twice.
 */
export async function loadPropertyHistory(params: LoadParams): Promise<PropertyHistoryResult> {
  const { supabase, propertyId, from, to } = params
  const CAP = MAX_HISTORY_EVENTS_PER_SOURCE

  const [
    checklistRes, checklistCountRes,
    woUpdatesRes, woUpdatesCountRes,
    woPhotosRes, woPhotosCountRes,
    assignmentsRes, assignmentsCountRes,
    inspectionsRes, inspectionsCountRes,
    countsRes, countsCountRes,
  ] = await Promise.all([
    supabase
      .from('checklist_instance_items')
      .select('id, task, section_name, completed_at, crew_notes, photo_storage_path, crew_members(name), turnovers!inner(property_id)')
      .eq('turnovers.property_id', propertyId)
      .eq('is_completed', true)
      .gte('completed_at', from).lte('completed_at', to)
      .order('completed_at', { ascending: true })
      .limit(CAP),
    supabase
      .from('checklist_instance_items')
      .select('id, turnovers!inner(property_id)', { count: 'exact', head: true })
      .eq('turnovers.property_id', propertyId)
      .eq('is_completed', true)
      .gte('completed_at', from).lte('completed_at', to),

    supabase
      .from('work_order_updates')
      .select('id, status_from, status_to, notes, updated_by_user_id, updated_via_vendor_portal, created_at, work_orders!inner(property_id, title, wo_number)')
      .eq('work_orders.property_id', propertyId)
      .gte('created_at', from).lte('created_at', to)
      .order('created_at', { ascending: true })
      .limit(CAP),
    supabase
      .from('work_order_updates')
      .select('id, work_orders!inner(property_id)', { count: 'exact', head: true })
      .eq('work_orders.property_id', propertyId)
      .gte('created_at', from).lte('created_at', to),

    supabase
      .from('work_order_photos')
      .select('id, storage_path, uploaded_by, created_at, work_orders!inner(property_id, title, wo_number)')
      .eq('work_orders.property_id', propertyId)
      .gte('created_at', from).lte('created_at', to)
      .order('created_at', { ascending: true })
      .limit(CAP),
    supabase
      .from('work_order_photos')
      .select('id, work_orders!inner(property_id)', { count: 'exact', head: true })
      .eq('work_orders.property_id', propertyId)
      .gte('created_at', from).lte('created_at', to),

    supabase
      .from('turnover_assignments')
      .select('id, assigned_at, crew_members(name), turnovers(checkout_datetime, checkin_datetime)')
      .eq('property_id', propertyId)
      .gte('assigned_at', from).lte('assigned_at', to)
      .order('assigned_at', { ascending: true })
      .limit(CAP),
    supabase
      .from('turnover_assignments')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .gte('assigned_at', from).lte('assigned_at', to),

    supabase
      .from('inspections')
      .select('id, inspector_name, completed_at')
      .eq('property_id', propertyId)
      .not('completed_at', 'is', null)
      .gte('completed_at', from).lte('completed_at', to)
      .order('completed_at', { ascending: true })
      .limit(CAP),
    supabase
      .from('inspections')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .not('completed_at', 'is', null)
      .gte('completed_at', from).lte('completed_at', to),

    supabase
      .from('inventory_counts')
      .select('id, submitted_at, notes, crew_members(name)')
      .eq('property_id', propertyId)
      .gte('submitted_at', from).lte('submitted_at', to)
      .order('submitted_at', { ascending: true })
      .limit(CAP),
    supabase
      .from('inventory_counts')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', propertyId)
      .gte('submitted_at', from).lte('submitted_at', to),
  ])

  const site = 'lib.history.loadPropertyHistory'
  const orgId = params.orgId

  type ChecklistRow = {
    id: string; task: string; section_name: string; completed_at: string | null
    crew_notes: string | null; photo_storage_path: string | null
    crew_members: { name: string } | { name: string }[] | null
  }
  type WoUpdateRow = {
    id: string; status_from: string | null; status_to: string | null; notes: string | null
    updated_by_user_id: string | null; updated_via_vendor_portal: boolean; created_at: string
    work_orders: { title: string; wo_number: string | null } | { title: string; wo_number: string | null }[]
  }
  type WoPhotoRow = {
    id: string; storage_path: string; uploaded_by: string | null; created_at: string
    work_orders: { title: string; wo_number: string | null } | { title: string; wo_number: string | null }[]
  }
  type AssignmentRow = {
    id: string; assigned_at: string
    crew_members: { name: string } | { name: string }[] | null
    turnovers: { checkout_datetime: string } | { checkout_datetime: string }[] | null
  }
  type InspectionRow = { id: string; inspector_name: string | null; completed_at: string }
  type CountRow = {
    id: string; submitted_at: string; notes: string | null
    crew_members: { name: string } | { name: string }[] | null
  }

  const checklistRows    = unwrapList<ChecklistRow>(checklistRes, { site, orgId })
  const woUpdateRows      = unwrapList<WoUpdateRow>(woUpdatesRes, { site, orgId })
  const woPhotoRows       = unwrapList<WoPhotoRow>(woPhotosRes, { site, orgId })
  const assignmentRows    = unwrapList<AssignmentRow>(assignmentsRes, { site, orgId })
  const inspectionRows    = unwrapList<InspectionRow>(inspectionsRes, { site, orgId })
  const countRows         = unwrapList<CountRow>(countsRes, { site, orgId })

  const checklistCount    = unwrapCount(checklistCountRes, { site, orgId })
  const woUpdatesCount    = unwrapCount(woUpdatesCountRes, { site, orgId })
  const woPhotosCount     = unwrapCount(woPhotosCountRes, { site, orgId })
  const assignmentsCount  = unwrapCount(assignmentsCountRes, { site, orgId })
  const inspectionsCount  = unwrapCount(inspectionsCountRes, { site, orgId })
  const countsCount       = unwrapCount(countsCountRes, { site, orgId })

  /** A PostgREST to-one embed returns either an object or a one-element array, depending on the relationship's inferred cardinality. */
  function one<T>(value: T | T[] | null): T | null {
    if (Array.isArray(value)) return value[0] ?? null
    return value
  }

  const events: PropertyHistoryEvent[] = [
    ...checklistRows.map((row): PropertyHistoryEvent => ({
      type:             'checklist_step',
      occurredAt:       row.completed_at as string,
      title:            `${row.section_name}: ${row.task}`,
      detail:           row.crew_notes,
      actorName:        one(row.crew_members)?.name ?? null,
      photoStoragePath: row.photo_storage_path,
    })),
    ...woUpdateRows.map((row): PropertyHistoryEvent => {
      const wo = one(row.work_orders)
      const label = wo?.wo_number ? `${wo.wo_number} — ${wo.title}` : (wo?.title ?? 'Work order')
      return {
        type:       'work_order_update',
        occurredAt: row.created_at,
        title:      row.status_from
          ? `${label}: ${row.status_from} → ${row.status_to}`
          : `${label}: created (${row.status_to})`,
        detail:           row.notes,
        actorName:        row.updated_via_vendor_portal ? 'Vendor' : null,
        photoStoragePath: null,
      }
    }),
    ...woPhotoRows.map((row): PropertyHistoryEvent => {
      const wo = one(row.work_orders)
      const label = wo?.wo_number ? `${wo.wo_number} — ${wo.title}` : (wo?.title ?? 'Work order')
      return {
        type:             'work_order_photo',
        occurredAt:       row.created_at,
        title:            `Photo attached to ${label}`,
        detail:           null,
        actorName:        null,
        photoStoragePath: row.storage_path,
      }
    }),
    ...assignmentRows.map((row): PropertyHistoryEvent => {
      const turnover = one(row.turnovers)
      const crew = one(row.crew_members)
      return {
        type:       'crew_assignment',
        occurredAt: row.assigned_at,
        title:      `${crew?.name ?? 'Crew member'} assigned` +
          (turnover ? ` to the turnover checking out ${turnover.checkout_datetime.slice(0, 10)}` : ''),
        detail:           null,
        actorName:        crew?.name ?? null,
        photoStoragePath: null,
      }
    }),
    ...inspectionRows.map((row): PropertyHistoryEvent => ({
      type:             'inspection_submitted',
      occurredAt:       row.completed_at,
      title:            'Inspection submitted',
      detail:           null,
      actorName:        row.inspector_name,
      photoStoragePath: null,
    })),
    ...countRows.map((row): PropertyHistoryEvent => ({
      type:             'inventory_count',
      occurredAt:       row.submitted_at,
      title:            'Inventory count submitted',
      detail:           row.notes,
      actorName:        one(row.crew_members)?.name ?? null,
      photoStoragePath: null,
    })),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))

  const totalCount =
    checklistCount + woUpdatesCount + woPhotosCount + assignmentsCount + inspectionsCount + countsCount

  return {
    events,
    totalCount,
    omittedCount: Math.max(0, totalCount - events.length),
  }
}
