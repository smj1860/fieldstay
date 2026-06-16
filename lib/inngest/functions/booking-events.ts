import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'

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

export const handleBookingDetected = inngest.createFunction(
  { id: 'booking-detected', name: 'Handle New Booking', retries: 3 },
  { event: 'booking/detected' as const },
  async ({ event, step, logger }) => {
    const { booking_id, property_id, org_id } = event.data

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
        .eq('source_reference_id', booking_id)
        .eq('source', 'booking_revenue')

      if ((count ?? 0) > 0) return

      const { data: booking } = await supabase
        .from('bookings')
        .select('checkin_date, checkout_date, guest_name')
        .eq('id', booking_id)
        .single()

      if (!booking) return

      const checkin  = new Date(booking.checkin_date + 'T00:00:00')
      const checkout = new Date(booking.checkout_date + 'T00:00:00')
      const nights   = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
      if (nights <= 0) return

      const amount     = parseFloat((nights * prop.avg_nightly_rate).toFixed(2))
      const guestLabel = booking.guest_name ? ` — ${booking.guest_name}` : ''

      await supabase.from('owner_transactions').insert({
        property_id,
        org_id,
        booking_id,
        source:              'booking_revenue',
        source_reference_id: booking_id,
        transaction_type:    'revenue',
        category:            'booking_revenue',
        amount,
        description:         `${nights} night${nights !== 1 ? 's' : ''}${guestLabel}`,
        transaction_date:    booking.checkin_date,
        notes:               `iCal · ${booking.checkin_date} to ${booking.checkout_date}`,
      })
    })

    logger.info(`Booking revenue posted for ${booking_id}`)

    const newTurnoverIds = await step.run('generate-turnovers', async () => {
      const supabase = createServiceClient()
      return generateTurnoversForProperty(property_id, org_id, supabase)
    })

    return { booking_id, newTurnoverIds }
  }
)
