import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrap }              from '@/lib/supabase/unwrap'

const FALLBACK_TIMEZONE = 'America/New_York'

/** Nullability matches the live schema: extension_gap_threshold_days and
 *  extension_message_days_before are NOT NULL (both have defaults); the
 *  discount / contact-method / URL columns are nullable. */
interface ExtensionConfigRow {
  org_id:                        string
  is_active:                     boolean
  extension_messaging_enabled:   boolean
  extension_gap_threshold_days:  number
  extension_discount_pct:        number | null
  extension_contact_method:      string | null
  extension_ownerrez_url:        string | null
  extension_message_days_before: number
}

/**
 * DISPATCHER ONLY.
 *
 * This used to run `for (const config of configs) { await step.run(...) }` over
 * every org on the platform with gap-night messaging enabled, inside one
 * invocation. Each of those steps did a bookings scan plus up to four queries
 * and an inngest.send PER BOOKING, so the step's own duration — and the run's
 * total step count — scaled with the whole platform, and one org's failure
 * burned the retries for everyone behind it in the loop.
 *
 * Now: one `org/guidebook_stay_extension.requested` per org, handled by
 * guidebookStayExtensionOrg under its own concurrency cap.
 */
export const guidebookStayExtensionCron = inngest.createFunction(
  { id: 'guidebook-stay-extension-cron', name: 'Guidebook: Stay Extension Dispatcher' },
  { cron: '0 15 * * *' }, // ~11am ET daily
  async ({ step, logger }) => {
    const todayDate = new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE })
      .format(new Date())

    // Fetch orgs with extension messaging enabled
    const configs = await step.run('fetch-extension-configs', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-cron' })
      // Paginated: one row per ORG that opted into gap-night messaging, so
      // the result set is a slice of the platform's tenant count rather than
      // one tenant's data. The per-org gap search below only runs for orgs in
      // this list, so a max_rows truncation silently switches the feature off
      // for every org sorted past row 1000 — the revenue-generating extension
      // offer is simply never sent and the cron still reports success.
      return await fetchAllRows<ExtensionConfigRow>(
        (from, to) => supabase
          .from('guidebook_configurations')
          .select(`
            org_id, is_active,
            extension_messaging_enabled, extension_gap_threshold_days,
            extension_discount_pct, extension_contact_method,
            extension_ownerrez_url, extension_message_days_before
          `)
          .eq('is_active', true)
          .eq('extension_messaging_enabled', true)
          .order('org_id')
          .range(from, to),
        { label: 'guidebook-stay-extension-cron.configs' },
      )
    })

    logger.info(`Dispatching ${configs.length} org(s) for stay extension checks`)

    if (configs.length) {
      await step.sendEvent(
        'fan-out-stay-extension-checks',
        configs.map((config) => ({
          name: 'org/guidebook_stay_extension.requested' as const,
          data: { org_id: config.org_id },
        }))
      )
    }

    return { dispatched: configs.length, date: todayDate }
  }
)

/**
 * Per-org stay-extension check. One invocation = one tenant.
 *
 * The config is re-read here rather than carried on the event: it is one row
 * keyed by org_id, and a stale copy would mean this run offers a discount, a
 * contact method or a gap threshold the PM has since changed.
 */
