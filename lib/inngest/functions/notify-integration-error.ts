import { inngest }               from '@/lib/inngest/client'
import { createServiceClient }   from '@/lib/supabase/server'
import { createPmNotification }  from '@/lib/inngest/helpers'

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  ownerrez:   'OwnerRez',
  kroger:     'Kroger',
  hostaway:   'Hostaway',
  hospitable: 'Hospitable',
  ical:       'iCal',
}

export const notifyIntegrationError = inngest.createFunction(
  { id: 'notify-integration-error', name: 'Notify PM: Integration Connection Error', retries: 2 },
  { event: 'integration/connection.error' as const },
  async ({ event, step }) => {
    const { org_id, provider_id, reason } = event.data

    await step.run('create-notification', async () => {
      const supabase     = createServiceClient()
      const providerName = PROVIDER_DISPLAY_NAMES[provider_id] ?? provider_id
      const today         = new Date().toISOString().split('T')[0]

      await createPmNotification(supabase, {
        orgId:     org_id,
        type:      'integration_connection_error',
        title:     `${providerName} connection needs attention`,
        subtitle:  reason,
        href:      '/settings/integrations',
        severity:  'red',
        dedupeKey: `integration-error-${org_id}-${provider_id}-${today}`,
      })
    })

    return { notified: true, org_id, provider_id }
  }
)
