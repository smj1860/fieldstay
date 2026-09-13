import 'server-only'

import { createServiceClient } from '@/lib/supabase/server'
import { unwrapList } from '@/lib/supabase/unwrap'

/**
 * Ceilings on the three reads below.
 *
 * All three are bounded by one crew's one day, so none is reachable in
 * practice — but PostgREST truncates at max_rows with a 200 and no signal, and
 * a silently short read here would under-report a cascade risk, which is the
 * one thing this function exists to surface.
 */
const MAX_EARLIER_ASSIGNMENTS = 200
const MAX_CHECKLIST_ITEMS     = 4000

export interface EarlierTurnoverStatus {
  turnoverId:        string
  propertyId:        string
  checkoutDatetime:  string
  checkinDatetime:   string
  hasStarted:        boolean
  /** completed items / total items in this turnover's checklist instance. null = no checklist instance yet. */
  completionRatio:   number | null
  /** Past its own checkin_datetime with an incomplete checklist. */
  isRunningLate:     boolean
}

export interface CrewDayContext {
  crewMemberId:           string
  crewMemberName:         string
  earlierTurnoversToday:  EarlierTurnoverStatus[]
}

/**
 * A PostgREST embed is an array for a to-many relation and an object for a
 * to-one, and the same select has returned both shapes across versions. Same
 * normalizer as pre-flight-friction.ts, for the same reason.
 */
function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

interface EarlierAssignmentRow {
  crew_member_id: string
  turnovers: {
    id: string
    property_id: string
    checkout_datetime: string
    checkin_datetime: string
  } | { id: string; property_id: string; checkout_datetime: string; checkin_datetime: string }[] | null
}

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

/**
 * STUB — READ-ONLY. Surfaces same-day cascading-delay context for a flagged
 * turnover's assigned crew: their OTHER turnovers scheduled earlier the same
 * calendar day, and each one's real-time progress.
 *
 * It decides nothing. No suggestion, no score, no severity, no recommended
 * action, no reassignment — deciding how to react to a cascade risk (alert the
 * PM? the guest? wait?) is judgment-shaped work, better suited to a dispatcher
 * or an agent reasoning over live context than to another fixed formula bolted
 * onto lib/scoring/friction.ts. Do not scope-creep this into that decision.
 *
 * WHY THIS READ IS DIFFERENT from every other outcome signal in the project:
 * assignment_outcomes.started_at/completed_at are written AFTER a turnover
 * fully finishes, which is useless for same-day awareness — by definition the
 * thing you would want to react to has not finished yet.
 * checklist_instance_items.completed_at updates live, item by item, as a
 * cleaner works. "Has this even started", "how far along", and "is it already
 * behind its own window" are all answerable right now from data already
 * flowing, with no new instrumentation and no new write path.
 *
 * Nothing calls this yet, deliberately. The seam is the signature and the
 * return shape, not an integration.
 */
