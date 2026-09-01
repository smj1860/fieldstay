import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { unwrapList, unwrapCount, type PostgrestResult, type CountResult } from '@/lib/supabase/unwrap'

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
 * One source's shape: which table, which columns for the real read vs. the
 * `count: 'exact'` head read, which column the date window applies to, and
 * the equality/not-null filters that scope it to the property. Declaring the
 * six sources as DATA against one query-building function (below), instead
 * of six near-identical inline chains, is what keeps this file out of
 * SonarCloud's duplication gate — six copies of the same
 * eq/gte/lte/order/limit shape read as a structural clone even though the
 * table and column names differ.
 */
interface HistorySourceSpec {
  table:       string
  dataSelect:  string
  countSelect: string
  dateColumn:  string
  eq:          [string, string | boolean][]
  /** e.g. inspections' `completed_at` — only counts once it has a value. */
  notNull?:    string
}

/**
 * The minimal surface `buildSourceQueries` needs off a Supabase query
 * builder. Declared and cast to explicitly (rather than inferred generically
 * off the real `PostgrestFilterBuilder`) so TypeScript never has to
 * structurally unify this file's filters against supabase-js's actual,
 * heavily-overloaded builder type — attempting that generically is what
 * produced a "Type instantiation is excessively deep" error here. The cast
 * is the same "trust the manually-maintained interface over the client's
 * inference" convention CLAUDE.md documents for this client (no `Database`
 * generic is threaded through it yet — see lib/supabase/server.ts).
 */
interface ScopedQuery {
  eq(column: string, value: string | boolean): ScopedQuery
  not(column: string, operator: string, value: unknown): ScopedQuery
  gte(column: string, value: string): ScopedQuery
  lte(column: string, value: string): ScopedQuery
  order(column: string, options: { ascending: boolean }): ScopedQuery
  limit(count: number): ScopedQuery
}

/** Applies `spec`'s eq/not-null filters. */
function scopeToProperty(builder: ScopedQuery, spec: HistorySourceSpec): ScopedQuery {
  let query = builder
  for (const [column, value] of spec.eq) query = query.eq(column, value)
  if (spec.notNull) query = query.not(spec.notNull, 'is', null)
  return query
}

/**
 * The capped, ordered data read and its `count: 'exact'` companion for one
 * source, typed against the caller's own row interface.
 *
 * `spec.dataSelect`/`countSelect` are plain `string`s (built from a data
 * array, not literal template strings), which is exactly the shape
 * supabase-js's select-string type inference cannot parse — it falls back to
 * an intentionally-incompatible sentinel type rather than a real row shape,
 * so the result is cast through `ScopedQuery` and back out to the caller's
 * real row type rather than fought.
 */
function buildSourceQueries<Row>(supabase: SupabaseClient, spec: HistorySourceSpec, from: string, to: string, cap: number): {
  data:  PromiseLike<PostgrestResult<Row[]>>
  count: PromiseLike<CountResult>
} {
  // Each of `data`/`count` is written as ONE expression, .select() through
  // .limit()/.gte(), rather than split across a builder variable and a later
  // statement — semgrep's -table-scan chokepoint rule (CLAUDE.md's
  // unbounded-.select() gate) only recognizes a .select() as bounded when
  // the bounding call (.limit()/.eq()/.gte()) is inside the SAME expression
  // tree; splitting it across statements made the rule blind to a read this
  // file's own header comment already says is capped.
  const data = scopeToProperty(
    supabase.from(spec.table).select(spec.dataSelect) as unknown as ScopedQuery,
    spec,
  ).gte(spec.dateColumn, from).lte(spec.dateColumn, to)
    .order(spec.dateColumn, { ascending: true })
    .limit(cap) as unknown as PromiseLike<PostgrestResult<Row[]>>

  const count = scopeToProperty(
    supabase.from(spec.table).select(spec.countSelect, { count: 'exact', head: true }) as unknown as ScopedQuery,
    spec,
  ).gte(spec.dateColumn, from).lte(spec.dateColumn, to) as unknown as PromiseLike<CountResult>

  return { data, count }
}

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

