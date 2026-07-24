import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'

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
 */
export const dailyGuestPiiRetention = inngest.createFunction(
  {
    id:      'cron-guest-pii-retention',
    name:    'Cron: Guest PII Retention Purge',
    retries: 1,
  },
  { cron: '15 14 * * *' },  // 15 min after dailyCommsRetention
  async ({ step, logger }) => {
    const retentionOrgs = await step.run('find-retention-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:guest-pii-retention' })
      const { data } = await supabase
        .from('organizations')
        .select('id, guest_pii_retention_days')

      return data ?? []
    })

    let bookingsAnonymized = 0
    let optinsDeleted      = 0

    for (const org of retentionOrgs) {
      await step.run(`guest-pii-retention-${org.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:guest-pii-retention' })
        const cutoff = new Date(Date.now() - org.guest_pii_retention_days * 86_400_000)
          .toISOString()
          .slice(0, 10)

        const { data: staleBookings } = await supabase
          .from('bookings')
          .select('id, door_code_secret_id')
          .eq('org_id', org.id)
          .is('guest_pii_anonymized_at', null)
          .lt('checkout_date', cutoff)

        for (const booking of staleBookings ?? []) {
          if (booking.door_code_secret_id) {
            await supabase.rpc('delete_vault_secret', { p_secret_id: booking.door_code_secret_id })
          }
        }

        const bookingIds = (staleBookings ?? []).map((b) => b.id)
        if (bookingIds.length > 0) {
          await supabase
            .from('bookings')
            .update({
              guest_name:               null,
              guest_email:              null,
              raw_ical_data:            null,
              door_code_secret_id:      null,
              guest_pii_anonymized_at:  new Date().toISOString(),
            })
            .in('id', bookingIds)
        }

        const { data: deletedOptins } = await supabase
          .from('guidebook_guest_sms_optins')
          .delete()
          .eq('org_id', org.id)
          .is('opted_out_at', null)
          .lt('opted_in_at', new Date(Date.now() - org.guest_pii_retention_days * 86_400_000).toISOString())
          .select('id')

        bookingsAnonymized += bookingIds.length
        optinsDeleted      += deletedOptins?.length ?? 0

        const auditEntries = []
        if (bookingIds.length) {
          auditEntries.push({
            orgId:      org.id,
            action:     'booking.guest_pii_anonymized' as const,
            targetType: 'booking',
            metadata:   { source: 'retention_cron', count: bookingIds.length },
          })
        }
        if (deletedOptins?.length) {
          auditEntries.push({
            orgId:      org.id,
            action:     'sms.optin_phone_anonymized' as const,
            targetType: 'guidebook_guest_sms_optin',
            metadata:   { source: 'retention_cron', count: deletedOptins.length },
          })
        }
        if (auditEntries.length) await logAuditEvents(auditEntries)

        return { bookings_anonymized: bookingIds.length, optins_deleted: deletedOptins?.length ?? 0 }
      })
    }

    logger.info(`Guest PII retention — anonymized ${bookingsAnonymized} bookings, deleted ${optinsDeleted} stale optins`)

    return {
      bookings_anonymized: bookingsAnonymized,
      optins_deleted:      optinsDeleted,
    }
  }
)
