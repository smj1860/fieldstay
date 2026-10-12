import { inngest }               from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { fetchDistinctOrgIds }   from '@/lib/inngest/paginate'
import { sendEventsChunked }     from '@/lib/inngest/chunk'
import { createPmNotifications } from '@/lib/inngest/helpers'
import { frictionDateString, frictionDayUtcBounds } from '@/lib/friction/date'
import { loadCrewBaselines, resolveBaselines }      from '@/lib/planning/baselines'
import { loadOrgDayCrewJobs }    from '@/lib/scoring/crew-day-context'
import { rankCascadeRisk, type CascadeRisk } from '@/lib/scoring/cascade'

/**
 * SCHEDULED: every 30 minutes.
 *
 * The one signal a PM cannot get from a board: a turnover that is already
 * past its own check-in with work left to do, where the SAME crew member has
 * another job later the same day. The late job is visible on /ops; what is
 * not visible is that it is about to make the next one late too.
 *
 * ── It ranks. It does not decide. ──
 * No severity ladder, no auto-reassignment, no threshold that moves anybody.
 * It notifies, in order of projected overrun, and the dispatcher decides
 * whether to reassign, warn the guest, or let it ride. That is the constraint
 * lib/scoring/crew-day-context.ts was written with and lib/scoring/cascade.ts
 * keeps, and it is why every row goes out at one severity: picking amber for
 * one and red for another would be the judgment this is not making.
 *
 * ── Every 30 minutes, one notification per turnover per day ──
 * `dedupe_key` is `cascade:<turnover_id>:<date>`, so the first run that sees
 * a job slip notifies and the next 20 runs that day do not. The PM gets told
 * once, early, which is the whole value; a job that is 30 minutes late at
 * noon and 4 hours late at 4pm does not need nine reminders in between.
 * The partial-unique index on notifications.dedupe_key is what enforces it,
 * not a flag this cron keeps.
 *
 * Day boundaries come from lib/friction/date.ts (DST-aware operating-day
 * helpers; the name is historical). This runs around the clock, so a
 * hand-rolled `toISOString().slice(0, 10)` would roll the day over at 7pm CT
 * and start checking tomorrow's turnovers while today's are still running.
 */
const CRON_SCHEDULE = '*/30 * * * *'

export const cascadeAlert = inngest.createFunction(
  { id: 'cron-cascade-alert', name: 'Cron: Cascade Delay Alert', retries: 2 },
  { cron: CRON_SCHEDULE },
  async ({ step, logger }) => {
    // Memoized so a retry checks the SAME day, rather than crossing the
    // operating-day boundary mid-run and checking a different one.
    const checkDate = await step.run('capture-day', () => frictionDateString())

    const orgIds = await step.run('find-orgs-with-work', async () => {
      const supabase = createServiceClient({ system: 'inngest:cascade-alert' })
      const { startUtc, endUtc } = frictionDayUtcBounds(checkDate)

      // Orgs with an in-flight assigned turnover today. An org with nothing
      // running is skipped rather than dispatched to find that out across
      // three queries, 48 times a day.
      //
      // Paginated: a platform-wide scan, so max_rows would silently stop
      // this covering every tenant past row 1000.
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('turnover_assignments')
          .select('org_id, turnovers!inner(checkout_datetime, status)')
          .gte('turnovers.checkout_datetime', startUtc)
          .lt('turnovers.checkout_datetime', endUtc)
          .in('turnovers.status', ['assigned', 'in_progress'])
          .not('org_id', 'is', null)
          .order('org_id')
          .range(from, to),
        { label: 'cascade-alert.orgs' },
      )
    })

    await sendEventsChunked(
      step,
      'fan-out-cascade-checks',
      orgIds.map((orgId) => ({
        name: 'org/cascade_check.requested' as const,
        data: { org_id: orgId, check_date: checkDate },
      })),
    )

    logger.info(`Cascade alert: dispatched ${orgIds.length} org(s) for ${checkDate}`)
    return { dispatched: orgIds.length, check_date: checkDate }
  },
)

