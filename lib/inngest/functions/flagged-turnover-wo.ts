import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const flaggedTurnoverToWO = inngest.createFunction(
  {
    id:   'flagged-turnover-to-work-order',
    name: 'Create Draft WO from Flagged Turnover',
  },
  { event: 'turnover/flagged' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, flag_notes } = event.data

    const workOrder = await step.run('create-draft-wo', async () => {
      const supabase = createServiceClient()

      const { data: property } = await supabase
        .from('properties')
        .select('name')
        .eq('id', property_id)
        .single()

      const propName = property?.name ?? 'Property'

      const { data: wo, error } = await supabase
        .from('work_orders')
        .insert({
          org_id,
          property_id,
          title:       `Issue Flagged During Turnover — ${propName}`,
          description: flag_notes,
          priority:    'high',
          status:      'pending',
          source:      'crew_flag',
        })
        .select('id, wo_number')
        .single()

      if (error) throw new Error(`WO creation failed: ${error.message}`)
      return wo
    })

    await step.run('notify-managers', async () => {
      const supabase = createServiceClient()

      const { data: managers } = await supabase
        .from('organization_members')
        .select('user_id')
        .eq('org_id', org_id)
        .in('role', ['admin', 'owner', 'manager'])

      if (!managers?.length) return

      const { sendPushToCrewMember } = await import('@/lib/push/client')

      for (const mgr of managers) {
        if (!mgr.user_id) continue
        const { data: subs } = await supabase
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth')
          .eq('crew_member_id', mgr.user_id)

        if (subs?.length) {
          await sendPushToCrewMember(subs, {
            title: 'Flagged Issue → Draft WO Created',
            body:  flag_notes.slice(0, 80),
            url:   '/maintenance',
          }).catch(() => { /* silently skip failed pushes */ })
        }
      }
    })

    return { work_order_id: workOrder.id, wo_number: workOrder.wo_number }
  }
)
