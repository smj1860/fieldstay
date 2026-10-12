import { inngest }               from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { unwrapList }            from '@/lib/supabase/unwrap'
import { sendEventsChunked }     from '@/lib/inngest/chunk'
import { unwrapJoin }            from '@/lib/utils/supabase-joins'
import { frictionDateString, frictionDayUtcBounds } from '@/lib/friction/date'
import { planDay, estimateMinutes, type PlannableTurnover } from '@/lib/planning/day-plan'

/**
 * SCHEDULED: 07:30 UTC, half an hour after cron-pre-flight-friction.
 *
 * The ordering is a real dependency, not tidiness. The friction cron's FIRST
 * step recomputes crew_speed_baselines, which is where this planner's duration
 * estimates come from. Running first would plan today against yesterday's
 * speeds; thirty minutes is comfortably more than that cron's own runtime and
 * still lands long before anyone looks at a board.
 *
 * It reuses lib/friction/date.ts for the day window rather than deriving one.
 * That module's name is historical — the functions are operating-day helpers,
 * and they are DST-aware, which a hand-rolled `toISOString().split('T')[0]`
 * is not. From about 7pm CT a UTC date is already tomorrow, so a planner with
 * its own date maths would plan the wrong day for exactly the hours a PM is
 * most likely to be looking.
 *
 * ── It does NOT publish ──
 * This writes planned_start_at/planned_end_at and never touches
 * plan_published_at. Crew see nothing until a PM publishes the day. See the
 * migration header for why; the short version is that a start time nobody
 * reviewed is an obligation nobody agreed to.
 */
const CRON_SCHEDULE = '30 7 * * *'

/** Same fan-out shape as daily-wrapup.ts and ical-sync.ts, per CLAUDE.md. */
export const dayPlanner = inngest.createFunction(
  { id: 'cron-day-planner', name: 'Cron: Plan Crew Days', retries: 2 },
  { cron: CRON_SCHEDULE },
  async ({ step, logger }) => {
    // Memoized so a retry plans the SAME day. This fires at 07:30 UTC, which
    // is mid-evening in Central the day before — re-reading the clock on a
    // retry that crossed midnight would plan a different date.
    const planDate = await step.run('capture-day', async () => frictionDateString())

    const orgIds = await step.run('find-orgs-with-work', async () => {
      const supabase = createServiceClient({ system: 'inngest:day-planner' })
      const { startUtc, endUtc } = frictionDayUtcBounds(planDate)

      // Orgs with an assigned turnover on the day. An org with nothing to
      // plan is skipped rather than dispatched to do nothing, since the
      // per-org handler costs several queries before it can find that out.
      //
      // Paginated: a platform-wide scan, so max_rows would silently truncate
      // it and quietly stop planning for every tenant past row 1000.
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('turnover_assignments')
          .select('org_id, turnovers!inner(checkout_datetime)')
          .gte('turnovers.checkout_datetime', startUtc)
          .lt('turnovers.checkout_datetime', endUtc)
          .not('org_id', 'is', null)
          .order('org_id')
          .range(from, to),
        { label: 'day-planner.orgs' },
      )
    })

    // Chunked, not one array: Inngest's event API has its own payload-size
    // and per-request count limits, and a single oversized sendEvent fails
    // the WHOLE dispatch for every tenant rather than the ones past some
    // line. Each chunk is its own step, so a resumed run re-sends only the
    // batches that did not land.
    await sendEventsChunked(
      step,
      'fan-out-day-plans',
      orgIds.map((orgId) => ({
        name: 'org/day_plan.requested' as const,
        data: { org_id: orgId, plan_date: planDate },
      })),
    )

    logger.info(`Day planner: dispatched ${orgIds.length} org(s) for ${planDate}`)
    return { dispatched: orgIds.length, plan_date: planDate }
  },
)

interface AssignmentRow {
  id:             string
  crew_member_id: string
  turnover_id:    string
  turnovers: {
    checkout_datetime: string
    checkin_datetime:  string | null
    status:            string
    properties: { lat: number | null; lng: number | null; bedrooms: number | null }
      | { lat: number | null; lng: number | null; bedrooms: number | null }[]
      | null
  } | null
}