/**
 * The PM-facing sentence.
 *
 * The projected overrun IS the rank — a number in minutes, with the
 * downstream property named — so the ordering needs no "#2 of 3" badge that
 * means nothing once the notification is a week old in the bell.
 *
 * No em dash: customer-facing copy, per CLAUDE.md.
 */
function subtitleFor(risk: CascadeRisk, crewMemberName: string): string {
  const late = `${crewMemberName} is ${risk.minutesLate} min past check-in`
  const next = risk.nextPropertyName ?? 'their next turnover'
  const overrun = risk.overrunMinutes > 0
    ? `, projected ${risk.overrunMinutes} min into ${next}`
    : `, with ${next} still to come`

  // Said plainly rather than silently folded into the number: the drive leg
  // contributes zero when either property has no coordinates, so the real
  // overrun is at least this, never less.
  return `${late}${overrun}.${risk.travelUnknown ? ' Drive time unknown.' : ''}`
}

export const checkCascadeForOrg = inngest.createFunction(
  {
    id: 'org-cascade-check', name: 'Check One Org for Cascading Delays', retries: 2,
    // One run per org at a time. Two overlapping runs would both read the
    // same in-flight turnovers and race on the same dedupe keys; the insert
    // is idempotent, but the three reads are not worth doing twice.
    concurrency: [{ limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'org/cascade_check.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, check_date: checkDate } = event.data

    const crewDays = await step.run('load-org-day', async () => {
      const supabase = createServiceClient({ system: 'inngest:cascade-alert' })
      const { startUtc, endUtc } = frictionDayUtcBounds(checkDate)
      const baselines = resolveBaselines(await loadCrewBaselines(supabase, orgId))
      return loadOrgDayCrewJobs(orgId, startUtc, endUtc, baselines)
    })

    // Ranked OUTSIDE step.run: pure over the rows just loaded, so a retry of
    // the write below recomputes the identical ranking rather than re-reading.
    //
    // `now` is read once for the whole org so every risk in one run is
    // measured against the same instant. Per-crew clocks would make two jobs
    // checked a second apart incomparable for no gain.
    const now = Date.now()
    const ranked = crewDays
      .flatMap((day) => rankCascadeRisk(day.jobs, now)
        .filter((risk) => risk.hasDownstream)
        .map((risk) => ({ risk, crewMemberName: day.crewMemberName })))
      .sort((a, b) =>
        b.risk.overrunMinutes - a.risk.overrunMinutes
        || b.risk.minutesLate - a.risk.minutesLate)

    if (ranked.length === 0) {
      return { notified: 0, check_date: checkDate }
    }

    await step.run('notify', async () => {
      const supabase = createServiceClient({ system: 'inngest:cascade-alert' })

      // ONE insert for the whole org, in rank order. createPmNotifications
      // arbitrates per row via onConflict/ignoreDuplicates, so a turnover
      // already notified today drops out without taking the rest of the
      // batch with it — which a single colliding row in a plain insert would.
      await createPmNotifications(supabase, ranked.map(({ risk, crewMemberName }) => ({
        orgId,
        type:      'turnover.cascade_risk',
        title:     `${risk.propertyName ?? 'A turnover'} is running late`,
        subtitle:  subtitleFor(risk, crewMemberName),
        href:      `/turnovers/${risk.turnoverId}`,
        severity:  'amber' as const,
        dedupeKey: `cascade:${risk.turnoverId}:${checkDate}`,
      })))
    })

    logger.info(
      `Cascade alert: ${orgId} on ${checkDate} — ${ranked.length} late turnover(s) `
      + `with later work, worst projected ${ranked[0]!.risk.overrunMinutes} min over`,
    )
    return { notified: ranked.length, check_date: checkDate }
  },
)
