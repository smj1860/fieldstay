import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { haversineKm, proximityScore } from '@/lib/scoring/geo'

export const autoAssignTurnover = inngest.createFunction(
  { id: 'auto-assign-turnover', name: 'Auto-Assign Crew to Turnover', retries: 2 },
  { event: 'turnover/created' },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, checkout_datetime } = event.data

    const context = await step.run('load-context', async () => {
      const supabase = createServiceClient()

      const [
        { data: org },
        { data: turnover },
        { data: property },
        { data: crew },
      ] = await Promise.all([
        supabase.from('organizations').select('auto_assign_mode').eq('id', org_id).single(),
        supabase.from('turnovers').select('id, status, is_same_day_turnover').eq('id', turnover_id).eq('org_id', org_id).single(),
        supabase.from('properties').select('id, lat, lng, bedrooms').eq('id', property_id).eq('org_id', org_id).single(),
        supabase
          .from('crew_members')
          .select('id, name, home_lat, home_lng, reliability_score, capacity_score')
          .eq('org_id', org_id)
          .eq('is_active', true),
      ])

      const mode = (org?.auto_assign_mode ?? 'disabled') as string
      if (mode === 'disabled' || !turnover || !crew?.length) return null

      // Exclude crew who've marked themselves unavailable for the turnover's
      // date — there's no human in the loop here to override a bad auto-pick,
      // so this is a hard exclusion rather than a score penalty.
      const checkoutDate = checkout_datetime.split('T')[0]
      const { data: timeOff } = await supabase
        .from('crew_availability')
        .select('crew_member_id')
        .eq('org_id', org_id)
        .eq('available_date', checkoutDate)
        .eq('is_available', false)
        .in('crew_member_id', crew.map((c) => c.id))

      const unavailableIds = new Set((timeOff ?? []).map((t) => t.crew_member_id))
      const availableCrew  = crew.filter((c) => !unavailableIds.has(c.id))

      if (!availableCrew.length) return null

      // Familiarity: which crew have been assigned to this property before
      const { data: propertyTurnovers } = await supabase
        .from('turnovers')
        .select('id')
        .eq('property_id', property_id)
        .eq('org_id', org_id)
        .neq('id', turnover_id)

      const pastTurnoverIds = (propertyTurnovers ?? []).map((t) => t.id)
      let familiarCrewIds: string[] = []

      if (pastTurnoverIds.length > 0) {
        const { data: history } = await supabase
          .from('turnover_assignments')
          .select('crew_member_id')
          .in('turnover_id', pastTurnoverIds)
          .in('crew_member_id', availableCrew.map((c) => c.id))

        const historyItems = (history ?? []) as Array<{ crew_member_id: string }>
        familiarCrewIds = [...new Set(historyItems.map((h) => h.crew_member_id))]
      }

      // Workload: assignments in next 14 days only (not all-time history)
      const windowEnd = new Date()
      windowEnd.setDate(windowEnd.getDate() + 14)

      const { data: upcoming } = await supabase
        .from('turnover_assignments')
        .select('crew_member_id, turnovers!inner(checkout_datetime)')
        .in('crew_member_id', availableCrew.map((c) => c.id))
        .gte('turnovers.checkout_datetime', new Date().toISOString())
        .lte('turnovers.checkout_datetime', windowEnd.toISOString())

      const workloadMap: Record<string, number> = {}
      for (const a of upcoming ?? []) {
        workloadMap[a.crew_member_id] = (workloadMap[a.crew_member_id] ?? 0) + 1
      }

      return {
        mode,
        isSameDay:       turnover.is_same_day_turnover ?? false,
        property:        { lat: property?.lat ?? null, lng: property?.lng ?? null, bedrooms: property?.bedrooms ?? null },
        crew:            availableCrew,
        familiarCrewIds,
        workloadMap,
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
      const supabase = createServiceClient()
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
      const supabase = createServiceClient()
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
