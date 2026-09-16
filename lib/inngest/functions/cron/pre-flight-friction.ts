import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { chunkArray } from '@/lib/inngest/chunk'
import { unwrapList, type PostgrestNumeric } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { frictionDateString, localDateFrom, frictionDayUtcBounds } from '@/lib/friction/date'
import { resolveSeasonalProfile } from '@/lib/scoring/seasonal-market'
import type { SeasonalProfile } from '@/types/database'
import { reportError }          from '@/lib/observability/report-error'
import { getTomorrowForecastForLocation, type DayForecast } from '@/lib/weather/tomorrow'
import { topCrewCandidate, crewSuggestionReasoning, type CrewCandidate } from '@/lib/scoring/crew-candidates'
import {
  computeFrictionScore, severityFromScore,
  crewDurationScore, weatherScore, weekendScore, holidayScore,
  seasonalScore, springBreakScore, interactionScore,
  type FrictionComponents,
} from '@/lib/scoring/friction'

/**
 * SAME-DAY, not the night before.
 *
 * 2am CT scores today's turnovers against today's data — a late cancellation,
 * a crew callout or a schedule change made the evening before is already
 * reflected, where an 11pm run would have missed all three. It still leaves
 * five hours of runway before the 7am dashboard read.
 *
 * 07:00 UTC is ~2am CT under CDT, drifting an hour under CST. That is the
 * convention every other cron in this directory already accepts
 * (checklist-signals' 0 4 * * * -> 11pm CT, crew-score-recompute's 0 9 * * *
 * -> 3-4am CT), not a gap unique to this function. It sits between those two
 * and shares no table with either: neither reads or writes
 * crew_speed_baselines or pre_flight_friction, and this function reads
 * neither checklist_item_signals nor the reliability/capacity outputs.
 */
const CRON_SCHEDULE = '0 7 * * *'

/** Matches FAMILIARITY_WINDOW_DAYS in auto-assign-turnover.ts. Never a lifetime average. */
const BASELINE_WINDOW_DAYS = 90

/** Below this many completed turnovers in the window, a crew member gets no baseline row. */
const MIN_BASELINE_SAMPLE = 3

/** Upcoming-assignment window for the Smart Fix workload term — same 14 days as auto-assign. */
const WORKLOAD_WINDOW_DAYS = 14

/**
 * Tomorrow.io forecast lookups in flight together per org, per chunk.
 *
 * One outbound call per distinct property LOCATION (already deduped and
 * coordinate-rounded/cached upstream in getTomorrowForecastForLocation), so a
 * 150-property org can still mean up to 150 sequential round-trips if run one
 * at a time — 20-75s inside a single step. Bounded parallelism keeps the
 * total wall time down without opening an unbounded number of connections to
 * a rate-limited third party at once.
 */
const FORECAST_CONCURRENCY = 15

/**
 * Both the size of one `pre_flight_friction` upsert AND the step-boundary
 * chunk size for scoring: each chunk of this many turnovers gets its own
 * step.run(), so a large org's work is checkpointed instead of scored and
 * upserted for the whole day inside one step. See "Score + upsert" below.
 */
const UPSERT_CHUNK = 200
const MS_PER_DAY   = 86_400_000

/** Turnovers already finished or called off have no friction left to forecast. */
const SCOREABLE_STATUSES = ['pending_assignment', 'assigned', 'in_progress', 'flagged'] as const

// ── Dispatcher ──────────────────────────────────────────────────────────────

/**
 * DISPATCHER: finds the orgs with turnovers today and fans out one event each.
 *
 * The scoping note for this module described a single function doing the
 * rollup, the fetch and the scoring for the whole platform. That shape does
 * not survive a real portfolio: the per-property forecast lookups alone are an
 * outbound call each, and one slow tenant would spend the runway every other
 * tenant needs before 7am. Fanning out per org is the convention this codebase
 * settled on for exactly that reason (daily-wrapup.ts, and the six crons
 * converted with it) and is what unbounded-fanout-loops.test.ts requires of a
 * platform-wide scan.
 *
 * The ORDERING guarantee the note actually cared about is untouched: the
 * baseline rollup is still the first step of the same function that consumes
 * it — that function is now the per-org handler, so "rollup before scoring" is
 * still sequential step execution rather than two schedules landing in order.
 */