export async function getCrewDayContext(
  turnoverId: string,
  orgId:      string,
): Promise<CrewDayContext[]> {
  const supabase = createServiceClient({ system: 'friction-crew-day-context' })

  const targetRes = await supabase
    .from('turnovers')
    .select('checkout_datetime, turnover_assignments(crew_member_id, crew_members(id, name))')
    .eq('id', turnoverId)
    .eq('org_id', orgId)
    .maybeSingle()

  if (targetRes.error) throw targetRes.error
  const target = targetRes.data
  if (!target) return []

  const targetCheckout = target.checkout_datetime as string
  const dayStart = `${targetCheckout.slice(0, 10)}T00:00:00Z`

  const crewAssignments = (target.turnover_assignments ?? []) as {
    crew_member_id: string
    crew_members: { id: string; name: string } | { id: string; name: string }[] | null
  }[]

  if (crewAssignments.length === 0) return []

  const crewIds = [...new Set(crewAssignments.map((a) => a.crew_member_id))]

  // ONE read for EVERY crew member's earlier turnovers, not one per person.
  // The per-crew loop the obvious shape invites is the N+1 that
  // unit/guardrails/n-plus-one-loops.test.ts exists to catch.
  const earlierRes = await supabase
    .from('turnover_assignments')
    .select('crew_member_id, turnovers!inner(id, property_id, checkout_datetime, checkin_datetime, status)')
    .in('crew_member_id', crewIds)
    .eq('org_id', orgId)
    .neq('turnover_id', turnoverId)
    .gte('turnovers.checkout_datetime', dayStart)
    .lt('turnovers.checkout_datetime', targetCheckout)
    .in('turnovers.status', ['assigned', 'in_progress'])
    .limit(MAX_EARLIER_ASSIGNMENTS)

  const earlier = unwrapList<EarlierAssignmentRow>(earlierRes, {
    site: 'scoring.crew-day-context.earlierAssignments', orgId,
  })

  if (earlier.length === 0) {
    return crewAssignments.map((a) => ({
      crewMemberId:          a.crew_member_id,
      crewMemberName:        firstOf(a.crew_members)?.name ?? 'Unknown',
      earlierTurnoversToday: [],
    }))
  }

  const earlierTurnoverIds = [
    ...new Set(earlier.map((row) => firstOf(row.turnovers)?.id).filter((id): id is string => Boolean(id))),
  ]

  // ONE read for every checklist instance across all of those turnovers.
  const instancesRes = await supabase
    .from('checklist_instances')
    .select('id, turnover_id')
    .in('turnover_id', earlierTurnoverIds)
    .eq('org_id', orgId)
    .limit(earlierTurnoverIds.length)

  const instances = unwrapList<{ id: string; turnover_id: string }>(instancesRes, {
    site: 'scoring.crew-day-context.checklistInstances', orgId,
  })

  const instanceByTurnover = new Map(instances.map((i) => [i.turnover_id, i.id]))

  // ONE read for every item across every instance, folded in memory.
  const progressByInstance = instances.length === 0
    ? new Map<string, ChecklistProgress>()
    : foldProgress(
        unwrapList<{ instance_id: string; is_completed: boolean | null; completed_at: string | null }>(
          await supabase
            .from('checklist_instance_items')
            .select('instance_id, is_completed, completed_at')
            .in('instance_id', instances.map((i) => i.id))
            .limit(MAX_CHECKLIST_ITEMS),
          { site: 'scoring.crew-day-context.checklistItems', orgId },
        ),
      )

  const now = Date.now()

  function statusFor(turnover: NonNullable<ReturnType<typeof firstOf<{
    id: string; property_id: string; checkout_datetime: string; checkin_datetime: string
  }>>>): EarlierTurnoverStatus {
    const instanceId = instanceByTurnover.get(turnover.id)
    const progress   = instanceId ? progressByInstance.get(instanceId) : undefined

    // null, not 0: no checklist instance (or an instance with no items) means
    // "no progress signal", which is a different claim from "nothing done".
    const completionRatio = progress && progress.total > 0
      ? progress.completed / progress.total
      : null

    return {
      turnoverId:       turnover.id,
      propertyId:       turnover.property_id,
      checkoutDatetime: turnover.checkout_datetime,
      checkinDatetime:  turnover.checkin_datetime,
      hasStarted:       progress?.hasStarted ?? false,
      completionRatio,
      isRunningLate:    now > new Date(turnover.checkin_datetime).getTime()
                        && (completionRatio === null || completionRatio < 1.0),
    }
  }

  const byCrew = new Map<string, EarlierTurnoverStatus[]>()
  for (const row of earlier) {
    const turnover = firstOf(row.turnovers)
    if (!turnover) continue
    const list = byCrew.get(row.crew_member_id)
    if (list) list.push(statusFor(turnover))
    else byCrew.set(row.crew_member_id, [statusFor(turnover)])
  }

  return crewAssignments.map((a) => ({
    crewMemberId:          a.crew_member_id,
    crewMemberName:        firstOf(a.crew_members)?.name ?? 'Unknown',
    earlierTurnoversToday: byCrew.get(a.crew_member_id) ?? [],
  }))
}
