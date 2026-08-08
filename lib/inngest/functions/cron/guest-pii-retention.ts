import { unwrap } from '@/lib/supabase/unwrap'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'
import { fetchAllRows } from '@/lib/inngest/paginate'

/**
 * SCHEDULED: runs daily at 9:15am CT — 15 min after dailyCommsRetention to
 * avoid Supabase contention. Mirrors comms_log_retention_days: bookings
 * guest_name/guest_email/door code and guidebook_guest_sms_optins.phone_e164
 * had no retention path before this and accumulated indefinitely.
 *
 *  • bookings — once org.guest_pii_retention_days has passed since
 *    checkout_date, clear guest_name/guest_email/raw_ical_data and delete
 *    the Vault-encrypted door code secret (if any). The booking row itself
 *    is kept (owner P&L / occupancy history has ongoing value independent
 *    of guest identity).
 *  • guidebook_guest_sms_optins — rows with opted_out_at IS NOT NULL (an
 *    explicit STOP) are never touched: phone_e164 there is the TCPA
 *    suppression record and must be retained indefinitely so that number
 *    is never re-texted. Only never-opted-out rows past the retention
 *    window are deleted (phone_e164 is NOT NULL, so these are deleted
 *    outright rather than nulled).
 *
 * DISPATCHER ONLY. This previously ran one `step.run` per org inside a single
 * invocation (150 steps at 150 tenants), each of which additionally issued one
 * serial delete_vault_secret RPC per stale booking with no bound on booking
 * count. Now it fans out one `org/guest_pii_retention.requested` per org, and
 * the handler chunks the Vault deletions.
 */
