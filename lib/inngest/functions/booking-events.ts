import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM, renderTemplate } from '@/lib/resend/client'
import { getPmEmail } from '@/lib/inngest/helpers'

// ── Booking Confirmed (OwnerRez / Uplisting) ─────────────────────────────────

export const handleBookingConfirmed = inngest.createFunction(
  { id: 'booking-confirmed', name: 'Booking Confirmed — Post Revenue', retries: 3 },
  { event: 'booking/confirmed' as const },
  async ({ event, step }) => {
    const { booking_id, property_id, org_id, source } = event.data

    await step.run('post-booking-revenue', async () => {
      const supabase = createServiceClient()

      const txnSource = source === 'uplisting' ? 'uplisting_booking' : 'booking_revenue'

      const { data: existing } = await supabase
        .from('owner_transactions')
        .select('id')
        .eq('source_reference_id', booking_id)
        .eq('source', txnSource)
        .maybeSingle()

      if (existing) return { skipped: true }

      const [{ data: booking }, { data: property }] = await Promise.all([
        supabase
          .from('bookings')
          .select('checkin_date, checkout_date, guest_name')
          .eq('id', booking_id)
          .single(),
        supabase
          .from('properties')
          .select('avg_nightly_rate')
          .eq('id', property_id)
          .single(),
      ])

      if (!booking || !property?.avg_nightly_rate) return { skipped: true }

      const checkin  = new Date(booking.checkin_date  + 'T00:00:00')
      const checkout = new Date(booking.checkout_date + 'T00:00:00')
      const nights   = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
      if (nights <= 0) return { skipped: true }

      const amount      = parseFloat((nights * property.avg_nightly_rate).toFixed(2))
      const guestLabel  = booking.guest_name ? ` — ${booking.guest_name}` : ''

      await supabase.from('owner_transactions').insert({
        property_id,
        org_id,
        source:               txnSource,
        source_reference_id:  booking_id,
        transaction_type:     'revenue',
        category:             'booking_revenue',
        amount,
        description:          `${nights} night${nights !== 1 ? 's' : ''}${guestLabel}`,
        transaction_date:     booking.checkin_date,
        visible_to_owner:     true,
      })

      return { posted: amount }
    })

    return { booking_id }
  }
)

/**
 * Triggered when a new booking is detected from iCal sync.
 *
 * Steps:
 *  1. Send booking confirmation email (if template + guest email exist)
 *  2. Sleep until N days before checkout
 *  3. Send pre-checkout reminder email
 */
