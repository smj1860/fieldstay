import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { recordConsumptionFromCount } from '@/lib/inventory/record-consumption'

/**
 * PAR pass 2, learning loop: every submitted inventory count becomes a
 * consumption observation, and once a property has enough of them resolvePar()
 * stops using the smart-group formula for that item and uses what the property
 * actually goes through instead.
 *
 * A SEPARATE function on the same event as handleInventoryCountSubmitted,
 * rather than another step inside it. That handler owns the restock pipeline —
 * applying the count, finding below-par items, writing a purchase order,
 * emailing the PM. Learning is not part of that chain: it must not be able to
 * fail a restock, and a restock failure must not cost a sample. Two functions
 * on one event is Inngest's normal fan-out, and they touch disjoint tables.
 *
 * There is no ordering dependency between them, which is deliberate rather
 * than lucky: recordConsumptionFromCount reads the count SESSIONS
 * (inventory_count_items), never inventory_items.current_quantity, which the
 * sibling overwrites from this same event.
 *
 * The recompute is dispatched only when a sample actually landed. Firing it
 * unconditionally would queue a whole-property recompute for every count that
 * recorded nothing — which is most of them early on, before a property has a
 * second count to compare against.
 */
export const recordInventoryConsumption = inngest.createFunction(
  {
    id:      'record-inventory-consumption',
    name:    'Inventory — record consumption from a count',
    retries: 3,
    // Matches the sibling handler's cap on the same event, so a batch of counts
    // cannot open twice the connections one of them was sized for.
    concurrency: { limit: 5 },
  },
  { event: 'inventory/count-submitted' },
  async ({ event, step, logger }) => {
    const { count_id: countId, property_id: propertyId, org_id: orgId } = event.data

    const result = await step.run('record-consumption', async () => {
      const supabase = createServiceClient({ system: 'inngest:record-inventory-consumption' })
      return await recordConsumptionFromCount(supabase, { countId, propertyId, orgId })
    })

    if (result.recorded > 0) {
      // Top level, never inside the step.run above — nested step tooling only
      // WARNS, then unwinds the request and re-runs the enclosing callback from
      // the top, which here would record every sample a second time and skew
      // the mean. See CLAUDE.md's Inngest constraints.
      await step.sendEvent('recompute-after-consumption', {
        name: 'inventory/par-recompute-requested',
        data: { org_id: orgId, property_id: propertyId },
      })
    }

    logger.info(
      `[record-inventory-consumption] property=${propertyId} recorded=${result.recorded}` +
        (result.reason ? ` reason=${result.reason}` : '')
    )
    return result
  }
)
