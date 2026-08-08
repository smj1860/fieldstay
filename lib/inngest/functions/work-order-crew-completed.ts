import { tryUnwrap, throwIfAnyQueryFailed, isRealQueryError } from '@/lib/supabase/unwrap'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { incrementCounter }    from '@/lib/observability/metrics'

export const handleWorkOrderCrewCompleted = inngest.createFunction(
  { id: 'work-order-crew-completed', name: 'Work Order: Crew Marked Complete', retries: 2 },
  { event: 'work-order/crew.completed' },
  async ({ event, step }) => {
    const { workOrderId, orgId, crewMemberId, notes } = event.data

    await step.run('emit-completion-metric', async () => {
      await incrementCounter('fieldstay_work_orders_completed_by_crew_total', { org_id: orgId })
    })

    const context = await step.run('fetch-context', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-crew-completed' })
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

      // Neither of the two .single() reads above checked its error, so an RLS
      // regression or a timeout was indistinguishable from PGRST116 ("no such
      // row") — both leave `data` null. The notify step below fills every
      // field from that null with a fallback, so a failed read shipped the PM
      // a content-free notification ("✓ Work Complete — WO · the property",
      // "A crew member marked \"a work order\" complete") instead of retrying.
      // PGRST116 stays a legitimate not-found; anything else throws.
      throwIfAnyQueryFailed(
        { site: 'inngest.work-order-crew-completed.fetch-context', orgId },
        isRealQueryError(woRes.error) ? woRes.error : null,
        isRealQueryError(crewRes.error) ? crewRes.error : null,
      )

      // Guarded rather than `.eq('id', woRes.data?.property_id ?? '')`: an
      // empty string is not a uuid, so that query failed with 22P02 and
      // reported a spurious parse error to Sentry in place of the real cause.
      // Degrade, don't throw: the caller already falls back to 'the property'.
      // tryUnwrap still logs and reports so a genuine failure isn't invisible.
      let property: { name: string; address: string | null } | null = null
      if (woRes.data?.property_id) {
        const propertyRes = await supabase
          .from('properties')
          .select('name, address')
          .eq('id', woRes.data.property_id)
          .eq('org_id', orgId)
          .maybeSingle()

        const propertyOut = tryUnwrap(propertyRes, {
          site: 'inngest.work-order-crew-completed.property', orgId,
        })
        property = propertyOut.ok ? propertyOut.data : null
      }

      return { wo: woRes.data, crew: crewRes.data, property }
    })

    await step.run('notify-pm', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-crew-completed' })
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