/** Minutes-per-bedroom per crew member, plus the org median for the rest. */
interface Baselines {
  byCrew: Map<string, number>
  median: number | null
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

interface CrewEntry { assignmentId: string; job: PlannableTurnover }

/**
 * One crew member's jobs, keyed by crew member.
 *
 * A turnover shared by two people belongs to BOTH of their days, which is why
 * this groups assignments rather than turnovers: each assignee gets their own
 * sequence, planned around their own other work.
 */
function groupJobsByCrew(
  assignments: readonly AssignmentRow[],
  baselines:   Baselines,
): Map<string, CrewEntry[]> {
  const byCrew = new Map<string, CrewEntry[]>()

  for (const a of assignments) {
    const turnover = unwrapJoin(a.turnovers)
    if (!turnover) continue
    const property = unwrapJoin(turnover.properties)

    const entry: CrewEntry = {
      assignmentId: a.id,
      job: {
        turnover_id:       a.turnover_id,
        checkout_datetime: turnover.checkout_datetime,
        checkin_datetime:  turnover.checkin_datetime,
        lat:               property?.lat ?? null,
        lng:               property?.lng ?? null,
        duration_minutes:  estimateMinutes({
          bedrooms:              property?.bedrooms ?? null,
          crewMinutesPerBedroom: baselines.byCrew.get(a.crew_member_id) ?? null,
          orgMedianPerBedroom:   baselines.median,
        }),
      },
    }

    const list = byCrew.get(a.crew_member_id)
    if (list) list.push(entry)
    else byCrew.set(a.crew_member_id, [entry])
  }

  return byCrew
}

interface PlanWrite { id: string; planned_start_at: string; planned_end_at: string }

/** Runs the pure planner over every crew member's day and flattens the result. */
function planAllCrewDays(
  byCrew: Map<string, CrewEntry[]>,
): { writes: PlanWrite[]; infeasibleCount: number } {
  const writes: PlanWrite[] = []
  let infeasibleCount = 0

  for (const entries of byCrew.values()) {
    const { slots } = planDay(entries.map((e) => e.job))
    const slotByTurnover = new Map(slots.map((s) => [s.turnover_id, s]))

    for (const entry of entries) {
      const slot = slotByTurnover.get(entry.job.turnover_id)
      if (!slot) continue
      if (slot.infeasible) infeasibleCount += 1
      writes.push({
        id:               entry.assignmentId,
        planned_start_at: slot.planned_start_at,
        planned_end_at:   slot.planned_end_at,
      })
    }
  }

  return { writes, infeasibleCount }
}

export const planDayForOrg = inngest.createFunction
  (
    {
      id: 'org-day-plan', name: 'Plan One Org\'s Crew Days', retries: 2,
      // One run per org per day. A duplicate dispatch, or a retry racing the
      // original, would otherwise have two runs writing the same rows — and
      // while the write itself is idempotent (same inputs, same plan), the
      // read-then-write pair is not worth running twice per org.
      concurrency: [{ limit: 1, key: 'event.data.org_id' }],
    },
    { event: 'org/day_plan.requested' },
    async ({ event, step, logger }) => {
      const { org_id: orgId, plan_date: planDate } = event.data

      const assignments = await step.run('load-assignments', async () => {
        const supabase = createServiceClient({ system: 'inngest:day-planner' })
        const { startUtc, endUtc } = frictionDayUtcBounds(planDate)

        // Only turnovers still ahead of the work. A completed or cancelled
        // one is a historical record and planning it would both be useless
        // and overwrite the times its crew actually worked to.
        return fetchAllRows<AssignmentRow>(
          (from, to) => supabase
            .from('turnover_assignments')
            .select(`
              id, crew_member_id, turnover_id,
              turnovers!inner (
                checkout_datetime, checkin_datetime, status,
                properties!inner ( lat, lng, bedrooms )
              )
            `)
            .eq('org_id', orgId)
            .gte('turnovers.checkout_datetime', startUtc)
            .lt('turnovers.checkout_datetime', endUtc)
            .in('turnovers.status', ['pending_assignment', 'assigned', 'in_progress'])
            .order('id')
            .range(from, to),
          { label: `day-planner.assignments[org=${orgId}]` },
        )
      })

      if (!assignments.length) {
        logger.info(`Day planner: nothing to plan for ${orgId} on ${planDate}`)
        return { planned: 0, crew: 0 }
      }

      const baselines = await step.run('load-baselines', async () => {
        const supabase = createServiceClient({ system: 'inngest:day-planner' })

        // Bounded by the org's crew count, which is plan-capped. Crew under
        // three completed turnovers in the 90-day window have no row at all,
        // which is exactly what the median below is for.
        const res = await supabase
          .from('crew_speed_baselines')
          .select('crew_member_id, avg_minutes_per_bedroom')
          .eq('org_id', orgId)
          .limit(500)

        const rows = unwrapList(res, { site: 'inngest.day-planner.baselines', orgId })
        const perBedroom = rows
          .map((r) => (r.avg_minutes_per_bedroom === null ? null : Number(r.avg_minutes_per_bedroom)))
          .filter((n): n is number => n !== null && Number.isFinite(n) && n > 0)

        return {
          byCrew: rows
            .filter((r) => r.avg_minutes_per_bedroom !== null)
            .map((r) => [r.crew_member_id, Number(r.avg_minutes_per_bedroom)] as const),
          median: medianOf(perBedroom),
        }
      })

      const resolved: Baselines = {
        byCrew: new Map(baselines.byCrew),
        median: baselines.median,
      }

      const byCrew = groupJobsByCrew(assignments, resolved)

      // Planned OUTSIDE step.run and written inside it: the computation is
      // pure and cheap, so a retry of the write recomputes the identical
      // plan from the same loaded rows rather than re-reading anything.
      const { writes, infeasibleCount } = planAllCrewDays(byCrew)

      await step.run('write-plan', async () => {
        const supabase = createServiceClient({ system: 'inngest:day-planner' })

        // ONE statement for the whole org's day, via
        // set_turnover_assignment_plans (UPDATE ... FROM jsonb_to_recordset).
        // A loop of per-assignment updates here is an N+1 with no structural
        // excuse — two timestamps keyed by primary key are maximally
        // batchable — and it is what unit/guardrails/n-plus-one-loops flags.
        //
        // The RPC is an UPDATE rather than an upsert on purpose: an upsert
        // would resurrect an assignment deleted between the read above and
        // this write, silently handing a job back to a crew member who was
        // unassigned mid-run. Matching nothing is the right outcome there,
        // which is also why a returned count below the write count is
        // logged rather than thrown on.
        const { data, error } = await supabase.rpc('set_turnover_assignment_plans', {
          p_org_id: orgId,
          p_plans:  writes,
        })
        if (error) throw new Error(`day plan write failed for org ${orgId}: ${error.message}`)
        return typeof data === 'number' ? data : writes.length
      })

      logger.info(
        `Day planner: ${orgId} on ${planDate} — ${writes.length} assignment(s) across `
        + `${byCrew.size} crew member(s), ${infeasibleCount} that cannot make check-in`,
      )
      return { planned: writes.length, crew: byCrew.size, infeasible: infeasibleCount }
    },
  )