export const handleBookingDetected = inngest.createFunction(
  {
    id:      'booking-detected',
    name:    'Handle New Booking',
    retries: 3,
  },
  { event: 'booking/detected' as const },
  async ({ event, step, logger }) => {
    const { booking_id, property_id, org_id } = event.data

    // ── Fetch everything we need ─────────────────────────────────────────────

    const { booking, property, pmEmail, bookingTemplate, checkoutTemplate } =
      await step.run('fetch-data', async () => {
        const supabase = createServiceClient()

        const [
          { data: booking },
          { data: property },
          { data: templates },
          pmEmail,
        ] = await Promise.all([
          supabase
            .from('bookings')
            .select('id, guest_name, guest_email, checkin_date, checkout_date, checkin_time, checkout_time')
            .eq('id', booking_id)
            .single(),
          supabase
            .from('properties')
            .select('name, address, city, state, wifi_name, wifi_password, door_code, checkin_time, checkout_time')
            .eq('id', property_id)
            .single(),
          supabase
            .from('guest_message_templates')
            .select('*')
            .eq('property_id', property_id)
            .eq('is_active', true),
          getPmEmail(supabase, org_id),
        ])

        return {
          booking,
          property,
          pmEmail,
          bookingTemplate:  templates?.find((t) => t.trigger === 'booking_confirmed') ?? null,
          checkoutTemplate: templates?.find((t) => t.trigger === 'pre_checkout') ?? null,
        }
      })

    if (!booking || !property) {
      logger.warn(`Booking ${booking_id} or property ${property_id} not found`)
      return
    }

    // ── Auto-create booking revenue transaction ──────────────────────────────

    await step.run('create-booking-revenue-transaction', async () => {
      const supabase = createServiceClient()

      const { data: prop } = await supabase
        .from('properties')
        .select('avg_nightly_rate')
        .eq('id', property_id)
        .single()

      if (!prop?.avg_nightly_rate) return

      const { count } = await supabase
        .from('owner_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('booking_id', booking_id)

      if ((count ?? 0) > 0) return

      const checkin  = new Date(booking.checkin_date + 'T00:00:00')
      const checkout = new Date(booking.checkout_date + 'T00:00:00')
      const nights   = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
      if (nights <= 0) return

      const amount      = parseFloat((nights * prop.avg_nightly_rate).toFixed(2))
      const guestLabel  = booking.guest_name ? ` — ${booking.guest_name}` : ''
      const description = `${nights} night${nights !== 1 ? 's' : ''}${guestLabel}`

      await supabase.from('owner_transactions').insert({
        property_id,
        org_id,
        booking_id,
        transaction_type: 'revenue',
        category:         'booking_revenue',
        amount,
        description,
        transaction_date: booking.checkin_date,
        notes:            `iCal · ${booking.checkin_date} to ${booking.checkout_date}`,
      })
    })

    // Build template variables
    const variables: Record<string, string> = {
      guest_name:       booking.guest_name ?? 'Guest',
      property_name:    property.name,
      property_address: [property.address, property.city, property.state].filter(Boolean).join(', '),
      checkin_date:     new Date(booking.checkin_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      checkout_date:    new Date(booking.checkout_date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      checkin_time:     booking.checkin_time  ?? property.checkin_time  ?? '3:00 PM',
      checkout_time:    booking.checkout_time ?? property.checkout_time ?? '11:00 AM',
      wifi_name:        property.wifi_name     ?? '',
      wifi_password:    property.wifi_password ?? '',
      door_code:        property.door_code     ?? '',
      host_name:        '',  // populated from PM profile if needed
      host_phone:       '',
    }

    // ── Send booking confirmation ────────────────────────────────────────────

    if (bookingTemplate && booking.guest_email) {
      await step.run('send-booking-confirmation', async () => {
        const subject = renderTemplate(bookingTemplate.subject, variables)
        const html    = renderTemplate(bookingTemplate.body, variables)
          .split('\n').join('<br/>')

        const { data, error } = await resend.emails.send({
          from:    FROM,
          to:      booking.guest_email!,
          subject,
          html:    `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">${html}</div>`,
        })

        if (error) throw new Error(`Resend error: ${error.message}`)

        // Log the sent message
        const supabase = createServiceClient()
        await supabase.from('guest_messages_sent').insert({
          property_id:      property_id,
          org_id:           org_id,
          booking_id:       booking_id,
          template_id:      bookingTemplate.id,
          trigger:          'booking_confirmed',
          recipient_name:   booking.guest_name,
          recipient_email:  booking.guest_email!,
          subject,
          body_rendered:    html,
          resend_message_id: data?.id ?? null,
          status:           'sent',
        })
      })
    }

    // ── Schedule and send pre-checkout reminder ──────────────────────────────

    if (checkoutTemplate && booking.guest_email) {
      // Calculate send time: N days before checkout at 9am
      const checkoutDate = new Date(booking.checkout_date)
      const sendAt       = new Date(checkoutDate)
      sendAt.setDate(sendAt.getDate() - (checkoutTemplate.days_before ?? 1))
      sendAt.setUTCHours(14, 0, 0, 0)  // 9am CT (UTC-5)

      // sleepUntil handles past dates gracefully — immediately continues
      await step.sleepUntil('wait-for-checkout-window', sendAt)

      // Verify booking is still confirmed before sending
      const stillConfirmed = await step.run('check-booking-status', async () => {
        const supabase = createServiceClient()
        const { data } = await supabase
          .from('bookings')
          .select('status')
          .eq('id', booking_id)
          .single()
        return data?.status === 'confirmed'
      })

      if (stillConfirmed) {
        await step.run('send-checkout-reminder', async () => {
          const subject = renderTemplate(checkoutTemplate.subject, variables)
          const html    = renderTemplate(checkoutTemplate.body, variables)
            .split('\n').join('<br/>')

          const { data, error } = await resend.emails.send({
            from:    FROM,
            to:      booking.guest_email!,
            subject,
            html:    `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">${html}</div>`,
          })

          if (error) throw new Error(`Resend error: ${error.message}`)

          const supabase = createServiceClient()
          await supabase.from('guest_messages_sent').insert({
            property_id:      property_id,
            org_id:           org_id,
            booking_id:       booking_id,
            template_id:      checkoutTemplate.id,
            trigger:          'pre_checkout',
            recipient_name:   booking.guest_name,
            recipient_email:  booking.guest_email!,
            subject,
            body_rendered:    html,
            resend_message_id: data?.id ?? null,
            status:           'sent',
          })
        })
      }
    }

    return { booking_id, emailsSent: true }
  }
)
