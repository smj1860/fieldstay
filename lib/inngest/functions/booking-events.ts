import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchTurnoverCreatedEvents } from '@/lib/inngest/turnover-created-events'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { parseLocalDate } from '@/lib/utils/date-validation'
import { reportError } from '@/lib/observability/report-error'
import { throwIfAnyQueryFailed, isRealQueryError } from '@/lib/supabase/unwrap'

// A real per-booking total from the PMS beats the avg_nightly_rate estimate —
// only a positive, present value counts as "real"; 0 or a missing figure
// falls through to the estimate.
function hasPositiveAmount(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && value > 0
}

// ── Booking Confirmed (Hospitable / OwnerRez) ────────────────────────────────

export const handleBookingConfirmed = inngest.createFunction(
  {
    id: 'booking-confirmed', name: 'Booking Confirmed — Post Revenue', retries: 3,
    // The heaviest burst on the platform: ownerrez/hospitable initial-sync
    // dispatches one of these per imported booking, so connecting a single new
    // PMS account can emit thousands in one go. Each posts revenue to
    // owner_transactions.
    concurrency: { limit: 10 },
  },
  { event: 'booking/confirmed' as const },
  async ({ event, step }) => {
    const { booking_id, property_id, org_id, source, actual_total_amount } = event.data

    await step.run('post-booking-revenue', async () => {
      const supabase  = createServiceClient({ system: 'inngest:booking-events' })
      const txnSource = source === 'uplisting' ? 'uplisting_booking' : 'booking_revenue'

      const [
        { data: booking, error: bookingError },
        { data: property, error: propertyError },
      ] = await Promise.all([
        supabase.from('bookings').select('checkin_date, checkout_date, guest_name').eq('id', booking_id).eq('org_id', org_id).single(),
        supabase.from('properties').select('avg_nightly_rate').eq('id', property_id).eq('org_id', org_id).single(),
      ])
      // PGRST116 ("no rows") is a legitimate, already-handled case for both —
      // booking triggers the skip below, property falls back to the estimate.
      // Only a REAL query failure should retry the step.
      throwIfAnyQueryFailed(
        { site: 'inngest.booking-confirmed.post-booking-revenue', orgId: org_id },
        isRealQueryError(bookingError) ? bookingError : null,
        isRealQueryError(propertyError) ? propertyError : null,
      )

      if (!booking) return { skipped: true }

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
        reportError(err, {
          site:  'inngest.booking-confirmed.invalid_date',
          orgId: org_id,
          extra: { booking_id },
        })
        return { skipped: true, reason: 'invalid_date' }
      }

      const nights = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
      if (nights <= 0) return { skipped: true, reason: 'non_positive_nights' }

      // Prefer the PMS's own reported total (Hospitable via financials.host.revenue,
      // OwnerRez via charges[].owner_amount/total_amount) over the
      // avg_nightly_rate estimate — a real per-booking figure beats a
      // guess whenever we have one.
      let amount: number
      if (hasPositiveAmount(actual_total_amount)) {
        amount = actual_total_amount
      } else if (property?.avg_nightly_rate) {
        amount = Number.parseFloat((nights * property.avg_nightly_rate).toFixed(2))
      } else {
        return { skipped: true, reason: 'no_rate' }
      }

      const guestLabel     = booking.guest_name ? ` — ${booking.guest_name}` : ''
      const hasActualAmount = hasPositiveAmount(actual_total_amount)

      // A later post carrying a real actual_total_amount (e.g. Hospitable's
      // financials_changed webhook firing after the initial reservation sync)
      // must be allowed to correct an earlier avg_nightly_rate estimate —
      // ignoreDuplicates: true would silently discard that correction and
      // lock the estimate in forever. A re-post without a real total (just
      // another estimate) still no-ops so it can't clobber an
      // already-posted actual figure with a stale guess.

      const { error } = await supabase.from('owner_transactions').upsert(
        {
          property_id,
          org_id,
          // Set, matching handleBookingDetected's upsert one function below —
          // its absence here was drift, not design. It left 12 of production's
          // 29 booking-revenue rows with a null FK to the booking they came
          // from, which the owners table read as "manually entered" and
          // offered a Delete button for. (That guard is now source-based, so
          // this is referential integrity rather than the fix.)
          booking_id,
          source:               txnSource,
          source_reference_id:  booking_id,
          transaction_type:     'revenue',
          category:             'booking_revenue',
          amount,
          description:          `${nights} night${nights !== 1 ? 's' : ''}${guestLabel}`,
          transaction_date:     booking.checkin_date,
          visible_to_owner:     true,
        },
        { onConflict: 'source_reference_id,source', ignoreDuplicates: !hasActualAmount }
      )

      if (error) throw error
      return { posted: amount }
    })

    return { booking_id }
  }
)

