import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { getPmMembers }        from '@/lib/inngest/helpers'
import { reportError }         from '@/lib/observability/report-error'
import { unwrap }              from '@/lib/supabase/unwrap'
import { fetchAllRows }        from '@/lib/inngest/paginate'

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
      // This read is the step's idempotency guard, and Inngest retries steps.
      // Discarded, a failed read looked like "no work order yet", so the
      // insert below ran and hit wo_crew_flag_source_unique — surfacing as
      // "WO creation failed: duplicate key" on every retry until they
      // exhausted. No duplicate was ever created (the partial unique index on
      // source_turnover_id WHERE source='crew_flag' is what guarantees that),
      // but the reported cause was the collision rather than the read that
      // caused it.
      const existingRes = await supabase
        .from('work_orders')
        .select('id, wo_number')
        .eq('org_id', org_id)
        .eq('source_turnover_id', turnover_id)
        .eq('source', 'crew_flag')
        .maybeSingle()

      const existing = unwrap(existingRes, {
        site: 'inngest.flagged-turnover-wo.idempotency-check', orgId: org_id,
      })

      if (existing) return existing

      const propertyRes = await supabase
        .from('properties')
        .select('name')
        .eq('id', property_id)
        .eq('org_id', org_id)
        .single()

      // Reported, not thrown: the 'Property' fallback is a genuinely
      // acceptable title, and failing the whole work-order creation over a
      // display name would be the wrong trade. But a title silently
      // degrading to the generic word is worth knowing about.
      if (propertyRes.error) {
        console.error('[flagged-turnover-wo] property name lookup failed', propertyRes.error.message)
        reportError(propertyRes.error, {
          site: 'inngest.flagged-turnover-wo.property-name', orgId: org_id,
        })
      }

      const propName = propertyRes.data?.name ?? 'Property'

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

        // Org-scoped as well as user-scoped: push_subscriptions carries
        // org_id, and a manager who belongs to more than one org would
        // otherwise get every org's devices for a notification about this
        // org's flagged turnover.
        //
        // Paged rather than .limit()'d because the failure mode of a cap here
        // is silently skipping one of the manager's devices — a handful of
        // rows in practice, so this costs one request and removes the
        // question.
        //
        // Thrown rather than reported, unlike the read this replaces: the
        // push send below already has its own try/catch for delivery
        // failures, so a LOOKUP failure reaching here is a different thing
        // and shouldn't share that path. Discarded, "this manager has no
        // device registered" and "the query failed" were the same return.
        const subs = await fetchAllRows<{ endpoint: string; p256dh: string; auth: string }>(
          (from, to) => supabase
            .from('push_subscriptions')
            .select('endpoint, p256dh, auth')
            .eq('user_id', mgr.userId)
            .eq('org_id', org_id)
            .order('endpoint', { ascending: true })
            .range(from, to),
          { label: `push_subscriptions[user=${mgr.userId}]` },
        )

        if (!subs.length) return

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
