import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { unwrapList } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { estimateMinutes } from '@/lib/planning/day-plan'
import type { Baselines } from '@/lib/planning/baselines'
import type { CascadeJob } from '@/lib/scoring/cascade'

/**
 * ONE org's ONE operating day: every crew member's unfinished turnovers with
 * live checklist progress, in three reads, for lib/scoring/cascade.ts to rank.
 *
 * ── Why checklist items and not assignment_outcomes ──
 * assignment_outcomes.started_at/completed_at are written AFTER a turnover
 * fully finishes, which is useless for same-day awareness: by definition the
 * thing you would want to react to has not finished yet.
 * checklist_instance_items.completed_at updates live, item by item, as a
 * cleaner works. "Has this even started", "how far along", and "is it already
 * behind its own window" are all answerable right now from data already
 * flowing, with no new instrumentation and no new write path.
 *
 * ── It decides nothing ──
 * No suggestion, no score, no severity, no recommended action, no
 * reassignment. Deciding how to react to a cascade risk (alert the PM? the
 * guest? wait?) is judgment-shaped work, and nothing in here is another fixed
 * formula bolted onto lib/scoring/friction.ts. Do not scope-creep it into one.
 *
 * ── The ceilings below ──
 * Both reads are bounded by one org's one day, so neither is reachable in
 * practice — but PostgREST truncates at max_rows with a 200 and no signal, and
 * a silently short read here would under-report a cascade risk, which is the
 * one thing this module exists to surface. A date window caps the days, not
 * the rows.
 *
 * MAX_CHECKLIST_ITEMS is above max_rows (1000) on purpose — one org's several
 * same-day turnovers genuinely carry that many items across their checklists —
 * which is exactly why the read it bounds goes through fetchAllRows()'s
 * .range() pagination rather than a bare .limit(): a .limit() above max_rows
 * is not a higher ceiling, it is the same 1000-row truncation with a bigger,
 * misleading number written next to it.
 */
const MAX_CHECKLIST_ITEMS = 4000

interface ChecklistProgress {
  total:       number
  completed:   number
  hasStarted:  boolean
}

/** instance_id -> progress, folded from one flat item read. */
function foldProgress(
  items: { instance_id: string; is_completed: boolean | null; completed_at: string | null }[],
): Map<string, ChecklistProgress> {
  const byInstance = new Map<string, ChecklistProgress>()

  for (const item of items) {
    const current = byInstance.get(item.instance_id) ?? { total: 0, completed: 0, hasStarted: false }
    current.total += 1
    if (item.is_completed) current.completed += 1
    if (item.completed_at !== null) current.hasStarted = true
    byInstance.set(item.instance_id, current)
  }

  return byInstance
}

interface ChecklistItemRow {
  instance_id:  string
  is_completed: boolean | null
  completed_at: string | null
}

/**
 * ONE read for every item across every instance, paginated via .range()
 * rather than a bare .limit() — see MAX_CHECKLIST_ITEMS's comment above.
 */
async function loadChecklistItems(
  supabase: ReturnType<typeof createServiceClient>,
  instances: { id: string }[],
): Promise<ChecklistItemRow[]> {
  return fetchAllRows<ChecklistItemRow>(
    (from, to) => supabase
      .from('checklist_instance_items')
      .select('instance_id, is_completed, completed_at')
      .in('instance_id', instances.map((i) => i.id))
      .order('id', { ascending: true })
      .range(from, to),
    { label: 'scoring.crew-day-context.checklistItems', maxRows: MAX_CHECKLIST_ITEMS },
  )
}

const MAX_ORG_DAY_ASSIGNMENTS = 4000

export interface OrgDayCrewJobs {
  crewMemberId:   string
  crewMemberName: string
  jobs:           CascadeJob[]
}

interface OrgDayAssignmentRow {
  crew_member_id:   string
  turnover_id:      string
  planned_start_at: string | null
  plan_published_at: string | null
  crew_members: { name: string | null } | { name: string | null }[] | null
  turnovers: {
    checkout_datetime: string
    checkin_datetime:  string | null
    properties:
      | { name: string | null; lat: number | null; lng: number | null; bedrooms: number | null }
      | { name: string | null; lat: number | null; lng: number | null; bedrooms: number | null }[]
      | null
  } | null
}

/**
 * Every crew member's unfinished turnovers for one operating day, with live
 * checklist progress, ready for lib/scoring/cascade.ts to rank.
 *
 * READ-ONLY, and it still decides nothing: no severity, no threshold, no
 * suggestion. Same constraint getCrewDayContext() carries.
 */
