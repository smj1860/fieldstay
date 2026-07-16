import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'

export const handleWorkOrderCrewCompleted = inngest.createFunction(
  { id: 'work-order-crew-completed', name: 'Work Order: Crew Marked Complete', retries: 2 },
  { event: 'work-order/crew.completed' },
  async ({ event, step }) => {
    const { workOrderId, orgId, crewMemberId, notes } = event.data

    const context = await step.run('fetch-context', async () => {
      const supabase = createServiceClient()
      const [woRes, crewRes] = await Promise.all([
        supabase
          .from('work_orders')
          .select('id, wo_number, title, property_id')
          .eq('id', workOrderId)
          .eq('org_id', orgId)
          .single(),
        supabase
          .from('crew_members')
          .select('id, name')
          .eq('id', crewMemberId)
          .eq('org_id', orgId)
          .single(),
      ])

      const { data: property } = await supabase
        .from('properties')
        .select('name, address')
        .eq('id', woRes.data?.property_id ?? '')
        .single()

      return { wo: woRes.data, crew: crewRes.data, property }
    })

    await step.run('notify-pm', async () => {
      const supabase = createServiceClient()
      const crewName = context.crew?.name ?? 'A crew member'
      const woTitle  = context.wo?.title ?? 'a work order'
      const propName = context.property?.name ?? 'the property'

      await createPmNotification(supabase, {
        orgId,
        type:      'work_order_complete',
        title:     `✓ Work Complete — ${context.wo?.wo_number ?? 'WO'} · ${propName}`,
        subtitle:  `${crewName} marked "${woTitle}" complete${notes ? ` — ${notes}` : ''}`,
        href:      `/maintenance/${workOrderId}`,
        severity:  'green',
        dedupeKey: `crew-wo-complete-${workOrderId}`,
      })
    })

    return { notified: true }
  }
)
