import { inngest }                from '@/lib/inngest/client'
import { createServiceClient }    from '@/lib/supabase/server'
import { fetchAllRows }           from '@/lib/inngest/paginate'
import { getPmMembersByOrgIds }   from '@/lib/inngest/helpers'

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
    // Paginated — an unbounded select here is silently capped at PostgREST's
    // 1000-row limit, so past ~1000 stale feeds every org sorted later simply
    // stopped being alerted, with no error anywhere.
    const staleFeeds = await step.run('find-stale-feeds', async () => {
      const supabase = createServiceClient({ system: 'inngest:stale-feed-alert' })
      const cutoff   = new Date()
      cutoff.setHours(cutoff.getHours() - STALE_HOURS)

      return fetchAllRows<StaleRow>(
        (from, to) => supabase
          .from('ical_feeds')
          .select('id, name, org_id, last_synced_at, properties ( name )')
          .eq('is_active', true)
          .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff.toISOString()}`)
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'ical_feeds(stale)' }
      )
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

    // One PM user id per org, resolved in ONE batched call for every org.
    //
    // This used to open-code the membership query here: `.in('role', ['owner',
    // 'admin'])` + `.not('invite_accepted_at', 'is', null)` + a local
    // owner-before-admin sort. That is exactly getPmMembersByOrgIds()'s
    // contract re-derived by hand, and re-deriving it is how the
    // invite_accepted_at filter has drifted into a live lockout bug three
    // times. The helper is the single source of truth (CLAUDE.md) and is
    // already the batched, many-orgs-one-query form — `limit: 1` reproduces
    // the "first owner, else first admin" selection this loop was making.
    const pmUserIdByOrg = await step.run('resolve-pm-members', async () => {
      const supabase = createServiceClient({ system: 'inngest:stale-feed-alert' })

      const pmByOrg = await getPmMembersByOrgIds(supabase, [...byOrg.keys()], {
        roles: ['owner', 'admin'],
        limit: 1,
      })

      const result: Record<string, string> = {}
      for (const [orgId, members] of pmByOrg) {
        const primary = members[0]
        if (primary) result[orgId] = primary.userId
      }
      return result
    })

    // ONE batched sendEvent instead of one step per org. The per-org step
    // version put the whole platform's org count into a single run's step
    // budget (and re-sent accumulated memoized state on every one of them);
    // Inngest accepts an event array in a single step, and the downstream
    // notify-integration-error function still runs once per event.
    const events = [...byOrg.entries()].flatMap(([orgId, feeds]) => {
      const userId = pmUserIdByOrg[orgId]
      if (!userId) return []

      const feedCount = feeds.length
      const feedWord  = feedCount !== 1 ? 'feeds' : 'feed'

      return [{
        name: 'integration/connection.error' as const,
        data: {
          user_id:     userId,
          org_id:      orgId,
          provider_id: 'ical',
          reason:      `${feedCount} ${feedWord} haven't synced in ${STALE_HOURS}+ hours`,
        },
      }]
    })

    if (events.length) {
      await step.sendEvent('notify-stale-feeds', events)
    }

    return { alerted: events.length }
  }
)
