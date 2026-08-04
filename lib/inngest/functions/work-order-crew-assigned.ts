import { tryUnwrap } from '@/lib/supabase/unwrap'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const handleWorkOrderCrewAssigned = inngest.createFunction(
  { id: 'work-order-crew-assigned', name: 'Work Order: Crew Assigned', retries: 2 },
  { event: 'work-order/crew.assigned' },
  async ({ event, step }) => {
    const { workOrderId, orgId, crewMemberId } = event.data

    // Future: send push notification to crew member's device.
    // For now, the WO surfaces in the crew app via the Dexie sync.
    // The crew member will see it on next app open or sync.
    // This handler is scaffolded for the push notification integration.

    await step.run('log-assignment', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-crew-assigned' })
      // Degrade, don't throw: this lookup only decorates the step's return
      // value for logging. tryUnwrap still logs and reports the failure.
      const woRes = await supabase
        .from('work_orders')
        .select('wo_number, title')
        .eq('id', workOrderId)
        .eq('org_id', orgId)
        .maybeSingle()

      const woOut = tryUnwrap(woRes, { site: 'inngest.work-order-crew-assigned.log', orgId })
      const wo    = woOut.ok ? woOut.data : null

      return { workOrderId, woNumber: wo?.wo_number, crewMemberId }
    })

    return { notified: false, reason: 'push_notifications_pending_10dlc' }
  }
)
