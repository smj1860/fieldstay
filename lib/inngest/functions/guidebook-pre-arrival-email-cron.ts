import { inngest } from '@/lib/inngest/client'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { sendGuestPreArrivalEmail } from '@/lib/resend/client'

// Known tech debt: properties.timezone does not exist in the live schema.
// "Tomorrow" is computed in America/New_York as a fixed approximation until
// a timezone cache column is reintroduced.
const FALLBACK_TIMEZONE = 'America/New_York'

/**
 * Hard ceiling on how many bookings one org's handler will process in a run.
 *
 * Each booking costs its own `step.run`, and Inngest caps a single run at
 * 1000 steps. An org this size is not a realistic tenant (one org with 400
 * check-ins on a single day), so this is a backstop against a data bug rather
 * than an expected path — but it fails LOUD via the logger rather than
 * truncating quietly, because a dropped pre-arrival email is never retried:
 * the send is gated on `guidebook_pre_arrival_email_sent_at IS NULL` for a
 * single date, and tomorrow's run looks at the day after.
 */
const MAX_BOOKINGS_PER_ORG_RUN = 400

/** Nullability matches the live schema: guest_email, guest_name and
 *  guidebook_token are nullable columns (the query filters the first and
 *  third to NOT NULL, but the row type stays honest about the schema). */
interface PreArrivalBookingRow {
  id:              string
  org_id:          string
  property_id:     string
  guest_email:     string | null
  guest_name:      string | null
  checkin_date:    string
  guidebook_token: string | null
  status:          string
}

/**
 * SCHEDULED: 10am America/New_York (fixed approximation, see FALLBACK_TIMEZONE).
 *
 * Fan-out shape (same pattern as cron/daily-wrapup.ts): this cron only decides
 * WHICH orgs have a pre-arrival send to do, and dispatches one
 * `org/guidebook_pre_arrival.requested` event each. The per-booking sends live
 * in guidebookPreArrivalEmailOrg below, under its own concurrency cap.
 *
 * The previous shape ran one `step.run` per booking across ALL tenants inside
 * this single invocation. Inngest caps a run at 1000 steps and Vercel caps the
 * function at 300s (vercel.json), so at roughly 1,500 check-ins/day — about 65
 * tenants at this product's stated 10–50 properties each — the run would blow
 * the step ceiling or time out, and every guest past the cut simply never got
 * their guidebook email. Nothing surfaced it: the cron reported success for
 * the bookings it did reach.
 */
export const guidebookPreArrivalEmailCron = inngest.createFunction(
  { id: 'guidebook-pre-arrival-email-cron', name: 'Guidebook: Pre-Arrival Email Cron' },
  { cron: '0 14 * * *' },
  async ({ step, logger }) => {
    // Computed in its own memoized step so a retry re-uses the SAME date.
    // This cron fires at a fixed UTC hour but derives the date in New York
    // time — re-reading the clock on a retry near a DST boundary could land on
    // a different day, sending one cohort twice and skipping another entirely.
    const tomorrow = await step.run('capture-target-date', async () =>
      new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIMEZONE })
        .format(new Date(Date.now() + 24 * 60 * 60 * 1000))
    )

    // Which ORGS have a send to do — deliberately not which bookings. Only
    // org_id comes back, so this stays a tenant enumeration rather than a
    // platform-wide booking scan whose result has to be carried onward into
    // per-row steps.
    const orgIds = await step.run('find-orgs-with-eligible-bookings', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-pre-arrival-email-cron' })

      // Paginated: every tenant's check-ins for tomorrow, not one org's.
      const rows = await fetchAllRows<{ org_id: string }>(
        (from, to) => supabase
          .from('bookings')
          .select('org_id')
          .eq('checkin_date', tomorrow)
          .eq('status', 'confirmed')
          .eq('is_block', false)
          .not('guest_email', 'is', null)
          .not('guidebook_token', 'is', null)
          .is('guidebook_pre_arrival_email_sent_at', null)
          .order('org_id')
          .range(from, to),
        { label: 'guidebook-pre-arrival.orgs-with-bookings' },
      )

      const candidateOrgIds = Array.from(new Set(rows.map((r) => r.org_id)))
      if (candidateOrgIds.length === 0) return []

      // bookings and guidebook_configurations have no direct FK, so PostgREST
      // cannot resolve an embedded join between them — hence the second query.
      //
      // Paginated: this result decides ELIGIBILITY, so a truncated org list
      // silently reclassifies real active-guidebook orgs as inactive and drops
      // all of their bookings from the send.
      const active = await fetchAllRows<{ org_id: string }>(
        (from, to) => supabase
          .from('guidebook_configurations')
          .select('org_id')
          .in('org_id', candidateOrgIds)
          .eq('is_active', true)
          .order('org_id')
          .range(from, to),
        { label: 'guidebook-pre-arrival.active-orgs' },
      )

      const activeOrgIds = new Set(active.map((c) => c.org_id))
      return candidateOrgIds.filter((id) => activeOrgIds.has(id))
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-pre-arrival-sends',
        orgIds.map((orgId) => ({
          name: 'org/guidebook_pre_arrival.requested' as const,
          data: { org_id: orgId, checkin_date: tomorrow },
        }))
      )
    }

    logger.info(`Guidebook pre-arrival: dispatched ${orgIds.length} org(s) for ${tomorrow}`)
    return { dispatched: orgIds.length, checkin_date: tomorrow }
  }
)

