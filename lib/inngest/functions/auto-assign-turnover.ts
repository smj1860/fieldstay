import { inngest } from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { haversineKm, proximityScore } from '@/lib/scoring/geo'
import { computeWorkloadMap, computeFamiliarIds } from '@/lib/scoring/pools'
import { throwIfAnyQueryFailed, isRealQueryError, unwrapList } from '@/lib/supabase/unwrap'

/**
 * How far back "has worked this property before" looks.
 *
 * Matches the 14-day workload window's philosophy: a rolling window, not the
 * property's entire lifetime. See the familiarity read for why this is a
 * deliberate behaviour change rather than only a cost one.
 */
const FAMILIARITY_WINDOW_DAYS = 90

/**
 * Why the candidate pool came back empty, when the org DOES have active crew.
 *
 * Carried through to the crew/assignment-gap notification so the PM is told
 * which lever to pull. "No crew available" on an org with five cleaners reads
 * as a bug; "all five are excluded from auto-assignment" is actionable.
 */
type GapReason = 'none_eligible' | 'all_unavailable'

export const autoAssignTurnover = inngest.createFunction(
  {
    id: 'auto-assign-turnover', name: 'Auto-Assign Crew to Turnover', retries: 2,
    concurrency: [
      // Triggered by turnover/created, which the generator emits as an ARRAY —
      // one per turnover it just created for a property. This handler runs ~8
      // queries per invocation, so an uncapped batch is the single largest
      // multiplier on connection usage in the whole event graph.
      { limit: 10 },

      // ONE run per turnover at a time.
      //
      // The global cap above does not stop two runs for the SAME turnover
      // overlapping — a duplicate turnover/created, or a retry racing the
      // original. The `(turnover_id, crew_member_id)` unique index only
      // catches them picking the SAME crew member; scores shift as workload
      // changes, so two concurrent runs can pick DIFFERENT top candidates and
      // both inserts succeed, leaving two crew silently assigned to a
      // one-person job and turnovers.status flipped twice.
      //
      // Serialising per turnover is the whole fix: the second run then loads
      // context AFTER the first has committed, sees status 'assigned', and
      // returns early.
      //
      // NOT what the audit proposed. It called for an assign_crew_atomic() RPC
      // enforcing a per-crew-per-day cap — but no such cap exists anywhere in
      // this product. `capacity_score` is a 0-1 SCORING WEIGHT, not a limit,
      // and nothing in the schema, the settings, or the UI defines a maximum
      // number of turnovers per crew per day. A cleaner doing several
      // turnovers in a day is the normal case, not over-booking. Implementing
      // that RPC would mean inventing a business rule and making autopilot
      // silently refuse assignments it makes today — a product decision
      // wearing a scalability fix's clothes.
      { limit: 1, key: 'event.data.turnover_id' },
    ],
  },
  { event: 'turnover/created' },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, checkout_datetime } = event.data

    const context = await step.run('load-context', async () => {
      const supabase = createServiceClient({ system: 'inngest:auto-assign-turnover' })

      const [
        { data: org, error: orgError },
        { data: turnover, error: turnoverError },
        { data: property, error: propertyError },
        crew,
      ] = await Promise.all([
        supabase.from('organizations').select('auto_assign_mode').eq('id', org_id).single(),
        supabase.from('turnovers').select('id, status, is_same_day_turnover').eq('id', turnover_id).eq('org_id', org_id).single(),
        supabase.from('properties').select('id, lat, lng, bedrooms').eq('id', property_id).eq('org_id', org_id).single(),
        // Paginated, like every other read in this function. It was the one
        // left on a bare .select(), so past 1,000 active crew members the
        // candidates beyond PostgREST's cap were silently dropped from
        // scoring — the assignment engine would quietly consider only part of
        // the roster and report nothing.
        fetchAllRows<{
          id: string; name: string; home_lat: number | null; home_lng: number | null
          reliability_score: number; capacity_score: number
          auto_assign_eligible: boolean
        }>(
          (from, to) => supabase
            .from('crew_members')
            .select('id, name, home_lat, home_lng, reliability_score, capacity_score, auto_assign_eligible')
            .eq('org_id', org_id)
            .eq('is_active', true)
            .order('id')
            .range(from, to),
          { label: `auto-assign-turnover.crew[org=${org_id}]` },
        ),
      ])
      throwIfAnyQueryFailed(
        { site: 'inngest.auto-assign-turnover.load-context', orgId: org_id },
        isRealQueryError(orgError) ? orgError : null,
        isRealQueryError(turnoverError) ? turnoverError : null,
        isRealQueryError(propertyError) ? propertyError : null,
      )

      const mode = (org?.auto_assign_mode ?? 'disabled') as string

      // NULL means "there is nothing to say" — autopilot is off, the turnover
      // vanished, or the org has no active crew at all. Those need no alert:
      // an org with an empty roster already knows.
      //
      // Everything BELOW this line is different. Crew exist, and the pool was
      // emptied by a filter — which is a state the PM can act on and cannot
      // otherwise see, so it returns an empty candidate list and lets the
      // existing `crew/assignment-gap` notification fire, carrying the reason.
      if (mode === 'disabled' || !turnover || !crew?.length) return null

      const gap = (reason: GapReason) => ({
        mode,
        isSameDay:       turnover.is_same_day_turnover ?? false,
        property:        { lat: property?.lat ?? null, lng: property?.lng ?? null, bedrooms: property?.bedrooms ?? null },
        crew:            [] as typeof crew,
        familiarCrewIds: [] as string[],
        workloadMap:     {} as Record<string, number>,
        gapReason:       reason,
      })

      // The per-crew opt-out (crew_members.auto_assign_eligible, DEFAULT true).
      // Filtered in JS rather than added to the query above ON PURPOSE: the
      // COUNT of ineligible crew is what distinguishes "you have no crew" from
      // "you have crew and have excluded all of them", and a WHERE clause
      // throws that away. One read either way.
      //
      // `!== false`, not truthiness. The column is NOT NULL DEFAULT true, so a
      // real row always carries a boolean — but that makes `undefined` mean
      // "this value did not come from the column", and the safe reading of that
      // is the column's own default. Truthiness would instead exclude EVERY
      // crew member the moment the field went missing from the select string,
      // turning a typo into a silent org-wide assignment outage. Same
      // convention as the crew-manage UI's `=== false` checks.
      const eligibleCrew = crew.filter((c) => c.auto_assign_eligible !== false)
      if (!eligibleCrew.length) return gap('none_eligible')

      // Exclude crew who've marked themselves unavailable for the turnover's
      // date — there's no human in the loop here to override a bad auto-pick,
      // so this is a hard exclusion rather than a score penalty.
      const checkoutDate = checkout_datetime.split('T')[0]
      const timeOffRes = await supabase
        .from('crew_availability')
        .select('crew_member_id')
        .eq('org_id', org_id)
        .eq('available_date', checkoutDate)
        .eq('is_available', false)
        .in('crew_member_id', eligibleCrew.map((c) => c.id))
        // Bounded: at most one row per crew member per date.
        .limit(eligibleCrew.length)

      const timeOff = unwrapList(timeOffRes, { site: 'inngest.auto-assign-turnover.load-context', orgId: org_id })

      const unavailableIds = new Set(timeOff.map((t) => t.crew_member_id))
      const availableCrew  = eligibleCrew.filter((c) => !unavailableIds.has(c.id))

      // Previously `return null`, i.e. silence. An org whose whole eligible
      // roster booked the same day off got no assignment and no alert — the
      // turnover simply sat unassigned until someone noticed.
      if (!availableCrew.length) return gap('all_unavailable')

      // Familiarity: which crew have worked this property RECENTLY.
      //
      // This was two queries — every turnover ever generated for the property,
      // then every assignment for that whole id set — re-run from scratch for
      // each new turnover. A bulk iCal re-sync creating K turnovers on a
      // property with P of history therefore cost O(K x P) reads.
      //
      // The sharper problem was the shape, not the volume. Both reads were
      // correctly paginated, so neither TRUNCATED — but `.in('turnover_id',
      // pastTurnoverIds)` puts every one of those ids in the QUERY STRING, on
      // every page. A property with a few thousand past turnovers builds a
      // ~40-character id list per row into a request line that a gateway
      // rejects outright, long before row counts matter. Pagination does not
      // help with that; it repeats it per page.
      //
      // One joined, windowed query fixes both. The `!inner` embed filters
      // assignments by their turnover's property server-side, so no id list
      // crosses the wire at all, and FAMILIARITY_WINDOW_DAYS bounds the scan
      // to a rolling window instead of the property's whole lifetime.
      //
      // Windowing is a deliberate behaviour change: "has worked here before"
      // becomes "has worked here in the last 90 days". That is a better signal
      // for the purpose — a crew member who cleaned this property once, three
      // years ago, is not meaningfully familiar with it — and it matches the
      // workload read below, which has always used a 14-day window for the
      // same reason.
      const familiarSince = new Date(Date.now() - FAMILIARITY_WINDOW_DAYS * 86_400_000).toISOString()

      const history = await fetchAllRows<{ crew_member_id: string }>(
        (from, to) => supabase
          .from('turnover_assignments')
          .select('crew_member_id, turnovers!inner(property_id, checkout_datetime)')
          .eq('turnovers.property_id', property_id)
          .eq('org_id', org_id)
          .gte('turnovers.checkout_datetime', familiarSince)
          .neq('turnover_id', turnover_id)
          .in('crew_member_id', availableCrew.map((c) => c.id))
          .order('crew_member_id')
          .range(from, to),
        { label: `auto-assign-turnover.history[property=${property_id}]` },
      )

      const familiarCrewIds = computeFamiliarIds(history, (h) => h.crew_member_id)

      // Workload: assignments in next 14 days only (not all-time history)
      const windowEnd = new Date()
      windowEnd.setDate(windowEnd.getDate() + 14)

      // Paginated: bounded by a 14-day window, but a large crew across a large
      // portfolio still fans out to more assignment rows than the cap. A
      // truncated read UNDERSTATES workload, which biases the suggestion toward
      // the crew members who are already the busiest.
      const upcoming = await fetchAllRows<{ crew_member_id: string }>(
        (from, to) => supabase
          .from('turnover_assignments')
          .select('crew_member_id, turnovers!inner(checkout_datetime)')
          .in('crew_member_id', availableCrew.map((c) => c.id))
          .gte('turnovers.checkout_datetime', new Date().toISOString())
          .lte('turnovers.checkout_datetime', windowEnd.toISOString())
          .order('crew_member_id')
          .range(from, to),
        { label: 'auto-assign-turnover.workload' },
      )

      const workloadMap = computeWorkloadMap(upcoming, (a) => a.crew_member_id)

      return {
        mode,
        isSameDay:       turnover.is_same_day_turnover ?? false,
        property:        { lat: property?.lat ?? null, lng: property?.lng ?? null, bedrooms: property?.bedrooms ?? null },
        crew:            availableCrew,
        familiarCrewIds,
        workloadMap,
        gapReason:       null as GapReason | null,
      }
    })

    if (!context) return { skipped: true, reason: 'disabled or no candidates' }

    const scored = await step.run('score-candidates', async () => {
      const { isSameDay, property, crew, familiarCrewIds, workloadMap } = context

      const weights = isSameDay
        ? { proximity: 0.40, reliability: 0.30, capacity: 0.15, workload: 0.10, familiarity: 0.05 }
        : { familiarity: 0.30, reliability: 0.25, workload: 0.20, proximity: 0.15, capacity: 0.10 }

      const maxWorkload = Math.max(...(Object.values(workloadMap) as number[]), 1)
      const familiarSet = new Set(familiarCrewIds)

      return crew
        .map((c) => {
          const proximity =
            c.home_lat && c.home_lng && property.lat && property.lng
              ? proximityScore(haversineKm(
                  Number(c.home_lat), Number(c.home_lng),
                  Number(property.lat), Number(property.lng),
                ))
              : 0.5

          // reliability_score/capacity_score are numeric columns already scaled 0–1
          // (e.g. 1.000 = 100%), NOT 0–100 despite the old code's /100 implying a
          // percentage scale. PostgREST also returns numeric columns as strings, so
          // coerce explicitly rather than relying on implicit arithmetic coercion.
          const reliability = c.reliability_score !== null ? Number(c.reliability_score) : 0.7
          const capacity    = c.capacity_score    !== null ? Number(c.capacity_score)    : 0.7
          const workload    = 1 - (workloadMap[c.id] ?? 0) / maxWorkload
          const familiarity = familiarSet.has(c.id) ? 1.0 : 0.0

          const score = isSameDay
            ? proximity   * weights.proximity   +
              reliability * weights.reliability  +
              capacity    * weights.capacity     +
              workload    * weights.workload     +
              familiarity * weights.familiarity
            : familiarity * weights.familiarity  +
              reliability * weights.reliability  +
              workload    * weights.workload     +
              proximity   * weights.proximity    +
              capacity    * weights.capacity

          return {
            crew_member_id: c.id,
            name:           c.name,
            score,
            breakdown:      { proximity, reliability, capacity, workload, familiarity },
          }
        })
        .sort((a, b) => b.score - a.score)
    })

    if (!scored.length) {
      await step.sendEvent('notify-assignment-gap', {
        name: 'crew/assignment-gap',
        data: {
          turnover_id,
          property_id,
          org_id,
          turnover_date: checkout_datetime,
          crew_needed:   1,
          crew_found:    0,
          // Optional, and absent on the original path where scoring simply
          // produced nobody. Present when a filter emptied a non-empty roster,
          // which is the case the PM can actually fix.
          ...(context.gapReason ? { reason: context.gapReason } : {}),
        },
      })
      return { gap: true }
    }

    const top = scored[0]!

    const reasons: string[] = []
    if (top.breakdown.familiarity === 1)  reasons.push('knows this property')
    if (top.breakdown.proximity   > 0.7)  reasons.push('nearby')
    if (top.breakdown.reliability > 0.8)  reasons.push('high reliability')
    if (top.breakdown.workload    > 0.8)  reasons.push('light schedule')

    const reasoning = reasons.length
      ? `${top.name} — ${reasons.join(', ')}`
      : top.name

    const acted = await step.run('act-on-mode', async () => {
      const supabase = createServiceClient({ system: 'inngest:auto-assign-turnover' })
      const { mode } = context

      if (mode === 'suggest') {
        await supabase
          .from('turnovers')
          .update({
            suggested_crew_ids:   [top.crew_member_id],
            suggestion_reasoning: reasoning,
            suggestion_status:    'pending',
          })
          .eq('id', turnover_id)
          .eq('org_id', org_id)
        return { action: 'suggested' as const }
      }

      if (mode === 'autopilot') {
        const { error: assignError } = await supabase.from('turnover_assignments').insert({
          turnover_id,
          crew_member_id: top.crew_member_id,
          org_id,
        })

        if (assignError) {
          // Already assigned (e.g. retry after a prior successful insert) — leave
          // turnovers.status as-is rather than re-marking it assigned.
          if (assignError.code === '23505') return { action: 'already_assigned' as const }
          throw new Error(`Failed to create turnover assignment: ${assignError.message}`)
        }

        await supabase
          .from('turnovers')
          .update({
            status:               'assigned',
            suggested_crew_ids:   [top.crew_member_id],
            suggestion_reasoning: reasoning,
            suggestion_status:    'accepted',
          })
          .eq('id', turnover_id)
          .eq('org_id', org_id)

        const { logAuditEvent } = await import('@/lib/audit')
        await logAuditEvent({
          orgId:      org_id,
          actorId:    undefined,
          action:     'turnover.autopilot.assigned',
          targetType: 'turnover',
          targetId:   turnover_id,
          metadata:   {
            crew_member_id: top.crew_member_id,
            reasoning,
            score:           top.score,
          },
        })

        return { action: 'autopilot_assigned' as const }
      }

      return { action: 'noop' as const }
    })

    await step.run('record-outcomes', async () => {
      const supabase = createServiceClient({ system: 'inngest:auto-assign-turnover' })
      const wasAutopilotAssigned =
        acted.action === 'autopilot_assigned' || acted.action === 'already_assigned'

      const { error } = await supabase.from('assignment_outcomes').upsert(
        {
          turnover_id,
          org_id,
          crew_member_id:  top.crew_member_id,
          // suggested_score is SMALLINT — a 0-100 score, per its column
          // comment. top.score is the raw 0-1 composite from proximityScore()
          // et al.; inserting it unconverted always failed with "invalid
          // input syntax for type smallint" and this row was never written.
          suggested_score:    Math.round(top.score * 100),
          score_breakdown:    top.breakdown,
          was_accepted:       wasAutopilotAssigned ? true : null,
          was_suggestion:     true,
          property_bedrooms:  context.property.bedrooms,
        },
        { onConflict: 'turnover_id,crew_member_id' }
      )

      // 42P01 = table does not exist — never fail the parent function for that.
      // Any other error (RLS, FK violation, etc.) should surface and retry.
      if (error && error.code !== '42P01') {
        throw new Error(`Failed to record assignment outcome: ${error.message}`)
      }
    })

    return { action: acted.action, top_crew: top.name }
  }
)
