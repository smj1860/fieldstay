import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
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
 * Runs in a single step. The work is three bounded reads and one RPC for the
 * whole scope, not per-property queries, so there is nothing to check-point
 * between — and splitting it would mean re-reading the same rows on retry for
 * no gain. The write is idempotent by construction: resolvePar() is a pure
 * function of (config, property, stats), so a retry recomputes the same
 * numbers and the RPC reports zero changed the second time.
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

    const result = await step.run('recompute', async () => {
      const supabase = createServiceClient({ system: 'inngest:recompute-par-levels' })
      return await recomputeParLevels(supabase, {
        orgId,
        propertyId: propertyId ?? undefined,
      })
    })

    logger.info(
      `[recompute-par-levels] org=${orgId} scope=${propertyId ?? 'all'} ` +
        `properties=${result.properties} resolved=${result.resolved} changed=${result.changed}`
    )
    return result
  }
)
