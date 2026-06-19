import { inngest }                from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { resend, FROM }          from '@/lib/resend/client'
import { getPmEmailsByOrgIds }   from '@/lib/inngest/helpers'
import { renderPmAlert }         from '@/lib/resend/emails/pm-alert'

const STALE_HOURS = 6

type StaleRow = {
  id:             string
  name:           string
  org_id:         string
  last_synced_at: string | null
  properties:     { name: string } | { name: string }[] | null
}

function propertyName(row: StaleRow): string {
  if (Array.isArray(row.properties)) return row.properties[0]?.name ?? 'Unknown property'
  return row.properties?.name ?? 'Unknown property'
}

/**
 * SCHEDULED: 3pm UTC daily.
 *
 * Finds all active iCal feeds that haven't successfully synced
 * in the past 6 hours (or have never synced), groups them by org,
 * and sends one alert email per org. Idempotency prevents duplicate
 * emails if the step is retried.
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

      const { data } = await supabase
        .from('ical_feeds')
        .select('id, name, org_id, last_synced_at, properties ( name )')
        .eq('is_active', true)
        .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff.toISOString()}`)

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
      const existing = byOrg.get(feed.org_id) ?? []
      existing.push(feed)
      byOrg.set(feed.org_id, existing)
    }

    const today  = new Date().toISOString().split('T')[0]
    const orgIds = [...byOrg.keys()]

    await step.run('send-stale-alerts', async () => {
      const supabase    = createServiceClient()
      const emailsByOrg = await getPmEmailsByOrgIds(supabase, orgIds)

      for (const [orgId, feeds] of byOrg) {
        const pmEmail = emailsByOrg.get(orgId)
        if (!pmEmail) continue

        await resend.emails.send(
          {
            from:    FROM,
            to:      pmEmail,
            subject: `⚠️ ${feeds.length} iCal feed${feeds.length !== 1 ? 's' : ''} haven't synced in ${STALE_HOURS}+ hours`,
            html: await renderPmAlert({
              heading: 'iCal feeds are stale',
              body:    `The following feed${feeds.length !== 1 ? 's' : ''} haven't synced in over ${STALE_HOURS} hours. Your booking calendar may be out of date.`,
              table: {
                headers: ['Feed Name', 'Property', 'Last Synced'],
                rows: feeds.map(f => [
                  f.name,
                  propertyName(f),
                  f.last_synced_at
                    ? new Date(f.last_synced_at).toLocaleString('en-US', {
                        month:  'short',
                        day:    'numeric',
                        hour:   'numeric',
                        minute: '2-digit',
                      })
                    : 'Never',
                ]),
              },
              ctaLabel: 'View Integrations →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/settings/integrations`,
            }),
          },
          { idempotencyKey: `stale-feed-alert-${orgId}-${today}` }
        )
      }
    })

    return { alerted: byOrg.size }
  }
)