export const preFlightFriction = inngest.createFunction(
  { id: 'cron-pre-flight-friction', name: 'Cron: Pre-Flight Friction Forecast', retries: 2 },
  { cron: CRON_SCHEDULE },
  async ({ step, logger }) => {
    // Resolved ONCE and passed through. A retry that crossed midnight UTC
    // would otherwise score a different day than the one dispatched, and the
    // upsert would overwrite today's assessments with tomorrow's.
    const turnoverDate = await step.run('resolve-turnover-date', async () =>
      frictionDateString())

    const orgIds = await step.run('find-orgs-with-turnovers-today', async () => {
      const supabase = createServiceClient({ system: 'inngest:pre-flight-friction' })
      const { startUtc, endUtc } = frictionDayUtcBounds(turnoverDate)
      return fetchDistinctOrgIds(
        (from, to) => supabase
          .from('turnovers')
          .select('org_id')
          .gte('checkout_datetime', startUtc)
          .lt('checkout_datetime', endUtc)
          .in('status', SCOREABLE_STATUSES)
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'pre-flight-friction.orgs' },
      )
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-friction-scoring',
        orgIds.map((orgId) => ({
          name: 'friction/pre_flight.requested' as const,
          data: { org_id: orgId, turnover_date: turnoverDate },
        })),
      )
    }

    logger.info(`[preFlightFriction] ${turnoverDate}: dispatched ${orgIds.length} org(s)`)
    return { turnover_date: turnoverDate, dispatched: orgIds.length }
  },
)

// ── Row shapes ──────────────────────────────────────────────────────────────

interface CompletedDurationRow {
  crew_member_id: string
  turnovers: {
    crew_duration_minutes: number | null
    properties: { bedrooms: number | null } | null
  } | null
}

interface ScoreableTurnover {
  id:                 string
  property_id:        string
  checkout_datetime:  string
  checkin_datetime:   string
  is_same_day_turnover: boolean | null
  properties: {
    lat:              PostgrestNumeric
    lng:              PostgrestNumeric
    bedrooms:         number | null
    state:            string | null
    zip:              string | null
    /** Human override, an ARRAY; EMPTY means derive from the ZIP. */
    seasonal_profile: SeasonalProfile[] | null
  } | null
  turnover_assignments: { crew_member_id: string }[] | null
}

interface BaselineRollup {
  /** crew_member_id -> avg minutes per bedroom. */
  byCrew: Record<string, number>
  /** Org-wide median, used for crew with too little history — null when nobody has any. */
  orgMedian: number | null
}

// ── Rollup ──────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Per-crew minutes-per-bedroom samples out of the windowed completion rows. */
function collectDurationSamples(rows: CompletedDurationRow[]): Map<string, number[]> {
  const samples = new Map<string, number[]>()

  for (const row of rows) {
    const turnover = unwrapJoin(row.turnovers)
    const minutes  = turnover?.crew_duration_minutes
    const bedrooms = unwrapJoin(turnover?.properties)?.bedrooms

    // A zero/absent duration or bedroom count is not a fast turnover, it is a
    // missing measurement — including it would drag the baseline toward zero
    // and make every future turnover look comfortably within its window.
    if (!minutes || minutes <= 0 || !bedrooms || bedrooms <= 0) continue

    const existing = samples.get(row.crew_member_id)
    if (existing) existing.push(minutes / bedrooms)
    else samples.set(row.crew_member_id, [minutes / bedrooms])
  }

  return samples
}

