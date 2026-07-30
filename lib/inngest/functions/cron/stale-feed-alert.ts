import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { fetchAllRows }         from '@/lib/inngest/paginate'

const STALE_HOURS = 6

// Same preference order getPmMembers() applies — owner before admin.
const ROLE_PREFERENCE = ['owner', 'admin'] as const

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

    // One PM user id per org, resolved in ONE query for every org at once.
    //
    // This used to call getPmMembers() once per org inside a single step. That
    // helper does a DB query PLUS one auth.admin.getUserById() GoTrue
    // round-trip per member — ~300 sequential external calls at 150 orgs,
    // inside one step, near GoTrue's admin rate limits. None of that work was
    // needed: the only field consumed below is userId, so the email lookup
    // (the entire reason getPmMembers touches GoTrue) was pure waste here.
    const pmUserIdByOrg = await step.run('resolve-pm-members', async () => {
      const supabase = createServiceClient({ system: 'inngest:stale-feed-alert' })
      const orgIds = [...byOrg.keys()]

      const members = await fetchAllRows<{ org_id: string; user_id: string; role: string }>(
        (from, to) => supabase
          .from('organization_members')
          .select('org_id, user_id, role')
          .in('org_id', orgIds)
          .in('role', ROLE_PREFERENCE as unknown as string[])
          .not('invite_accepted_at', 'is', null)
          .order('user_id', { ascending: true })
          .range(from, to),
        { label: 'organization_members(pm-for-stale-feeds)' }
      )

      // Sort owner-before-admin once, then the first row seen per org wins —
      // same "primary PM" selection getPmMembers({ limit: 1 }) makes.
      const rank = (role: string) => {
        const i = ROLE_PREFERENCE.indexOf(role as typeof ROLE_PREFERENCE[number])
        return i === -1 ? ROLE_PREFERENCE.length : i
      }
      const result: Record<string, string> = {}
      for (const member of [...members].sort((a, b) => rank(a.role) - rank(b.role))) {
        result[member.org_id] ??= member.user_id
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
