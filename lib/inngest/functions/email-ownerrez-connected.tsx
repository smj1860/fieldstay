import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'

export const sendOwnerRezConnectedEmail = inngest.createFunction(
  { id: 'email-ownerrez-connected', name: 'Notify OwnerRez Connected', retries: 3 },
  { event: 'integration/ownerrez.connected' },
  async ({ event, step }) => {
    const { org_id } = event.data

    await step.run('notify-pm', async () => {
      const supabase = createServiceClient({ system: 'inngest:email-ownerrez-connected' })
      await createPmNotification(supabase, {
        orgId:     org_id,
        type:      'integration_connected',
        title:     'OwnerRez connected',
        subtitle:  'Your properties are syncing now',
        href:      '/properties',
        severity:  'green',
        dedupeKey: `ownerrez-connected-${org_id}`,
      })
    })
  }
)
