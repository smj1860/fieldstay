import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

export const flaggedTurnoverToWO = inngest.createFunction(
  {
    id:      'flagged-turnover-to-work-order',
    name:    'Create Draft WO from Flagged Turnover',
    retries: 2,
  },
  { event: 'turnover/flagged' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, flag_notes } = event.data

    const workOrder = await step.run('create-draft-wo', async () => {
      const supabase = createServiceClient()

      // Idempotency: return existing WO if this step is retried
      const { data: existing } = await supabase
        .from('work_orders')
        .select('id, wo_number')
        .eq('source_turnover_id', turnover_id)
        .eq('source', 'crew_flag')
        .maybeSingle()

      if (existing) return existing

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
          source_turnover_id: turnover_id,
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

    const managers = await step.run('load-managers', async () => {
      const supabase = createServiceClient()

      const { data } = await supabase
        .from('organization_members')
        .select('user_id')
        .eq('org_id', org_id)
        .in('role', ['admin', 'owner', 'manager'])

      return data ?? []
    })

    for (const mgr of managers) {
      if (!mgr.user_id) continue

      await step.run(`notify-manager-${mgr.user_id}`, async () => {
        const supabase = createServiceClient()

        const { data: subs } = await supabase
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth')
          .eq('user_id', mgr.user_id)

        if (!subs?.length) return

        const { sendPushToCrewMember } = await import('@/lib/push/client')
        await sendPushToCrewMember(subs, {
          title: 'Flagged Issue → Draft WO Created',
          body:  flag_notes.slice(0, 80),
          url:   '/maintenance',
        }).catch(() => { /* silently skip failed pushes */ })
      })
    }

    return { work_order_id: workOrder.id, wo_number: workOrder.wo_number }
  }
)
