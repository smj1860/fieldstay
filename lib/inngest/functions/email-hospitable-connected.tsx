// lib/inngest/functions/email-hospitable-connected.tsx

import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'

export const sendHospitableConnectedEmail = inngest.createFunction(
  { id: 'email-hospitable-connected', name: 'Notify Hospitable Connected', retries: 3 },
  { event: 'integration/hospitable.connected' as const },
  async ({ event, step }) => {
    const { org_id } = event.data

    await step.run('notify-pm', async () => {
      const supabase = createServiceClient()
      await createPmNotification(supabase, {
        orgId:     org_id,
        type:      'integration_connected',
        title:     'Hospitable connected',
        subtitle:  'Your properties are syncing now',
        href:      '/properties',
        severity:  'green',
        dedupeKey: `hospitable-connected-${org_id}`,
      })
    })
  }
)
