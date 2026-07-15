import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { getPmMembers }         from '@/lib/inngest/helpers'

const STALE_HOURS = 6

type StaleRow = {
  id:             string
  name:           string
  org_id:         string
  last_synced_at: string | null
  properties:     { name: string } | { name: string }[] | null
}

/**
 * SCHEDULED: 3pm UTC daily.
 *
 * Finds all active iCal feeds that haven't synced in the past 6 hours (or
 * have never synced), groups by org, and fires one 'integration/connection.error'
 * event per org — the same event notify-integration-error.ts listens for on a
 * real OAuth connection failure, so staleness reads as one alert category to
 * the PM instead of its own separately-branded email.
 */
export const staleFeedAlert = inngest.createFunction(
  {
    id:      'cron-stale-feed-alert',
    name:    'Cron: Stale iCal Feed Alert',
    retries: 2,
  },
  { cron: '0 15 * * *' },
  async ({ step, logger }) => {
    const staleFeeds = await step.run('find-stale-feeds', async () => {
      const supabase = createServiceClient()
      const cutoff   = new Date()
      cutoff.setHours(cutoff.getHours() - STALE_HOURS)

      const { data, error } = await supabase
        .from('ical_feeds')
        .select('id, name, org_id, last_synced_at, properties ( name )')
        .eq('is_active', true)
        .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff.toISOString()}`)

      if (error) {
        throw new Error(`Failed to query stale iCal feeds: ${error.message}`)
      }

      return (data ?? []) as StaleRow[]
    })

    if (staleFeeds.length === 0) {
      logger.info('No stale iCal feeds found')
      return { alerted: 0 }
    }

    logger.info(`Found ${staleFeeds.length} stale iCal feed(s)`)

    // Group by org
    const byOrg = new Map<string, StaleRow[]>()
    for (const feed of staleFeeds) {
      const group = byOrg.get(feed.org_id) ?? []
      group.push(feed)
      byOrg.set(feed.org_id, group)
    }

    // One PM per org, resolved up front — step.sendEvent must run at the
    // top level of the function, not nested inside another step's callback.
    const pmUserIdByOrg = await step.run('resolve-pm-members', async () => {
      const supabase = createServiceClient()
      const result: Record<string, string> = {}
      for (const orgId of byOrg.keys()) {
        const [pmMember] = await getPmMembers(supabase, orgId, { limit: 1 })
        if (pmMember) result[orgId] = pmMember.userId
      }
      return result
    })

    let alerted = 0
    for (const [orgId, feeds] of byOrg) {
      const userId = pmUserIdByOrg[orgId]
      if (!userId) continue

      const feedCount = feeds.length
      const feedWord  = feedCount !== 1 ? 'feeds' : 'feed'

      await step.sendEvent(`notify-stale-feed-${orgId}`, {
        name: 'integration/connection.error',
        data: {
          user_id:     userId,
          org_id:      orgId,
          provider_id: 'ical',
          reason:      `${feedCount} ${feedWord} haven't synced in ${STALE_HOURS}+ hours`,
        },
      })
      alerted++
    }

    return { alerted }
  }
)
