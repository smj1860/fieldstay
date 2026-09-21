import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { sendEventsChunked } from '@/lib/inngest/chunk'
import { recomputeParLevels } from '@/lib/inventory/recompute-par'

/**
 * PAR pass 2: resolve smart par levels against each property's real size.
 *
 * A smart item written from a template carries the TEMPLATE's default until
 * this runs — the number computed for a generic reference property — so a
 * studio and a six-bedroom lodge both show 14 bath towels. This turns base_qty
 * into a real number per property, and starts using historical consumption
 * automatically once the recorder exists to populate it.
 *
 * ONE PROPERTY PER INVOCATION, always. property_id omitted/null on the event
 * no longer means "recompute the whole org inline" — that used to call
 * recomputeParLevels(supabase, { orgId }) directly inside this single step,
 * which reads every active property AND every smart item for the org through
 * fetchAllRows's PROPERTY_CAP/ITEM_CAP. Those caps throw rather than silently
 * truncate (by design — see lib/inngest/paginate.ts), but that means a large
 * org's org-wide recompute was permanently un-completable: every retry
 * re-read the same unbounded scope and re-threw at the same ceiling, with no
 * checkpoint to resume from. Omitting property_id now dispatches
 * recomputeParLevelsOrgFn below instead, which fans out one event per
 * property — each with its own retry boundary and a read bounded to a single
 * property's items, far under either cap.
 *
 * The per-property step below is still a single step for one property's
 * bounded reads plus one RPC — nothing to checkpoint between, and the write
 * is idempotent by construction: resolvePar() is a pure function of
 * (config, property, stats), so a retry recomputes the same numbers and the
 * RPC reports zero changed the second time.
 */
export const recomputeParLevelsFn = inngest.createFunction(
  {
    id:      'recompute-par-levels',
    name:    'Inventory — recompute smart par levels',
    retries: 3,
    // NO debounce, deliberately. The first version carried
    //   debounce: { key: 'event.data.org_id + "/" + (event.data.property_id ?? "all")' }
    // which is JavaScript, not CEL — Inngest evaluates these keys as CEL, which
    // has no `??` operator. It was also the only debounce in this codebase, so
    // the option itself was unproven against this deployment, and a config
    // Inngest rejects at sync time means the function is never registered and
    // every event fires into nothing. That is indistinguishable from working
    // until someone checks whether par_resolved_at moved.
    //
    // Nothing is lost by dropping it: resolvePar() is a pure function of
    // (config, property, stats), so a duplicate run recomputes identical
    // numbers and the RPC reports zero changed. Debounce here would have been
    // an optimisation, never a correctness requirement.
  },
  { event: 'inventory/par-recompute-requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, property_id: propertyId } = event.data

    if (!propertyId) {
      // Org-wide scope: hand off to the fan-out dispatcher rather than
      // computing inline here — see the header comment above. Top level, not
      // inside a step.run: step tooling inside a step.run callback only
      // WARNS, then unwinds the request and re-runs the callback from the
      // top, replaying whatever ran before it (CLAUDE.md's Inngest
      // constraints).
      await step.sendEvent('dispatch-org-wide', {
        name: 'inventory/par-recompute-org-requested',
        data: { org_id: orgId },
      })
      logger.info(`[recompute-par-levels] org=${orgId} scope=all — dispatched to per-property fan-out`)
      return { dispatched: true }
    }

    const result = await step.run('recompute', async () => {
      const supabase = createServiceClient({ system: 'inngest:recompute-par-levels' })
      return await recomputeParLevels(supabase, { orgId, propertyId })
    })

    logger.info(
      `[recompute-par-levels] org=${orgId} scope=${propertyId} ` +
        `properties=${result.properties} resolved=${result.resolved} changed=${result.changed}`
    )
    return result
  }
)

/**
 * Org-wide dispatcher: fetches every active property id for the org (bounded
 * — a property list, not an item list, so it stays far under PROPERTY_CAP
 * even for a large portfolio) and fans out one inventory/par-recompute-
 * requested event per property via sendEventsChunked, so a broadcast to
 * thousands of properties issues a bounded number of chunked sends rather
 * than one event-count-limited call.
 *
 * Each dispatched event lands on recomputeParLevelsFn above, scoped to a
 * single property — its own retry boundary, its own bounded item read.
 */
export const recomputeParLevelsOrgFn = inngest.createFunction(
  {
    id:      'recompute-par-levels-org',
    name:    'Inventory — recompute smart par levels (org-wide dispatcher)',
    retries: 3,
  },
  { event: 'inventory/par-recompute-org-requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id

    const propertyIds = await step.run('find-properties', async () => {
      const supabase = createServiceClient({ system: 'inngest:recompute-par-levels-org' })
      const rows = await fetchAllRows<{ id: string }>(
        (from, to) => supabase
          .from('properties')
          .select('id')
          .eq('org_id', orgId)
          .eq('is_active', true)
          .order('id')
          .range(from, to),
        { label: `properties(recompute-par-levels-org)[org=${orgId}]` },
      )
      return rows.map((r) => r.id)
    })

    if (propertyIds.length) {
      // Top level, not inside the step.run above — see the note in
      // recomputeParLevelsFn.
      await sendEventsChunked(
        step,
        'dispatch-property-recomputes',
        propertyIds.map((propertyId) => ({
          name: 'inventory/par-recompute-requested' as const,
          data: { org_id: orgId, property_id: propertyId },
        })),
      )
    }

    logger.info(`[recompute-par-levels-org] org=${orgId} dispatched ${propertyIds.length} propert(y/ies)`)
    return { dispatched: propertyIds.length }
  }
)
