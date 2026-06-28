import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const handleWorkOrderCrewAssigned = inngest.createFunction(
  { id: 'work-order-crew-assigned', name: 'Work Order: Crew Assigned', retries: 2 },
  { event: 'work-order/crew.assigned' },
  async ({ event, step }) => {
    const { workOrderId, crewMemberId } = event.data
    const supabase = createServiceClient()

    // Future: send push notification to crew member's device.
    // For now, the WO surfaces in the crew app via the Dexie sync.
    // The crew member will see it on next app open or sync.
    // This handler is scaffolded for the push notification integration.

    await step.run('log-assignment', async () => {
      const { data: wo } = await supabase
        .from('work_orders')
        .select('wo_number, title')
        .eq('id', workOrderId)
        .single()

      return { workOrderId, woNumber: wo?.wo_number, crewMemberId }
    })

    return { notified: false, reason: 'push_notifications_pending_10dlc' }
  }
)