function rollupFromSamples(samples: Map<string, number[]>): {
  rollup: BaselineRollup
  rows:   { crew_member_id: string; avg_minutes_per_bedroom: number; sample_size: number }[]
} {
  const byCrew: Record<string, number> = {}
  const rows: { crew_member_id: string; avg_minutes_per_bedroom: number; sample_size: number }[] = []

  for (const [crewMemberId, values] of samples) {
    if (values.length < MIN_BASELINE_SAMPLE) continue
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length
    byCrew[crewMemberId] = avg
    rows.push({
      crew_member_id: crewMemberId,
      avg_minutes_per_bedroom: Math.round(avg * 100) / 100,
      sample_size: values.length,
    })
  }

  // The fallback for a crew member with too little history of their own. It is
  // built from the crew who DO have a baseline, so a brand-new cleaner is
  // measured against the org's real pace rather than skipped — a skipped
  // turnover is an unscored turnover, which is the one outcome this feature
  // must not produce.
  return { rollup: { byCrew, orgMedian: median(Object.values(byCrew)) }, rows }
}

// ── Per-org handler ─────────────────────────────────────────────────────────

export const preFlightFrictionForOrg = inngest.createFunction(
  {
    id:      'friction-pre-flight-for-org',
    name:    'Pre-Flight Friction: Score One Org',
    retries: 2,
    // One run per org at a time, and a global cap so the 07:00 UTC burst does
    // not stampede Supabase or Tomorrow.io.
    concurrency: [{ limit: 10 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'friction/pre_flight.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, turnover_date: turnoverDate } = event.data

    // ── 1. Crew speed baselines ────────────────────────────────────────────
    // FIRST, in the same function, so every later step reads fresh numbers.
    // Ordering here is sequential step execution, not two crons hoping to land
    // in the right order.
    const baselines = await step.run('compute-crew-speed-baselines', async () => {
      const supabase = createServiceClient({ system: 'inngest:pre-flight-friction' })
      const windowStart = new Date(Date.now() - BASELINE_WINDOW_DAYS * MS_PER_DAY).toISOString()

      const rows = await fetchAllRows<CompletedDurationRow>(
        (from, to) => supabase
          .from('turnover_assignments')
          .select('crew_member_id, turnovers!inner(crew_duration_minutes, checkout_datetime, status, properties!inner(bedrooms))')
          .eq('org_id', orgId)
          .eq('turnovers.status', 'completed')
          .gte('turnovers.checkout_datetime', windowStart)
          .order('crew_member_id', { ascending: true })
          .range(from, to),
        { label: `pre-flight-friction.durations[org=${orgId}]` },
      )

      const { rollup, rows: baselineRows } = rollupFromSamples(collectDurationSamples(rows))

      if (baselineRows.length) {
        // Full-row upsert on the primary key: idempotent by construction, so a
        // retry of this step recomputes the same numbers and rewrites them
        // rather than accumulating anything.
        const { error } = await supabase
          .from('crew_speed_baselines')
          .upsert(
            baselineRows.map((r) => ({ ...r, org_id: orgId, computed_at: new Date().toISOString() })),
            { onConflict: 'crew_member_id' },
          )
        if (error) throw new Error(`crew_speed_baselines upsert failed: ${error.message}`)
      }

      return rollup
    })

    // ── 2. Today's turnovers ───────────────────────────────────────────────
    const turnovers = await step.run('fetch-todays-turnovers', async () => {
      const supabase = createServiceClient({ system: 'inngest:pre-flight-friction' })
      const { startUtc, endUtc } = frictionDayUtcBounds(turnoverDate)

      return fetchAllRows<ScoreableTurnover>(
        (from, to) => supabase
          .from('turnovers')
          .select(`
            id, property_id, checkout_datetime, checkin_datetime, is_same_day_turnover,
            properties!inner ( lat, lng, bedrooms, state, zip, seasonal_profile ),
            turnover_assignments ( crew_member_id )
          `)
          .eq('org_id', orgId)
          .gte('checkout_datetime', startUtc)
          .lt('checkout_datetime', endUtc)
          .in('status', SCOREABLE_STATUSES)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `pre-flight-friction.turnovers[org=${orgId}]` },
      )
    })

    if (!turnovers.length) {
      logger.info(`[preFlightFriction] org=${orgId} ${turnoverDate}: no turnovers to score`)
      return { org_id: orgId, scored: 0, flagged: 0 }
    }

    // ── 3. Smart Fix context ───────────────────────────────────────────────
    // Every read here is org-wide and issued ONCE, not per turnover — the
    // per-row-query shape is what n-plus-one-loops exists to catch.
    const crewContext = await step.run('fetch-crew-context', async () =>
      loadCrewContext(orgId, turnovers))

    // ── 4. Forecasts ───────────────────────────────────────────────────────
    const forecasts = await step.run('fetch-forecasts', async () =>
      loadForecasts(orgId, turnoverDate, turnovers))

    // ── 5. Score + upsert, chunked into its own step boundary per UPSERT_CHUNK
    //      turnovers ───────────────────────────────────────────────────────
    //
    // Per-org fan-out bounds work by TENANT, but not by how much work one
    // tenant can generate on a single day. Self-serve is capped at
    // MAX_SELF_SERVE_PROPERTIES (lib/stripe/brackets.ts), but an Enterprise
    // org — a manually negotiated contract explicitly outside that ceiling —
    // carries no such bound, and this step is where that shows up: Smart Fix
    // scoring runs once per turnover, and the "what has the PM already done
    // with today's rows" lookup below is an `.in('turnover_id', ...)` sized by
    // the same count. Scoring and upserting the whole day in one step.run()
    // would scale that one invocation's compute — and its `.in()` list — with
    // a single org's turnover count instead of bounding it, which is exactly
    // the shape this codebase converts to a dispatcher for when the unbounded
    // axis is the TENANT rather than the row. Here the fix is the same idea
    // applied one level down: each chunk is its own step, so a large org's
    // work is checkpointed rather than risking one step's execution budget,
    // and a failure partway through retries only the chunk that failed
    // instead of re-scoring turnovers an earlier chunk already wrote.
    let scored  = 0
    let flagged = 0

    for (let i = 0; i < turnovers.length; i += UPSERT_CHUNK) {
      const chunk = turnovers.slice(i, i + UPSERT_CHUNK)

      const chunkResult = await step.run(`score-and-upsert-chunk-${i}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:pre-flight-friction' })

        // What the PM has already done with today's rows, scoped to this
        // chunk's ids so the .in() list is bounded by UPSERT_CHUNK regardless
        // of how many turnovers the org has today.
        //
        // The upsert below rewrites the whole row, so without this a retry —
        // or any second run on the same date — would resurrect a card the PM
        // had already dismissed an hour earlier, with no error and no way for
        // them to tell it was not a new one.
        const existingRes = await supabase
          .from('pre_flight_friction')
          .select('turnover_id, status, severity')
          .eq('org_id', orgId)
          .in('turnover_id', chunk.map((t) => t.id))
          .limit(chunk.length)

        const existing = new Map(
          unwrapList<{ turnover_id: string; status: string; severity: string }>(
            existingRes,
            { site: 'inngest.pre-flight-friction.existing', orgId },
          ).map((r) => [r.turnover_id, r]),
        )

        const rows = chunk.map((t) =>
          buildFrictionRow({
            orgId, turnoverDate, turnover: t, baselines, crewContext, forecasts,
            previous: existing.get(t.id) ?? null,
          }))

        const { error } = await supabase
          .from('pre_flight_friction')
          .upsert(rows, { onConflict: 'turnover_id' })
        if (error) throw new Error(`pre_flight_friction upsert failed: ${error.message}`)

        return { scored: rows.length, flagged: rows.filter((r) => r.severity !== 'none').length }
      })

      scored  += chunkResult.scored
      flagged += chunkResult.flagged
    }

    logger.info(
      `[preFlightFriction] org=${orgId} ${turnoverDate}: scored ${scored}, ` +
      `${flagged} above threshold`
    )
    return { org_id: orgId, scored, flagged }
  },
)

// ── Context loaders ─────────────────────────────────────────────────────────

interface CrewContext {
  /**
   * CrewCandidate, not a re-declaration of it. These are the exact columns
   * scoreCrewCandidates() reads, and writing them out again here meant two
   * copies of one shape that only a compile error would ever reconcile.
   */
  crew: CrewCandidate[]
  /** crew_member_id -> upcoming assignment count. */
  workloadMap: Record<string, number>
  /** property_id -> crew who worked it inside the familiarity window. */
  familiarByProperty: Record<string, string[]>
}

async function loadCrewContext(
  orgId:     string,
  turnovers: ScoreableTurnover[],
): Promise<CrewContext> {
  const supabase = createServiceClient({ system: 'inngest:pre-flight-friction' })
  const propertyIds = [...new Set(turnovers.map((t) => t.property_id))]

  const workloadEnd   = new Date(Date.now() + WORKLOAD_WINDOW_DAYS * MS_PER_DAY).toISOString()
  const familiarSince = new Date(Date.now() - BASELINE_WINDOW_DAYS * MS_PER_DAY).toISOString()

  // Three independent reads — none depends on another's result, only on
  // orgId/turnovers already in hand — issued together instead of one after
  // another. Each is its own round trip to Postgres, so running them
  // sequentially paid their combined latency before scoring could even start;
  // Promise.all pays only the slowest of the three.
  const [crew, upcoming, history] = await Promise.all([
    fetchAllRows<CrewCandidate>(
      (from, to) => supabase
        .from('crew_members')
        .select('id, name, home_lat, home_lng, reliability_score, capacity_score, auto_assign_eligible')
        .eq('org_id', orgId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
      { label: `pre-flight-friction.crew[org=${orgId}]` },
    ),
    fetchAllRows<{ crew_member_id: string }>(
      (from, to) => supabase
        .from('turnover_assignments')
        .select('crew_member_id, turnovers!inner(checkout_datetime)')
        .eq('org_id', orgId)
        .gte('turnovers.checkout_datetime', new Date().toISOString())
        .lte('turnovers.checkout_datetime', workloadEnd)
        .order('crew_member_id', { ascending: true })
        .range(from, to),
      { label: `pre-flight-friction.workload[org=${orgId}]` },
    ),
    // ONE query for every property being scored, not one per property. The
    // `!inner` embed filters by the turnover's property server-side, so the
    // property id list is the only thing on the wire.
    fetchAllRows<{ crew_member_id: string; turnovers: { property_id: string } | null }>(
      (from, to) => supabase
        .from('turnover_assignments')
        .select('crew_member_id, turnovers!inner(property_id, checkout_datetime)')
        .eq('org_id', orgId)
        .in('turnovers.property_id', propertyIds)
        .gte('turnovers.checkout_datetime', familiarSince)
        .order('crew_member_id', { ascending: true })
        .range(from, to),
      { label: `pre-flight-friction.familiarity[org=${orgId}]` },
    ),
  ])

  const workloadMap: Record<string, number> = {}
  for (const row of upcoming) {
    workloadMap[row.crew_member_id] = (workloadMap[row.crew_member_id] ?? 0) + 1
  }

  const familiarByProperty: Record<string, string[]> = {}
  for (const row of history) {
    const propertyId = unwrapJoin(row.turnovers)?.property_id
    if (!propertyId) continue
    const list = familiarByProperty[propertyId]
    if (list) { if (!list.includes(row.crew_member_id)) list.push(row.crew_member_id) }
    else familiarByProperty[propertyId] = [row.crew_member_id]
  }

  return { crew, workloadMap, familiarByProperty }
}

/**
 * One forecast per distinct property location, keyed by property id.
 *
 * A forecast failure degrades to NO weather component rather than failing the
 * org's whole run: Tomorrow.io being slow must not cost the PM every other
 * signal on the page. It is reported at 'warning' — a degradation worth seeing
 * before it becomes an outage, not a fault.
 */
async function loadForecasts(
  orgId:        string,
  turnoverDate: string,
  turnovers:    ScoreableTurnover[],
): Promise<Record<string, DayForecast | null>> {
  const located = new Map<string, { lat: number; lng: number }>()
  for (const t of turnovers) {
    const lat = Number(unwrapJoin(t.properties)?.lat)
    const lng = Number(unwrapJoin(t.properties)?.lng)
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
      located.set(t.property_id, { lat, lng })
    }
  }

  const forecasts: Record<string, DayForecast | null> = {}

  // Bounded-concurrency chunks rather than one call at a time: a fully
  // sequential loop here is exactly the 20-75s-per-org latency finding this
  // guards against at real portfolio scale. Each chunk still awaits fully
  // before the next starts, so this never opens more than
  // FORECAST_CONCURRENCY connections to Tomorrow.io at once — the existing
  // Redis cache, single-flight lock and timeout budget inside
  // getTomorrowForecastForLocation are untouched, only how many callers can
  // reach them concurrently changes.
  for (const chunk of chunkArray(Array.from(located.entries()), FORECAST_CONCURRENCY)) {
    await Promise.all(chunk.map(async ([propertyId, coords]) => {
      try {
        forecasts[propertyId] = await getTomorrowForecastForLocation(coords.lat, coords.lng, turnoverDate)
      } catch (err) {
        forecasts[propertyId] = null
        reportError(err, {
          site:  'inngest.pre-flight-friction.forecast',
          orgId,
          // A protective degradation that did the safe thing, not a fault: the
          // turnover still scores on every other component. 'warning' is what
          // keeps a slow provider out of the error triage queue while staying
          // searchable.
          level: 'warning',
          extra: { property_id: propertyId, turnover_date: turnoverDate },
        })
      }
    }))
  }

  return forecasts
}

// ── Scoring one turnover ────────────────────────────────────────────────────

/**
 * The team's expected minutes for this property.
 *
 * The MEAN of the assigned crew's baselines, not the sum. crew_duration_minutes
 * is ELAPSED turnover time (max minus min completion timestamp), so each
 * baseline already describes wall-clock for a turnover that person worked —
 * summing two of them would double-count the same clock and flag every
 * two-person turnover as a 2x overrun. Nobody assigned, or nobody with a
 * baseline, falls back to the org median.
 */
function estimatedMinutes(
  crewIds:   string[],
  bedrooms:  number,
  baselines: BaselineRollup,
): number {
  const rates = crewIds.map((id) => baselines.byCrew[id]).filter((r): r is number => typeof r === 'number')
  const perBedroom = rates.length
    ? rates.reduce((sum, r) => sum + r, 0) / rates.length
    : baselines.orgMedian

  // No baseline anywhere in the org yet — a brand-new tenant. Zero means this
  // one component contributes nothing; every other component still scores.
  if (perBedroom === null) return 0
  return perBedroom * bedrooms
}

function windowMinutes(turnover: ScoreableTurnover): number {
  const checkout = new Date(turnover.checkout_datetime).getTime()
  const checkin  = new Date(turnover.checkin_datetime).getTime()
  if (!Number.isFinite(checkout) || !Number.isFinite(checkin)) return 0
  return (checkin - checkout) / 60_000
}

interface FrictionRowInput {
  orgId:        string
  turnoverDate: string
  turnover:     ScoreableTurnover
  baselines:    BaselineRollup
  crewContext:  CrewContext
  forecasts:    Record<string, DayForecast | null>
  /** Today's stored row, when this is a re-score rather than a first pass. */
  previous:     { status: string; severity: string } | null
}

function componentsFor(input: FrictionRowInput): FrictionComponents {
  const { turnover, baselines, forecasts, turnoverDate } = input
  const property = unwrapJoin(turnover.properties)
  // The profiles describe a MARKET, so they are derived from the ZIP unless a
  // human has deliberately overridden them. Resolved here rather than stored
  // on the property: expanding the ZIP table then reaches every existing
  // property on the next run, with no backfill and no write path to keep in
  // sync. An ARRAY — a market can have more than one peak season, and the
  // whole array is passed through rather than [0].
  const profiles = resolveSeasonalProfile(property?.seasonal_profile, property?.zip)
  const date     = localDateFrom(turnoverDate)

  const crewIds  = (turnover.turnover_assignments ?? []).map((a) => a.crew_member_id)
  const forecast = forecasts[turnover.property_id] ?? null

  return {
    crewDurationVsBaseline: crewDurationScore(
      estimatedMinutes(crewIds, property?.bedrooms ?? 0, baselines),
      windowMinutes(turnover),
    ),
    weather:     forecast ? weatherScore(forecast) : 0,
    weekend:     weekendScore(date),
    holiday:     holidayScore(date),
    seasonal:    seasonalScore(profiles, date),
    springBreak: springBreakScore(property?.state ?? null, profiles, date),
    interaction: interactionScore(profiles, date),
    // Never conditional, never omitted — see FrictionComponents.localEvents.
    localEvents: 0,
  }
}

/**
 * The best UNASSIGNED-or-better alternative crew member, scored with the same
 * ranking the turnover board's own suggestion uses.
 */
function smartFixFor(input: FrictionRowInput): { id: string; reasoning: string } | null {
  const { turnover, crewContext } = input
  const property = unwrapJoin(turnover.properties)
  if (!crewContext.crew.length) return null

  const assigned = new Set((turnover.turnover_assignments ?? []).map((a) => a.crew_member_id))
  const candidates = crewContext.crew.filter((c) => !assigned.has(c.id))
  if (!candidates.length) return null

  // topCrewCandidate(), not scoreCrewCandidates(): only the best alternative
  // is ever surfaced as the Smart Fix, so sorting the whole candidate array
  // for one flagged turnover — repeated for every flagged turnover in the
  // org — is O(n log n) work thrown away except for index 0.
  const top = topCrewCandidate({
    isSameDay:       turnover.is_same_day_turnover ?? false,
    property:        { lat: property?.lat ?? null, lng: property?.lng ?? null },
    crew:            candidates,
    familiarCrewIds: crewContext.familiarByProperty[turnover.property_id] ?? [],
    workloadMap:     crewContext.workloadMap,
  })

  return top ? { id: top.crew_member_id, reasoning: crewSuggestionReasoning(top) } : null
}

const SEVERITY_RANK: Record<string, number> = { none: 0, high: 1, critical: 2 }

/**
 * What a re-score does to a row the PM may already have acted on.
 *
 * A turnover that no longer clears the threshold is 'resolved' — leaving
 * yesterday's 'flagged' standing over today's clean numbers would keep a card
 * on the panel that the data no longer supports.
 *
 * Otherwise a PM decision is only overturned by the situation getting WORSE.
 * An accepted Smart Fix or a dismissal stands through a same-severity
 * rescore; a turnover that climbs from high to critical is re-flagged,
 * because that is new information rather than the same card again.
 */
function nextStatus(
  severity: 'none' | 'high' | 'critical',
  previous: { status: string; severity: string } | null,
): 'flagged' | 'resolved' | 'dismissed' {
  if (severity === 'none') return 'resolved'
  if (!previous || previous.status === 'flagged') return 'flagged'

  const worsened = (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[previous.severity] ?? 0)
  if (worsened) return 'flagged'
  return previous.status === 'dismissed' ? 'dismissed' : 'resolved'
}

function buildFrictionRow(input: FrictionRowInput) {
  const components = componentsFor(input)
  const score      = computeFrictionScore(components)
  const severity   = severityFromScore(score)

  // Only worth a Smart Fix when there is something to fix. Computing one for
  // every clean turnover would burn scoring work on rows the panel never
  // renders.
  const smartFix = severity === 'none' ? null : smartFixFor(input)

  return {
    org_id:              input.orgId,
    turnover_id:         input.turnover.id,
    property_id:         input.turnover.property_id,
    turnover_date:       input.turnoverDate,
    failure_probability: Math.round(score * 1000) / 1000,
    // Spread into an index-signature record so it satisfies the column's Json
    // type. Every key survives — including localEvents: 0, which is the point.
    score_breakdown:     { ...components } as Record<string, number>,
    severity,
    status:              nextStatus(severity, input.previous),
    smart_fix_crew_id:   smartFix?.id ?? null,
    smart_fix_reasoning: smartFix?.reasoning ?? null,
    computed_at:         new Date().toISOString(),
  }
}