export const guidebookStayExtensionOrg = inngest.createFunction(
  {
    id:          'guidebook-stay-extension-org',
    name:        'Guidebook: Stay Extension — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/guidebook_stay_extension.requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id

    const config = await step.run('load-extension-config', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-cron' })
      const res = await supabase
        .from('guidebook_configurations')
        .select(`
          org_id, is_active,
          extension_messaging_enabled, extension_gap_threshold_days,
          extension_discount_pct, extension_contact_method,
          extension_ownerrez_url, extension_message_days_before
        `)
        .eq('org_id', orgId)
        .maybeSingle()

      // Re-checked rather than assumed: the dispatcher's snapshot can be
      // minutes old, and a PM who switched the feature off in between must not
      // get an offer sent anyway.
      return unwrap(res, { site: 'inngest.guidebook-stay-extension-org.config', orgId })
    }) as ExtensionConfigRow | null

    if (!config?.is_active || !config.extension_messaging_enabled) {
      logger.info(`Org ${orgId}: stay-extension messaging no longer enabled — skipping`)
      return { org_id: orgId, dispatched: 0, skipped: true }
    }

    const dispatched = await step.run('check-gaps', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-stay-extension-cron' })
      // Find bookings checking out in `extension_message_days_before` days
      const targetCheckout = new Date(
        Date.now() + config.extension_message_days_before * 24 * 60 * 60 * 1000
      ).toISOString().split('T')[0]

      // Paginated AND error-bound, for two separate reasons.
      //
      // The error: discarding it made a failed read indistinguishable from
      // "this org has no checkouts that day" — `bookings` came back null,
      // `?? []` turned it into zero iterations, and the cron returned a
      // successful `dispatched: 0`.
      //
      // The bound: one org's checkouts on one exact date is ~properties-per-
      // org (10-50 for the target user), so this cannot realistically reach
      // PostgREST's 1000-row cap. "Realistically" is doing the work in that
      // sentence, and it is exactly the reasoning that left eight
      // platform-wide crons silently truncated until the 2026-07-30 audit.
      // fetchAllRows costs one extra round trip only once the set actually
      // exceeds a page — i.e. never, on current assumptions — and removes
      // the assumption instead of restating it.
      const bookings = await fetchAllRows<{
        id: string; org_id: string; property_id: string; checkout_date: string
      }>(
        (from, to) => supabase
          .from('bookings')
          .select('id, org_id, property_id, checkout_date')
          .eq('org_id', config.org_id)
          .eq('checkout_date', targetCheckout)
          .eq('status', 'confirmed')
          .eq('is_block', false)
          .order('id')
          .range(from, to),
        { label: 'guidebook-stay-extension-cron.bookings' },
      )

      let sent = 0

      for (const booking of bookings) {
        // Check if extension request already sent (idempotency via UNIQUE(booking_id))
        const existingRes = await supabase
          .from('stay_extension_requests')
          .select('id')
          .eq('booking_id', booking.id)
          .eq('org_id', config.org_id)
          .maybeSingle()

        // A failed read here returns null too, which read as "not yet
        // handled" — the opposite of safe. It would fall through to the
        // insert and rely on UNIQUE(booking_id) to catch the duplicate,
        // whose own error was then also discarded.
        const existing = unwrap(existingRes, {
          site:  'inngest.guidebook-stay-extension-cron.existing-request',
          orgId: config.org_id,
        })

        if (existing) continue  // already handled

        // Find the NEXT booking at this property after checkout
        const nextBookingRes = await supabase
          .from('bookings')
          .select('id, checkin_date')
          .eq('property_id', booking.property_id)
          .eq('org_id', config.org_id)
          .gt('checkin_date', booking.checkout_date)
          .eq('status', 'confirmed')
          .order('checkin_date', { ascending: true })
          .limit(1)
          .maybeSingle()

        // Same shape again: a failed read looked identical to "no future
        // booking", which `continue`s — silently declining to offer the
        // extension rather than retrying.
        const nextBooking = unwrap(nextBookingRes, {
          site:  'inngest.guidebook-stay-extension-cron.next-booking',
          orgId: config.org_id,
        })

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
        const optinRes = await supabase
          .from('guidebook_guest_sms_optins')
          .select('phone_e164, is_active')
          .eq('booking_id', booking.id)
          .maybeSingle()

        // A dropped error here degrades silently rather than failing: the
        // request is still created and the PM still notified, but
        // guestPhoneE164 goes out null, so the guest half of the gap-night
        // offer is never sent and nothing says why.
        const optin = unwrap(optinRes, {
          site:  'inngest.guidebook-stay-extension-cron.optin',
          orgId: config.org_id,
        })

        // Create the extension request record
        const requestRes = await supabase
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

        // 23505 is the ONE benign outcome: another run won the race against
        // UNIQUE(booking_id) between the existence check above and here, so
        // that run owns the notification. Every other error — an FK
        // violation, a constraint failure, an outage — used to take the same
        // silent `continue`, dropping the offer and still reporting success.
        if (requestRes.error?.code === '23505') continue

        const request = unwrap(requestRes, {
          site:  'inngest.guidebook-stay-extension-cron.insert-request',
          orgId: config.org_id,
        })

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

    return { org_id: orgId, dispatched }
  }
)