export const handleBookingDetected = inngest.createFunction(
  {
    id: 'booking-detected', name: 'Handle New Booking', retries: 3,
    // Serialized per property. ical-sync fires one booking/detected per new
    // booking, so a sync ingesting N bookings for one property used to run N
    // copies of generateTurnoversForProperty concurrently against the same
    // rows. The generator's dedup is an in-memory context loaded once per run,
    // so a loser of the Pass 1 insert race could still reach Pass 2 believing
    // no standalone existed and insert a pair alongside it — two turnovers for
    // one checkout, and two cleaning-fee rows on the owner's P&L.
    // generator.ts now keeps its context truthful on 23505 as well, but this
    // key is what removes the race rather than narrowing it.
    concurrency: { limit: 1, key: 'event.data.property_id' },
  },
  { event: 'booking/detected' as const },
  async ({ event, step, logger }) => {
    const { booking_id, property_id, org_id } = event.data
    // Step 1: Revenue posting — NON-FATAL.
    // A failure here must NEVER block turnover generation.
    // These are independent operations. Wrap entirely in try/catch.
    await step.run('create-booking-revenue-transaction', async () => {
      const supabase = createServiceClient({ system: 'inngest:booking-events' })
      try {
        const { data: prop, error: propError } = await supabase
          .from('properties')
          .select('avg_nightly_rate')
          .eq('id', property_id)
          .eq('org_id', org_id)
          .single()
        if (isRealQueryError(propError)) {
          throwIfAnyQueryFailed(
            { site: 'inngest.booking-detected.create-booking-revenue-transaction', orgId: org_id },
            propError
          )
        }
        if (!prop?.avg_nightly_rate) return { skipped: 'no_rate' }
        const { data: booking, error: bookingError } = await supabase
          .from('bookings')
          .select('checkin_date, checkout_date, guest_name')
          .eq('id', booking_id)
          .eq('org_id', org_id)
          .single()
        if (isRealQueryError(bookingError)) {
          throwIfAnyQueryFailed(
            { site: 'inngest.booking-detected.create-booking-revenue-transaction', orgId: org_id },
            bookingError
          )
        }
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
          reportError(err, { site: 'inngest.booking-confirmed.create-booking-revenue-transaction' })
          return { skipped: 'invalid_date' }
        }

        const nights = Math.round((checkout.getTime() - checkin.getTime()) / 86_400_000)
        if (nights <= 0) return { skipped: 'zero_nights' }
        const amount     = Number.parseFloat((nights * prop.avg_nightly_rate).toFixed(2))
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
        reportError(err, { site: 'inngest.booking-confirmed.create-booking-revenue-transaction' })
        return { error: String(err) }
      }
    })
    // Step 2: Turnover generation — CRITICAL. Always runs.
    const newTurnoverIds = await step.run('generate-turnovers', async () => {
      const supabase = createServiceClient({ system: 'inngest:booking-events' })
      try {
        const ids = await generateTurnoversForProperty(property_id, org_id, supabase)
        logger.info(`[booking-detected] generated ${ids.length} turnover(s)`, { property_id })
        return ids
      } catch (err) {
        logger.error('[booking-detected] generate-turnovers threw', {
          error: String(err), property_id,
        })
        reportError(err, { site: 'inngest.booking-confirmed.generate-turnovers' })
        throw err  // re-throw so Inngest retries this step
      }
    })

    // Step 3: Fire turnover/created for each new turnover.
    // Also fired from lib/inngest/functions/ownerrez/initial-sync.ts and
    // incremental-sync.ts, which generate turnovers directly from synced
    // OwnerRez bookings via the same generateTurnoversForProperty call.
    if (newTurnoverIds.length > 0) {
      const turnoverEvents = await step.run('fetch-new-turnover-data', async () => {
        const supabase = createServiceClient({ system: 'inngest:booking-events' })
        return fetchTurnoverCreatedEvents(supabase, newTurnoverIds, org_id)
      })

      if (turnoverEvents.length > 0) {
        await step.sendEvent('fire-turnover-created-events', turnoverEvents)
      }
    }

    return { booking_id, newTurnoverIds }
  }
)
