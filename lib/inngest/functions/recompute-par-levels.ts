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
    // A property-size edit can fire this repeatedly while a PM is typing.
    // Collapsing to one run per org+property per minute keeps that from
    // becoming a queue of identical recomputes.
    debounce: { key: 'event.data.org_id + "/" + (event.data.property_id ?? "all")', period: '1m' },
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
