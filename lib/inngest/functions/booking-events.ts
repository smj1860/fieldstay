import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { parseLocalDate } from '@/lib/utils/date-validation'

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

      let checkin: Date, checkout: Date
      try {
        checkin  = parseLocalDate(booking.checkin_date,  'checkin_date')
        checkout = parseLocalDate(booking.checkout_date, 'checkout_date')
      } catch (err) {
        console.error('[booking-confirmed] invalid date on booking', {
          booking_id,
          checkin_date:  booking.checkin_date,
          checkout_date: booking.checkout_date,
          error: String(err),
        })
        return { skipped: true, reason: 'invalid_date' }
      }

      const nights = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
      if (nights <= 0) return { skipped: true, reason: 'non_positive_nights' }

      const amount     = parseFloat((nights * property.avg_nightly_rate).toFixed(2))
      const guestLabel = booking.guest_name ? ` — ${booking.guest_name}` : ''

      const { error: insertError } = await supabase.from('owner_transactions').insert({
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

      if (insertError) {
        throw new Error(
          `owner_transactions insert failed: ${insertError.message} [${insertError.code}]`
        )
      }

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
    // Step 1: Revenue posting — NON-FATAL.
    // A failure here must NEVER block turnover generation.
    // These are independent operations. Wrap entirely in try/catch.
    await step.run('create-booking-revenue-transaction', async () => {
      const supabase = createServiceClient()
      try {
        const { data: prop } = await supabase
          .from('properties')
          .select('avg_nightly_rate')
          .eq('id', property_id)
          .single()
        if (!prop?.avg_nightly_rate) return { skipped: 'no_rate' }
        const { count } = await supabase
          .from('owner_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('source_reference_id', booking_id)
          .eq('source', 'booking_revenue')
        if ((count ?? 0) > 0) return { skipped: 'already_posted' }
        const { data: booking } = await supabase
          .from('bookings')
          .select('checkin_date, checkout_date, guest_name')
          .eq('id', booking_id)
          .single()
        if (!booking) return { skipped: 'booking_not_found' }

        let checkin: Date, checkout: Date
        try {
          checkin  = parseLocalDate(booking.checkin_date,  'checkin_date')
          checkout = parseLocalDate(booking.checkout_date, 'checkout_date')
        } catch (err) {
          logger.error('[booking-detected] invalid date on booking (non-fatal)', {
            booking_id,
            checkin_date:  booking.checkin_date,
            checkout_date: booking.checkout_date,
            error: String(err),
          })
          return { skipped: 'invalid_date' }
        }

        const nights = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
        if (nights <= 0) return { skipped: 'zero_nights' }
        const amount     = parseFloat((nights * prop.avg_nightly_rate).toFixed(2))
        const guestLabel = booking.guest_name ? ` — ${booking.guest_name}` : ''
        const { error } = await supabase.from('owner_transactions').insert({
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
          notes:               `Manual · ${booking.checkin_date} to ${booking.checkout_date}`,
        })
        // Log but DO NOT throw — let step 2 run regardless
        if (error) {
          logger.error('[booking-detected] revenue insert failed (non-fatal)', {
            error: error.message, code: error.code, booking_id,
          })
          return { error: error.message }
        }
        return { posted: amount }
      } catch (err) {
        // Catch-all safety net — log and continue to step 2
        logger.error('[booking-detected] revenue step threw (non-fatal)', {
          error: String(err), booking_id,
        })
        return { error: String(err) }
      }
    })
    // Step 2: Turnover generation — CRITICAL. Always runs.
    const newTurnoverIds = await step.run('generate-turnovers', async () => {
      const supabase = createServiceClient()
      try {
        const ids = await generateTurnoversForProperty(property_id, org_id, supabase)
        logger.info(`[booking-detected] generated ${ids.length} turnover(s)`, { property_id })
        return ids
      } catch (err) {
        logger.error('[booking-detected] generate-turnovers threw', {
          error: String(err), property_id,
        })
        throw err  // re-throw so Inngest retries this step
      }
    })
    return { booking_id, newTurnoverIds }
  }
)