/**
 * Per-org handler. One invocation = one org, so the per-run step count is
 * proportional to a single tenant's check-ins rather than the whole platform's,
 * and a slow or failing tenant only retries itself.
 *
 * Concurrency is capped so the burst does not stampede Supabase or Resend —
 * the same reason cron/daily-wrapup.ts caps its per-org handler at 10.
 */
export const guidebookPreArrivalEmailOrg = inngest.createFunction(
  {
    id:          'guidebook-pre-arrival-email-org',
    name:        'Guidebook: Pre-Arrival Email — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/guidebook_pre_arrival.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, checkin_date: checkinDate } = event.data

    const bookings = await step.run('fetch-org-bookings', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-pre-arrival-email-org' })

      // Scoped to ONE org, so this is bounded by that tenant's check-ins for a
      // single date. Still paginated: an org past 1000 check-ins on one day
      // would otherwise truncate silently, and the send is never retried.
      return await fetchAllRows<PreArrivalBookingRow>(
        (from, to) => supabase
          .from('bookings')
          .select('id, org_id, property_id, guest_email, guest_name, checkin_date, guidebook_token, status')
          .eq('org_id', orgId)
          .eq('checkin_date', checkinDate)
          .eq('status', 'confirmed')
          .eq('is_block', false)
          .not('guest_email', 'is', null)
          .not('guidebook_token', 'is', null)
          .is('guidebook_pre_arrival_email_sent_at', null)
          .order('id')
          .range(from, to),
        { label: 'guidebook-pre-arrival.org-bookings' },
      )
    })

    if (bookings.length === 0) return { org_id: orgId, sent: 0 }

    // Never truncate silently: a dropped send is a guest who never receives
    // their guidebook, and nothing retries it.
    const toSend = bookings.slice(0, MAX_BOOKINGS_PER_ORG_RUN)
    if (bookings.length > toSend.length) {
      logger.error(
        `[guidebook-pre-arrival] org ${orgId} has ${bookings.length} eligible bookings for ${checkinDate}, ` +
        `above the ${MAX_BOOKINGS_PER_ORG_RUN} per-run ceiling — ${bookings.length - toSend.length} were NOT ` +
        `sent and will not be retried automatically.`
      )
    }

    const propertyMap = await step.run('fetch-org-properties', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-pre-arrival-email-org' })
      const uniquePropertyIds = [...new Set(toSend.map((b) => b.property_id))]

      const data = await fetchAllRows<{ id: string; name: string }>(
        (from, to) => supabase
          .from('properties')
          .select('id, name')
          .in('id', uniquePropertyIds)
          .eq('org_id', orgId)
          .order('id')
          .range(from, to),
        { label: 'guidebook-pre-arrival.org-properties' },
      )

      return Object.fromEntries(data.map((p) => [p.id, p.name]))
    })

    let sentCount = 0

    for (const booking of toSend) {
      const wasSent = await step.run(`send-pre-arrival-email-${booking.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:guidebook-pre-arrival-email-org' })
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
          orgId:        booking.org_id,
        })

        // Scoped to the org as well as the id — this is a service-role client,
        // so RLS is not a backstop on this write.
        await supabase
          .from('bookings')
          .update({ guidebook_pre_arrival_email_sent_at: new Date().toISOString() })
          .eq('id', booking.id)
          .eq('org_id', orgId)

        return true
      })

      if (wasSent) sentCount += 1
    }

    return { org_id: orgId, sent: sentCount, eligible: toSend.length }
  }
)