export const dailyGuestPiiRetention = inngest.createFunction(
  {
    id:      'cron-guest-pii-retention',
    name:    'Cron: Guest PII Retention Purge',
    retries: 1,
  },
  { cron: '15 14 * * *' },  // 15 min after dailyCommsRetention
  async ({ step, logger }) => {
    const nowMs = await step.run('capture-now', async () => Date.now())

    const orgIds = await step.run('find-retention-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:guest-pii-retention' })
      const orgs = await fetchAllRows<{ id: string }>(
        (from, to) => supabase
          .from('organizations')
          .select('id')
          .order('id', { ascending: true })
          .range(from, to),
        { label: 'organizations(guest-pii-retention)' }
      )
      return orgs.map((o) => o.id)
    })

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-guest-pii-retention',
        orgIds.map((orgId) => ({
          name: 'org/guest_pii_retention.requested' as const,
          data: { org_id: orgId, now_ms: nowMs },
        }))
      )
    }

    logger.info(`Guest PII retention: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  }
)

/**
 * Per-org guest PII purge.
 *
 * Bookings are processed in bounded batches with their own step per batch, so
 * an org with a large un-anonymized backlog neither blows the step-payload
 * budget nor runs an unbounded serial RPC loop inside one step. Each batch is
 * idempotent: the selection filter is `guest_pii_anonymized_at IS NULL`, which
 * the same batch's UPDATE clears, so a retry re-selects nothing already done.
 */
const BOOKING_BATCH_SIZE = 200
const MAX_BOOKING_BATCHES_PER_RUN = 25   // 5,000 bookings/org/day; the rest continue tomorrow

export const guestPiiRetentionOrg = inngest.createFunction(
  {
    id:          'guest-pii-retention-org',
    name:        'Guest PII Retention — per org',
    retries:     1,
    concurrency: { limit: 10 },
  },
  { event: 'org/guest_pii_retention.requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id
    const nowMs = event.data.now_ms

    const retentionDays = await step.run('load-org-retention-days', async () => {
      const supabase = createServiceClient({ system: 'inngest:guest-pii-retention' })
      // Skipping guest-PII retention because a read failed is not the same
      // as skipping it because the org is gone — the first must not be silent.
      const orgRes = await supabase
        .from('organizations')
        .select('guest_pii_retention_days')
        .eq('id', orgId)
        .maybeSingle()

      const data = unwrap(orgRes, { site: 'inngest.guest-pii-retention.org', orgId })
      return data?.guest_pii_retention_days ?? null
    })

    if (retentionDays === null) return { org_id: orgId, skipped: 'org_missing' }

    const cutoffIso  = new Date(nowMs - retentionDays * 86_400_000).toISOString()
    const cutoffDay  = cutoffIso.slice(0, 10)

    let bookingsAnonymized = 0

    for (let batch = 0; batch < MAX_BOOKING_BATCHES_PER_RUN; batch++) {
      const processed = await step.run(`anonymize-bookings-batch-${batch}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:guest-pii-retention' })

        const { data: staleBookings, error } = await supabase
          .from('bookings')
          .select('id, door_code_secret_id')
          .eq('org_id', orgId)
          .is('guest_pii_anonymized_at', null)
          .lt('checkout_date', cutoffDay)
          .order('id', { ascending: true })
          .limit(BOOKING_BATCH_SIZE)

        if (error) throw new Error(`Failed to select stale bookings for org ${orgId}: ${error.message}`)
        if (!staleBookings?.length) return 0

        // One Vault RPC per secret is unavoidable — each secret is a distinct
        // external resource — but the batch bound above keeps the count per
        // step fixed instead of scaling with an org's entire booking history.
        const secretIds = staleBookings
          .map((b) => b.door_code_secret_id)
          .filter((id): id is string => id !== null && id !== undefined)

        for (const secretId of secretIds) {
          const { error: vaultError } = await supabase.rpc('delete_vault_secret', { p_secret_id: secretId })
          if (vaultError) {
            // A secret that is already gone must not block the anonymization
            // of the row that references it — log and continue.
            console.warn(`[guest-pii-retention] vault secret delete failed for org ${orgId}`, {
              code: vaultError.code, message: vaultError.message,
            })
          }
        }

        const bookingIds = staleBookings.map((b) => b.id)
        const { error: updateError } = await supabase
          .from('bookings')
          .update({
            guest_name:              null,
            guest_email:             null,
            raw_ical_data:           null,
            door_code_secret_id:     null,
            guest_pii_anonymized_at: new Date().toISOString(),
          })
          .in('id', bookingIds)
          // Org-scoped as well as id-scoped. The ids come from the org-scoped
          // select above so this is correct today, but it is a service-role
          // DESTRUCTIVE write with RLS off — the id list is the only thing
          // bounding it, and an id list is exactly the kind of thing a future
          // refactor widens without noticing.
          .eq('org_id', orgId)

        if (updateError) throw new Error(`Failed to anonymize bookings for org ${orgId}: ${updateError.message}`)

        return bookingIds.length
      })

      bookingsAnonymized += processed
      if (processed < BOOKING_BATCH_SIZE) break
    }

    const optinsDeleted = await step.run('delete-stale-optins', async () => {
      const supabase = createServiceClient({ system: 'inngest:guest-pii-retention' })
      const { data, error } = await supabase
        .from('guidebook_guest_sms_optins')
        .delete()
        .eq('org_id', orgId)
        .is('opted_out_at', null)
        .lt('opted_in_at', cutoffIso)
        .select('id')

      if (error) throw new Error(`Failed to delete stale opt-ins for org ${orgId}: ${error.message}`)
      return data?.length ?? 0
    })

    if (bookingsAnonymized || optinsDeleted) {
      await step.run('log-retention-audit', async () => {
        const auditEntries = []
        if (bookingsAnonymized) {
          auditEntries.push({
            orgId,
            action:     'booking.guest_pii_anonymized' as const,
            targetType: 'booking',
            metadata:   { source: 'retention_cron', count: bookingsAnonymized },
          })
        }
        if (optinsDeleted) {
          auditEntries.push({
            orgId,
            action:     'sms.optin_phone_anonymized' as const,
            targetType: 'guidebook_guest_sms_optin',
            metadata:   { source: 'retention_cron', count: optinsDeleted },
          })
        }
        await logAuditEvents(auditEntries)
      })
    }

    logger.info(
      `Guest PII retention (org ${orgId}) — anonymized ${bookingsAnonymized} bookings, ` +
      `deleted ${optinsDeleted} stale optins`
    )

    return { org_id: orgId, bookings_anonymized: bookingsAnonymized, optins_deleted: optinsDeleted }
  }
)
