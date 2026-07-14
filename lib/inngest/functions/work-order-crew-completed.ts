import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { getPmEmail }          from '@/lib/inngest/helpers'
import { resend, FROM }        from '@/lib/resend/client'
import { renderPmAlert }       from '@/lib/resend/emails/pm-alert'

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

    const pmEmail = await step.run('fetch-pm-email', async () => {
      const supabase = createServiceClient()
      return getPmEmail(supabase, orgId)
    })

    if (!pmEmail) return { skipped: 'no PM email' }

    await step.run('notify-pm', async () => {
      const crewName = context.crew?.name ?? 'A crew member'
      const woTitle  = context.wo?.title ?? 'a work order'
      const propName = context.property?.name ?? 'the property'

      const html = await renderPmAlert({
        heading:  `Work Complete — ${context.wo?.wo_number ?? 'WO'}`,
        body:     `${crewName} marked work order "${woTitle}" complete at ${propName}.`,
        details: [
          { label: 'Property',   value: propName },
          { label: 'Crew',       value: crewName },
          { label: 'Notes',      value: notes ?? undefined },
        ],
        ctaLabel: 'View Work Order →',
        ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance/${workOrderId}`,
      })

      const { error } = await resend.emails.send(
        {
          from:    FROM,
          to:      pmEmail,
          subject: `✓ Work Complete — ${context.wo?.wo_number ?? 'WO'} · ${propName}`,
          html,
        },
        { idempotencyKey: `crew-wo-complete-${workOrderId}` }
      )

      if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`)
    })

    return { notified: true }
  }
)
