import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendGuestPreArrivalEmail } from '@/lib/resend/client'

// Known tech debt: properties.timezone does not exist in the live schema.
// "Tomorrow" is computed in America/New_York as a fixed approximation until
// a timezone cache column is reintroduced.
const FALLBACK_TIMEZONE = 'America/New_York'

export const guidebookPreArrivalEmailCron = inngest.createFunction(
  { id: 'guidebook-pre-arrival-email-cron', name: 'Guidebook: Pre-Arrival Email Cron' },
  { cron: '0 14 * * *' }, // 10am America/New_York (fixed approximation, see FALLBACK_TIMEZONE)
  async ({ step }) => {
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE })
      .format(new Date(Date.now() + 24 * 60 * 60 * 1000))

    // Issue 2 fix: bookings and guidebook_configurations have no direct FK,
    // so PostgREST cannot resolve an embedded join between them. Fetch
    // tomorrow's bookings first, then separately check which orgs have an
    // active guidebook, and filter in JavaScript.
    const bookings = await step.run('fetch-tomorrow-bookings', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('bookings')
        .select('id, org_id, property_id, guest_email, guest_name, checkin_date, guidebook_token, status')
        .eq('checkin_date', tomorrow)
        .eq('status', 'confirmed')
        .eq('is_block', false)
        .not('guest_email', 'is', null)
        .not('guidebook_token', 'is', null)
        .is('guidebook_pre_arrival_email_sent_at', null)

      if (error) throw new Error(`Failed to fetch bookings: ${error.message}`)
      return data ?? []
    })

    if (bookings.length === 0) return { sent: 0 }

    const activeOrgIds = await step.run('fetch-active-guidebook-orgs', async () => {
      const supabase = createServiceClient()
      const uniqueOrgIds = Array.from(new Set(bookings.map((b) => b.org_id)))

      const { data, error } = await supabase
        .from('guidebook_configurations')
        .select('org_id')
        .in('org_id', uniqueOrgIds)
        .eq('is_active', true)

      if (error) throw new Error(`Failed to fetch guidebook configs: ${error.message}`)
      return (data ?? []).map((c): string => c.org_id)
    })

    const activeOrgIdSet = new Set<string>(activeOrgIds)
    const eligibleBookings = bookings.filter((b) => activeOrgIdSet.has(b.org_id))

    const propertyMap = await step.run('batch-fetch-properties', async () => {
      const supabase = createServiceClient()
      const uniquePropertyIds = [...new Set(eligibleBookings.map((b) => b.property_id))]

      const { data, error } = await supabase
        .from('properties')
        .select('id, name')
        .in('id', uniquePropertyIds)

      if (error) throw new Error(`Failed to batch fetch properties: ${error.message}`)

      return Object.fromEntries((data ?? []).map((p) => [p.id, p.name]))
    })

    let sentCount = 0

    for (const booking of eligibleBookings) {
      const wasSent = await step.run(`send-pre-arrival-email-${booking.id}`, async () => {
        const supabase = createServiceClient()
        const propertyName = propertyMap[booking.property_id]
        if (!propertyName || !booking.guest_email) return false

        const appUrl       = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
        const optInUrl     = `${appUrl}/g/b/${booking.guidebook_token}/opt-in`
        const guidebookUrl = `${appUrl}/g/b/${booking.guidebook_token}`

        await sendGuestPreArrivalEmail({
          toEmail:      booking.guest_email,
          guestName:    booking.guest_name ?? 'there',
          propertyName,
          optInUrl,
          guidebookUrl,
        })

        await supabase
          .from('bookings')
          .update({ guidebook_pre_arrival_email_sent_at: new Date().toISOString() })
          .eq('id', booking.id)

        return true
      })

      if (wasSent) sentCount += 1
    }

    return { sent: sentCount, eligible: eligibleBookings.length }
  }
)
