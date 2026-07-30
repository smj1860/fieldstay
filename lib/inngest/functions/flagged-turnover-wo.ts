import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { getPmMembers }        from '@/lib/inngest/helpers'
import { reportError }         from '@/lib/observability/report-error'

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
      const supabase = createServiceClient({ system: 'inngest:flagged-turnover-wo' })

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
        .eq('org_id', org_id)
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

      await logAuditEvent({
        orgId:      org_id,
        action:     'work_order.created',
        targetType: 'work_order',
        targetId:   wo.id,
        metadata:   { source: 'crew_flag', turnover_id },
      })

      return wo
    })

    // getPmMembers is the single source of truth for "who is a PM" — it
    // applies the invite_accepted_at filter this step used to omit (a member
    // with a pending invite is not yet a real recipient) and the owner →
    // admin → manager ordering.
    const managers = await step.run('load-managers', async () => {
      const supabase = createServiceClient({ system: 'inngest:flagged-turnover-wo' })
      return getPmMembers(supabase, org_id, { roles: ['owner', 'admin', 'manager'] })
    })

    for (const mgr of managers) {
      await step.run(`notify-manager-${mgr.userId}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:flagged-turnover-wo' })

        const { data: subs } = await supabase
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth')
          .eq('user_id', mgr.userId)

        if (!subs?.length) return

        const { sendPushToCrewMember } = await import('@/lib/push/client')
        try {
          await sendPushToCrewMember(subs, {
            title: 'Flagged Issue → Draft WO Created',
            body:  flag_notes.slice(0, 80),
            url:   '/maintenance',
          })
        } catch (err) {
          // Non-fatal — a failed push must not fail the step and re-create
          // the work order — but never silent: a push backend that has been
          // rejecting every send is otherwise invisible.
          console.error('[flagged-turnover-wo] push notification failed', {
            orgId:            org_id,
            turnoverId:       turnover_id,
            subscriptionCount: subs.length,
            error:            err instanceof Error ? err.message : String(err),
          })
          reportError(err, {
            site:  'inngest.flagged-turnover-wo.notify-manager',
            orgId: org_id,
          })
        }
      })
    }

    return { work_order_id: workOrder.id, wo_number: workOrder.wo_number }
  }
)
