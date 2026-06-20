import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getClientToken, findNearestKrogerStore } from '@/lib/kroger/client'

export type KrogerConnectedEvent = {
  name: 'integration/kroger.connected'
  data: { org_id: string; user_id: string }
}

/**
 * Runs once, right after a PM completes Kroger OAuth. Picks the nearest
 * Kroger location using the org's first active property with a zip code,
 * stores it on the connection, and flips preferred_retailer to 'kroger' —
 * the column otherwise defaults to 'walmart' (a placeholder; no Walmart
 * integration exists) and nothing else ever sets it. Without this, the
 * cart-build pipeline silently no-ops at its very first gate for every org.
 */
export const setupKrogerOnConnect = inngest.createFunction(
  { id: 'kroger-setup-on-connect', name: 'Kroger: Auto-configure store on connect', retries: 2 },
  { event: 'integration/kroger.connected' as const },
  async ({ event, step, logger }) => {
    const { org_id } = event.data

    const result = await step.run('find-and-store-nearest-location', async () => {
      const supabase = createServiceClient()

      const { data: property } = await supabase
        .from('properties')
        .select('zip')
        .eq('org_id', org_id)
        .eq('is_active', true)
        .not('zip', 'is', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      if (!property?.zip) {
        await supabase.from('org_milestones').upsert(
          { org_id, milestone: 'kroger_store_needed' },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
        return { found: false, reason: 'no_property_zip' }
      }

      const clientToken = await getClientToken()
      const store = await findNearestKrogerStore(property.zip, clientToken)

      if (!store) {
        await supabase.from('org_milestones').upsert(
          { org_id, milestone: 'kroger_store_needed' },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
        return { found: false, reason: 'no_store_in_range' }
      }

      const { data: connection } = await supabase
        .from('integration_connections')
        .select('metadata')
        .eq('org_id', org_id)
        .eq('provider_id', 'kroger')
        .single()

      await supabase
        .from('integration_connections')
        .update({
          metadata: {
            ...(connection?.metadata as Record<string, unknown> ?? {}),
            location_id:   store.locationId,
            location_name: store.name,
          },
        })
        .eq('org_id', org_id)
        .eq('provider_id', 'kroger')

      await supabase
        .from('organizations')
        .update({ preferred_retailer: 'kroger' })
        .eq('id', org_id)

      // Clear a stale flag from a prior failed connect attempt, if any
      await supabase.from('org_milestones')
        .delete()
        .eq('org_id', org_id)
        .eq('milestone', 'kroger_store_needed')

      return { found: true, locationName: store.name }
    })

    logger.info(
      `Kroger setup for org ${org_id}: ${
        result.found ? `connected to ${result.locationName}` : `no store configured (${result.reason})`
      }`
    )
    return result
  }
)