/** A PostgREST to-one embed returns either an object or a one-element array, depending on the relationship's inferred cardinality. */
function one<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

function historySources(propertyId: string): {
  checklist: HistorySourceSpec
  woUpdates: HistorySourceSpec
  woPhotos: HistorySourceSpec
  assignments: HistorySourceSpec
  inspections: HistorySourceSpec
  counts: HistorySourceSpec
} {
  return {
    checklist: {
      table:       'checklist_instance_items',
      dataSelect:  'id, task, section_name, completed_at, crew_notes, photo_storage_path, crew_members(name), turnovers!inner(property_id)',
      countSelect: 'id, turnovers!inner(property_id)',
      dateColumn:  'completed_at',
      eq:          [['turnovers.property_id', propertyId], ['is_completed', true]],
    },
    woUpdates: {
      table:       'work_order_updates',
      dataSelect:  'id, status_from, status_to, notes, updated_by_user_id, updated_via_vendor_portal, created_at, work_orders!inner(property_id, title, wo_number)',
      countSelect: 'id, work_orders!inner(property_id)',
      dateColumn:  'created_at',
      eq:          [['work_orders.property_id', propertyId]],
    },
    woPhotos: {
      table:       'work_order_photos',
      dataSelect:  'id, storage_path, uploaded_by, created_at, work_orders!inner(property_id, title, wo_number)',
      countSelect: 'id, work_orders!inner(property_id)',
      dateColumn:  'created_at',
      eq:          [['work_orders.property_id', propertyId]],
    },
    assignments: {
      table:       'turnover_assignments',
      dataSelect:  'id, assigned_at, crew_members(name), turnovers(checkout_datetime, checkin_datetime)',
      countSelect: 'id',
      dateColumn:  'assigned_at',
      eq:          [['property_id', propertyId]],
    },
    inspections: {
      table:       'inspections',
      dataSelect:  'id, inspector_name, completed_at',
      countSelect: 'id',
      dateColumn:  'completed_at',
      eq:          [['property_id', propertyId]],
      notNull:     'completed_at',
    },
    counts: {
      table:       'inventory_counts',
      dataSelect:  'id, submitted_at, notes, crew_members(name)',
      countSelect: 'id',
      dateColumn:  'submitted_at',
      eq:          [['property_id', propertyId]],
    },
  }
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

  const sources = historySources(propertyId)
  const checklist   = buildSourceQueries<ChecklistRow>(supabase, sources.checklist, from, to, CAP)
  const woUpdates   = buildSourceQueries<WoUpdateRow>(supabase, sources.woUpdates, from, to, CAP)
  const woPhotos    = buildSourceQueries<WoPhotoRow>(supabase, sources.woPhotos, from, to, CAP)
  const assignments = buildSourceQueries<AssignmentRow>(supabase, sources.assignments, from, to, CAP)
  const inspections = buildSourceQueries<InspectionRow>(supabase, sources.inspections, from, to, CAP)
  const counts      = buildSourceQueries<CountRow>(supabase, sources.counts, from, to, CAP)

  const [
    checklistRes, checklistCountRes,
    woUpdatesRes, woUpdatesCountRes,
    woPhotosRes, woPhotosCountRes,
    assignmentsRes, assignmentsCountRes,
    inspectionsRes, inspectionsCountRes,
    countsRes, countsCountRes,
  ] = await Promise.all([
    checklist.data, checklist.count,
    woUpdates.data, woUpdates.count,
    woPhotos.data, woPhotos.count,
    assignments.data, assignments.count,
    inspections.data, inspections.count,
    counts.data, counts.count,
  ])

  const site = 'lib.history.loadPropertyHistory'
  const orgId = params.orgId

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
