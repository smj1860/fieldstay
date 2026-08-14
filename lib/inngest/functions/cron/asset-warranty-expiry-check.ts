/**
 * Warranty Watchdog — daily: alerts the PM before an asset's warranty
 * expires, instead of leaving it to be discovered the day a claim gets
 * denied. warranty_expiry_date/warranty_provider have always been stored on
 * property_assets; nothing ever read them for alerting until now.
 *
 * Platform-wide, not fanned out per org — same shape as
 * vendor-compliance-expiry-check.ts, whose first_warned_at "warn once" gate
 * is exactly what warranty_warned_at mirrors here (see the migration
 * comment on that column). Claim + notify happen as ONE round trip each
 * across the whole run's batch, not one query per asset — see
 * createPmNotifications.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapList }          from '@/lib/supabase/unwrap'
import { createPmNotifications, type CreatePmNotificationInput } from '@/lib/inngest/helpers'

const EXPIRING_SOON_WINDOW_DAYS = 30

/**
 * Per-run ceiling, same reasoning as vendor-compliance-expiry-check.ts:
 * un-warned assets stay un-warned (warranty_warned_at IS NULL keeps
 * selecting them) and are picked up by tomorrow's run, ordered soonest-
 * expiring-first so a backlog never delays the most urgent warnings.
 */
const MAX_PER_RUN = 200

export const assetWarrantyExpiryCheck = inngest.createFunction(
  {
    id:      'cron-asset-warranty-expiry-check',
    name:    'Cron: Asset Warranty Expiry Warning',
    retries: 2,
  },
  { cron: '0 12 * * *' },  // staggered off asset-health's 12:30 and vendor-compliance's 11:00
  async ({ step, logger }) => {
    const warned = await step.run('find-and-warn-expiring-warranties', async () => {
      const supabase   = createServiceClient({ system: 'inngest:asset-warranty-expiry-check' })
      const todayStr   = new Date().toISOString().split('T')[0]!
      const windowEnd  = new Date(Date.now() + EXPIRING_SOON_WINDOW_DAYS * 86_400_000)
        .toISOString().split('T')[0]!

      const res = await supabase
        .from('property_assets')
        .select('id, org_id, name, warranty_expiry_date, warranty_provider')
        .eq('is_active', true)
        .is('warranty_warned_at', null)
        .not('warranty_expiry_date', 'is', null)
        .gte('warranty_expiry_date', todayStr)
        .lte('warranty_expiry_date', windowEnd)
        .order('warranty_expiry_date', { ascending: true })
        .limit(MAX_PER_RUN)

      const assets = unwrapList(res, { site: 'inngest.asset-warranty-expiry-check.find' })
        // The query already guarantees this, but a runtime check here
        // (rather than a non-null assertion) is what lets the days-until
        // computation below stay honest about what it depends on.
        .filter((a): a is typeof a & { warranty_expiry_date: string } => a.warranty_expiry_date !== null)

      if (!assets.length) return []

      // Claims every found asset in one round trip — a retry of this step
      // claims nothing the first run already claimed, without a query per
      // asset.
      const claimRes = await supabase
        .from('property_assets')
        .update({ warranty_warned_at: new Date().toISOString() })
        .in('id', assets.map((a) => a.id))
        .is('warranty_warned_at', null)
        .select('id')

      const claimedIds    = new Set((claimRes.data ?? []).map((r: { id: string }) => r.id))
      const claimedAssets = assets.filter((a) => claimedIds.has(a.id))

      const notifications: CreatePmNotificationInput[] = claimedAssets.map((asset) => {
        const daysUntil = Math.round(
          (new Date(asset.warranty_expiry_date).getTime() - Date.now()) / 86_400_000
        )
        return {
          orgId:     asset.org_id,
          type:      'asset_warranty_expiry',
          title:     `${asset.name} warranty expires in ${daysUntil} day${daysUntil === 1 ? '' : 's'}`,
          subtitle:  asset.warranty_provider ?? 'Warranty expiring soon',
          href:      '/assets',
          severity:  'amber',
          dedupeKey: `asset-warranty-expiry-${asset.id}`,
        }
      })

      await createPmNotifications(supabase, notifications)
      return claimedAssets
    })

    if (warned.length === MAX_PER_RUN) {
      logger.warn(
        `[asset-warranty-expiry] hit the ${MAX_PER_RUN}/run cap — remaining assets stay ` +
        `un-warned (warranty_warned_at IS NULL) and will be picked up by tomorrow's run.`
      )
    }

    logger.info(`Warranty watchdog: warned on ${warned.length} asset(s)`)
    return { warned: warned.length }
  }
)
