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
      const supabase  = createServiceClient()
      const txnSource = source === 'uplisting' ? 'uplisting_booking' : 'booking_revenue'

      const [{ data: booking }, { data: property }] = await Promise.all([
        supabase.from('bookings').select('checkin_date, checkout_date, guest_name').eq('id', booking_id).single(),
        supabase.from('properties').select('avg_nightly_rate').eq('id', property_id).single(),
      ])

      if (!booking || !property?.avg_nightly_rate) return { skipped: true }

      const checkin  = new Date(booking.checkin_date  + 'T00:00:00')
      const checkout = new Date(booking.checkout_date + 'T00:00:00')
      const nights   = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
      if (nights <= 0) return { skipped: true }

      const amount     = parseFloat((nights * property.avg_nightly_rate).toFixed(2))
      const guestLabel = booking.guest_name ? ` — ${booking.guest_name}` : ''

      // Atomic upsert — ON CONFLICT (source_reference_id, source) DO NOTHING
      // Replaces check-then-insert TOCTOU pattern; duplicate concurrent workers
      // are handled at the DB layer rather than in application code.
      const { error } = await supabase.from('owner_transactions').upsert(
        {
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
        },
        { onConflict: 'source_reference_id,source', ignoreDuplicates: true }
      )

      if (error) throw error
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
        const { data: booking } = await supabase
          .from('bookings')
          .select('checkin_date, checkout_date, guest_name')
          .eq('id', booking_id)
          .single()
        if (!booking) return { skipped: 'booking_not_found' }
        const checkin  = new Date(booking.checkin_date + 'T00:00:00')
        const checkout = new Date(booking.checkout_date + 'T00:00:00')
        const nights   = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
        if (nights <= 0) return { skipped: 'zero_nights' }
        const amount     = parseFloat((nights * prop.avg_nightly_rate).toFixed(2))
        const guestLabel = booking.guest_name ? ` — ${booking.guest_name}` : ''
        // Atomic upsert — concurrent workers handled at DB layer
        const { error } = await supabase.from('owner_transactions').upsert(
          {
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
          },
          { onConflict: 'source_reference_id,source', ignoreDuplicates: true }
        )
        // Log but DO NOT throw — let step 2 run regardless
        if (error) {
          logger.error('[booking-detected] revenue upsert failed (non-fatal)', {
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

    // Step 3: Fire turnover/created for each new turnover.
    // iCal sync no longer generates turnovers directly, so this is the only
    // place that fires these events.
    if (newTurnoverIds.length > 0) {
      const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
        const supabase = createServiceClient()
        type TurnoverRow = { id: string; checkout_datetime: string; checkin_datetime: string; window_minutes: number | null }
        const { data: turnovers } = await supabase
          .from('turnovers')
          .select('id, checkout_datetime, checkin_datetime, window_minutes')
          .in('id', newTurnoverIds)

        return (turnovers as TurnoverRow[] ?? []).map((t) => ({
          name: 'turnover/created' as const,
          data: {
            turnover_id:       t.id,
            property_id,
            org_id,
            checkout_datetime: t.checkout_datetime,
            checkin_datetime:  t.checkin_datetime,
            window_minutes:    t.window_minutes ?? 0,
          },
        }))
      })

      if (turnoverEvents.length > 0) {
        await step.sendEvent('fire-turnover-created-events', turnoverEvents)
      }
    }

    return { booking_id, newTurnoverIds }
  }
)
