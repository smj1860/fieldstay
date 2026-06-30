import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

const FALLBACK_TIMEZONE = 'America/New_York'

export const guidebookStayExtensionCron = inngest.createFunction(
  { id: 'guidebook-stay-extension-cron', name: 'Guidebook: Stay Extension Check' },
  { cron: '0 15 * * *' }, // ~11am ET daily
  async ({ step, logger }) => {
    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE })
      .format(new Date())

    // Fetch orgs with extension messaging enabled
    const configs = await step.run('fetch-extension-configs', async () => {
      const supabase = createServiceClient()
      const { data, error } = await supabase
        .from('guidebook_configurations')
        .select(`
          org_id, is_active,
          extension_messaging_enabled, extension_gap_threshold_days,
          extension_discount_pct, extension_contact_method,
          extension_ownerrez_url, extension_message_days_before
        `)
        .eq('is_active', true)
        .eq('extension_messaging_enabled', true)

      if (error) throw new Error(`Failed to fetch configs: ${error.message}`)
      return data ?? []
    })

    logger.info(`Checking ${configs.length} orgs for stay extension opportunities`)
    let dispatched = 0

    for (const config of configs) {
      const count = await step.run(`check-gaps-${config.org_id}`, async () => {
        const supabase = createServiceClient()
        // Find bookings checking out in `extension_message_days_before` days
        const targetCheckout = new Date(
          Date.now() + config.extension_message_days_before * 24 * 60 * 60 * 1000
        ).toISOString().split('T')[0]

        const { data: bookings } = await supabase
          .from('bookings')
          .select('id, org_id, property_id, checkout_date')
          .eq('org_id', config.org_id)
          .eq('checkout_date', targetCheckout)
          .eq('status', 'confirmed')
          .eq('is_block', false)

        let sent = 0

        for (const booking of bookings ?? []) {
          // Check if extension request already sent (idempotency via UNIQUE(booking_id))
          const { data: existing } = await supabase
            .from('stay_extension_requests')
            .select('id')
            .eq('booking_id', booking.id)
            .maybeSingle()

          if (existing) continue  // already handled

          // Find the NEXT booking at this property after checkout
          const { data: nextBooking } = await supabase
            .from('bookings')
            .select('id, checkin_date')
            .eq('property_id', booking.property_id)
            .eq('org_id', config.org_id)
            .gt('checkin_date', booking.checkout_date)
            .eq('status', 'confirmed')
            .order('checkin_date', { ascending: true })
            .limit(1)
            .maybeSingle()

          // Calculate gap
          const nextCheckin = nextBooking?.checkin_date
          if (!nextCheckin) continue  // no future booking = open calendar, don't offer

          const checkout = new Date(booking.checkout_date)
          const checkin  = new Date(nextCheckin)
          const gapDays  = Math.round(
            (checkin.getTime() - checkout.getTime()) / (1000 * 60 * 60 * 24)
          )

          if (gapDays < config.extension_gap_threshold_days) continue  // gap too small

          // Get guest SMS opt-in if available
          const { data: optin } = await supabase
            .from('guidebook_guest_sms_optins')
            .select('phone_e164, is_active')
            .eq('booking_id', booking.id)
            .maybeSingle()

          // Create the extension request record
          const { data: request } = await supabase
            .from('stay_extension_requests')
            .insert({
              org_id:               config.org_id,
              booking_id:           booking.id,
              property_id:          booking.property_id,
              gap_days:             gapDays,
              discount_pct:         config.extension_discount_pct,
              next_booking_checkin: nextCheckin,
              status:               'pending',
            })
            .select('id')
            .single()

          if (!request) continue

          // Fire event to handle notification + SMS
          await inngest.send({
            name: 'guidebook/stay.extension.request',
            data: {
              requestId:          request.id,
              orgId:              config.org_id,
              bookingId:          booking.id,
              propertyId:         booking.property_id,
              gapDays,
              discountPct:        config.extension_discount_pct ?? null,
              contactMethod:      (config.extension_contact_method ?? 'email') as 'ownerrez_url' | 'email' | 'sms',
              ownerRezUrl:        config.extension_ownerrez_url ?? null,
              guestPhoneE164:     (optin?.is_active ? optin.phone_e164 : null) ?? null,
              nextBookingCheckin: nextCheckin,
            },
          })

          sent += 1
        }

        return sent
      })

      dispatched += count
    }

    return { dispatched, date: todayDate }
  }
)