export async function loadOrgDayCrewJobs(
  orgId:    string,
  startUtc: string,
  endUtc:   string,
  baselines: Baselines,
): Promise<OrgDayCrewJobs[]> {
  const supabase = createServiceClient({ system: 'inngest:cascade-alert' })

  // Only turnovers still in flight. A completed or cancelled one cannot
  // cascade into anything, and a cancelled one still holding a crew slot
  // would invent a downstream job nobody is driving to.
  const assignments = await fetchAllRows<OrgDayAssignmentRow>(
    (from, to) => supabase
      .from('turnover_assignments')
      .select(`
        crew_member_id, turnover_id, planned_start_at, plan_published_at,
        crew_members ( name ),
        turnovers!inner (
          checkout_datetime, checkin_datetime, status,
          properties ( name, lat, lng, bedrooms )
        )
      `)
      .eq('org_id', orgId)
      .gte('turnovers.checkout_datetime', startUtc)
      .lt('turnovers.checkout_datetime', endUtc)
      .in('turnovers.status', ['assigned', 'in_progress'])
      .order('turnover_id')
      .range(from, to),
    { label: `cascade.orgDayAssignments[org=${orgId}]`, maxRows: MAX_ORG_DAY_ASSIGNMENTS },
  )

  if (assignments.length === 0) return []

  const turnoverIds = [...new Set(assignments.map((a) => a.turnover_id))]

  // ONE read for every checklist instance across the whole org-day.
  const instancesRes = await supabase
    .from('checklist_instances')
    .select('id, turnover_id')
    .in('turnover_id', turnoverIds)
    .eq('org_id', orgId)
    .limit(turnoverIds.length)

  const instances = unwrapList<{ id: string; turnover_id: string }>(instancesRes, {
    site: 'scoring.crew-day-context.orgDayInstances', orgId,
  })

  const instanceByTurnover = new Map(instances.map((i) => [i.turnover_id, i.id]))
  const progressByInstance = instances.length === 0
    ? new Map<string, ChecklistProgress>()
    : foldProgress(await loadChecklistItems(supabase, instances))

  const byCrew = new Map<string, OrgDayCrewJobs>()

  for (const row of assignments) {
    const job = cascadeJobFor(row, { instanceByTurnover, progressByInstance, baselines })
    if (!job) continue

    const existing = byCrew.get(row.crew_member_id)
    if (existing) existing.jobs.push(job)
    else byCrew.set(row.crew_member_id, {
      crewMemberId:   row.crew_member_id,
      crewMemberName: unwrapJoin(row.crew_members)?.name ?? 'Unknown',
      jobs:           [job],
    })
  }

  return [...byCrew.values()]
}

interface JobContext {
  instanceByTurnover: Map<string, string>
  progressByInstance: Map<string, ChecklistProgress>
  baselines:          Baselines
}

/** One assignment row as a rankable job. null when its turnover embed is absent. */
function cascadeJobFor(row: OrgDayAssignmentRow, ctx: JobContext): CascadeJob | null {
  const turnover = unwrapJoin(row.turnovers)
  if (!turnover) return null

  const property   = unwrapJoin(turnover.properties)
  const instanceId = ctx.instanceByTurnover.get(row.turnover_id)
  const progress   = instanceId ? ctx.progressByInstance.get(instanceId) : undefined

  // null, not 0: no checklist instance means no progress SIGNAL, which is a
  // different claim from "nothing done". cascade.ts reads it pessimistically
  // and says so, rather than this read guessing on its behalf.
  const completionRatio = progress && progress.total > 0
    ? progress.completed / progress.total
    : null

  // The published plan wins where there is one. An unpublished planned time
  // is a draft nobody agreed to, so falling back to checkout matches what the
  // crew member is actually looking at on their card.
  const startAt = row.plan_published_at !== null && row.planned_start_at !== null
    ? row.planned_start_at
    : turnover.checkout_datetime

  return {
    turnoverId:      row.turnover_id,
    propertyName:    property?.name ?? null,
    startAt,
    checkinAt:       turnover.checkin_datetime,
    lat:             property?.lat ?? null,
    lng:             property?.lng ?? null,
    durationMinutes: estimateMinutes({
      bedrooms:              property?.bedrooms ?? null,
      crewMinutesPerBedroom: ctx.baselines.byCrew.get(row.crew_member_id) ?? null,
      orgMedianPerBedroom:   ctx.baselines.median,
    }),
    completionRatio,
  }
}
