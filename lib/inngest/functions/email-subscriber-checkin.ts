import { inngest }           from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend }             from '@/lib/resend/client'

export const sendSubscriberCheckin = inngest.createFunction(
  {
    id:      'email-subscriber-checkin',
    name:    'Subscriber Check-in Email (Day 21)',
    retries: 2,
    concurrency: { key: 'event.data.org_id', limit: 1 },
  },
  { event: 'billing/first-payment-confirmed' },
  async ({ event, step }) => {
    const { user_email, first_name, org_id } = event.data
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!

    // Wait 21 days
    await step.sleep('sleep-21-days', '21 days')

    // Confirm they're still an active subscriber before sending
    const stillActive = await step.run('confirm-still-active', async () => {
      const supabase = createServiceClient()
      const { data: org } = await supabase
        .from('organizations')
        .select('plan_status')
        .eq('id', org_id)
        .single()
      return org?.plan_status === 'active'
    })

    if (!stillActive) return { skipped: true, reason: 'no-longer-active' }

    const propertyCount = await step.run('get-property-count', async () => {
      const supabase = createServiceClient()
      const { count } = await supabase
        .from('properties')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org_id)
        .eq('is_active', true)
      return count ?? 0
    })

    await step.run('send-checkin-email', async () => {
      const propertyLine = propertyCount > 0
        ? `I know managing ${propertyCount} ${propertyCount === 1 ? 'property' : 'properties'} keeps you constantly busy`
        : 'I know running your operation keeps you constantly busy'

      // Plain text — intentionally NOT a React Email template
      await resend.emails.send(
        {
          from:    'Stephen <stephen@fieldstay.app>',
          to:      user_email,
          subject: 'checking in',
          text: `Hi ${first_name},

You've been on FieldStay for a few weeks now and I wanted to reach out personally — how's it going?

${propertyLine}, but I'd love to ask you one thing.

If you could add one feature to FieldStay that would make your day-to-day easier, what would it be? First thing that comes to mind. One answer is all I need.

We're building fast and your feedback goes directly into what we prioritize next.

— Stephen

P.S. If you ever hit a snag or have a question, just reply here. I'm reachable.`,
        },
        { idempotencyKey: `subscriber-checkin-${org_id}` }
      )
    })
  }
)
